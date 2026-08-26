using System.Text.Json;
using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace SourceRpc;

/// <summary>A subscription held open. Disposing it tells the far end to stop sending.</summary>
public interface IRpcSubscription : IAsyncDisposable;

/// <summary>
/// A peer that calls out, over whichever transport it was given.
///
/// This is the half that makes a C# process a participant rather than only a destination, and it is
/// deliberately transport-agnostic: correlation, deadlines, error mapping and subscription
/// bookkeeping live here, so a socket.io client and an MQTT one are a class that moves frames and
/// nothing more. Writing that logic per binding is how three transports come to disagree about what
/// a timeout means.
///
/// It serves as well as calls. A frame addressed to this peer is handed to the dispatcher and the
/// reply goes back down the same link, so a client that dials into a hub can still be called - which
/// is the ordinary shape for a device that both reports and takes instructions.
/// </summary>
public sealed class SourceRpcClient : IAsyncDisposable
{
    private readonly ISourceRpcTransport _transport;
    private readonly SourceRpcOptions _options;
    private readonly RpcDispatcher? _dispatcher;
    private readonly SourceRpcTelemetry _telemetry;
    private readonly ILogger _log;

    private readonly ConcurrentDictionary<string, TaskCompletionSource<RpcFrame>> _pending = new();
    private readonly ConcurrentDictionary<string, List<Action<object?[]>>> _handlers = new();
    private readonly ConcurrentDictionary<string, IRpcTicketSink> _tickets = new();

    /// <summary>Creates a client over a transport. The transport is started by <see cref="StartAsync"/>.</summary>
    public SourceRpcClient(
        ISourceRpcTransport transport,
        SourceRpcOptions options,
        SourceRpcTelemetry telemetry,
        RpcDispatcher? dispatcher = null,
        ILogger? log = null)
    {
        _transport = transport;
        _options = options;
        _telemetry = telemetry;
        _dispatcher = dispatcher;
        _log = log ?? NullLogger.Instance;
        _transport.FrameReceived += OnFrameAsync;
    }

    /// <summary>Bring the link up. The transport keeps it up from there.</summary>
    public Task StartAsync(CancellationToken cancellationToken = default) => _transport.StartAsync(cancellationToken);

    /// <summary>
    /// Call a method on another peer and wait for its answer.
    ///
    /// The deadline travels as `ttl`, so the far end can refuse work that is already too late rather
    /// than doing it for a caller that has stopped waiting - and the local timer is armed with the
    /// same number, so what the far end is told is exactly what this caller is going to do.
    /// </summary>
    public async Task<T?> CallAsync<T>(string target, string path, string method, object?[]? args = null, CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, null, cancellationToken);
        return Convert<T>(frame.Body);
    }

    /// <summary>As <see cref="CallAsync{T}(string, string, string, object?[], CancellationToken)"/>, for a method whose answer is not wanted typed.</summary>
    public async Task<object?> CallAsync(string target, string path, string method, object?[]? args = null, CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, null, cancellationToken);
        return frame.Body;
    }

    /// <summary>
    /// As <see cref="CallAsync{T}(string, string, string, object?[], CancellationToken)"/>, saying what this caller can say about the call itself: the key
    /// that makes a second attempt the same command, the deadline it will actually wait, and the
    /// owner generation it decided under. See <see cref="RpcCallOptions"/>.
    /// </summary>
    public async Task<T?> CallAsync<T>(string target, string path, string method, object?[]? args, RpcCallOptions options, CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, options, cancellationToken);
        return Convert<T>(frame.Body);
    }

    /// <summary>As the option-carrying <see cref="CallAsync{T}(string, string, string, object?[], RpcCallOptions, CancellationToken)"/>, for an answer not wanted typed.</summary>
    public async Task<object?> CallAsync(string target, string path, string method, object?[]? args, RpcCallOptions options, CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, options, cancellationToken);
        return frame.Body;
    }

    private async Task<RpcFrame> CallFrameAsync(string target, string path, string method, object?[]? args, RpcCallOptions? options, CancellationToken cancellationToken)
    {
        var correlation = Guid.NewGuid().ToString("N");
        var timeout = options?.Timeout ?? _options.CallTimeout;
        var frame = new RpcFrame
        {
            Src = _options.Name,
            Tgt = target,
            Kind = "call",
            Corr = correlation,
            Path = path,
            Method = method,
            // The same number that arms the local timer, so what the far end is told is exactly what
            // this caller is going to do - it can then refuse work that is already too late rather
            // than doing it for nobody.
            Ttl = (long)timeout.TotalMilliseconds,
            Idem = options?.IdempotencyKey,
            Fence = options?.OwnerEpoch,
            Body = args ?? []
        };
        return await ExchangeAsync(frame, correlation, timeout, cancellationToken);
    }

    /// <summary>
    /// Call a method that answers later, and hold the ticket it answers with.
    ///
    /// The call itself returns as soon as the far end has accepted the work; the answer arrives on
    /// <see cref="RpcTicket{T}.Result"/>, and anything reported on the way on its Progress event.
    /// A method that is *not* deferred answers this with its value directly, so the ticket resolves
    /// immediately - which keeps a caller working when a method stops deferring.
    /// </summary>
    public async Task<RpcTicket<T>> CallDeferredAsync<T>(
        string target,
        string path,
        string method,
        object?[]? args = null,
        CancellationToken cancellationToken = default)
    {
        var correlation = Guid.NewGuid().ToString("N");
        var frame = new RpcFrame
        {
            Src = _options.Name,
            Tgt = target,
            Kind = "call",
            Corr = correlation,
            Path = path,
            Method = method,
            Ttl = (long)_options.CallTimeout.TotalMilliseconds,
            Body = args ?? []
        };

        // Registered before the exchange, because the far end may send its first ticket frame the
        // instant it has answered the call - and on a fast link that can beat this code to it.
        var sink = new TicketSink<T>(correlation);
        _tickets[correlation] = sink;
        try
        {
            var answer = await ExchangeAsync(frame, correlation, _options.CallTimeout, cancellationToken);
            if (answer.Deferred == true && answer.Body is not null)
            {
                var receipt = Convert<RpcTicketReceipt>(answer.Body);
                // Opening replays whatever arrived while there was no ticket to put it on, and says
                // whether that already settled the thing - in which case there is nothing left to
                // track and holding the correlation would only leak it.
                if (sink.Open(receipt?.ExpiresAt ?? 0))
                    _tickets.TryRemove(correlation, out _);
                return sink.Ticket;
            }
            // Not deferred after all: the method answered outright.
            _tickets.TryRemove(correlation, out _);
            sink.Open(0);
            sink.Settle("resolved", answer.Body);
            return sink.Ticket;
        }
        catch
        {
            _tickets.TryRemove(correlation, out _);
            throw;
        }
    }

    /// <summary>
    /// Receive an event from another peer until the returned handle is disposed.
    ///
    /// A subscribe is an ordinary request, so it is answered and this waits for that answer - which
    /// is what lets a caller know the far end has it, rather than discovering later that nothing is
    /// arriving.
    /// </summary>
    public async Task<IRpcSubscription> SubscribeAsync(
        string target,
        string path,
        string eventName,
        Action<object?[]> handler,
        CancellationToken cancellationToken = default)
    {
        var correlation = Guid.NewGuid().ToString("N");
        var frame = new RpcFrame
        {
            Src = _options.Name,
            Tgt = target,
            Kind = "subscribe",
            Corr = correlation,
            Path = path,
            Method = "on",
            Ttl = (long)_options.CallTimeout.TotalMilliseconds,
            Body = new object?[] { eventName }
        };
        await ExchangeAsync(frame, correlation, _options.CallTimeout, cancellationToken);

        var key = Key(target, path, eventName);
        _handlers.AddOrUpdate(key, _ => [handler], (_, existing) => { lock (existing) { existing.Add(handler); } return existing; });
        return new Subscription(this, target, path, eventName, handler);
    }

    private async Task<RpcFrame> ExchangeAsync(RpcFrame frame, string correlation, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (!_transport.Connected)
            // Thrown rather than queued. A call discarded in silence leaves its caller waiting out
            // the whole deadline for a frame that was never going to be sent.
            throw new SourceRpcException(RpcErrorCode.TransportError, $"not connected to send {frame.Kind} for '{frame.Tgt}'");

        var waiting = new TaskCompletionSource<RpcFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        // Registered before sending: an answer can arrive before SendAsync's task completes.
        _pending[correlation] = waiting;
        try
        {
            try
            {
                await _transport.SendAsync(frame, cancellationToken);
            }
            catch (Exception e) when (e is not SourceRpcException and not OperationCanceledException)
            {
                // It never left, so whatever it would have done, it did not. Classified here rather
                // than left as whatever the carrier threw, because a caller deciding whether to send
                // a command again needs `CertainlyDidNotRun` to be true of this - and an unclassified
                // exception is read as *unknown*, which is the safe reading and the wrong one.
                throw new SourceRpcException(RpcErrorCode.TransportError, $"{frame.Path}.{frame.Method} was refused by the link before it was sent: {e.Message}", e);
            }
            _telemetry.FrameSent(frame.Kind);

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeout);
            await using (deadline.Token.Register(() =>
                waiting.TrySetException(new SourceRpcException(RpcErrorCode.Timeout, $"{frame.Path}.{frame.Method} did not answer within {timeout}"))))
            {
                var answer = await waiting.Task;
                if (answer.Kind == "error")
                    throw new SourceRpcException(CodeOf(answer.Code), MessageOf(answer.Body));
                return answer;
            }
        }
        finally
        {
            _pending.TryRemove(correlation, out _);
        }
    }

    private async Task OnFrameAsync(RpcFrame frame)
    {
        if (frame.V != TransportContract.FrameVersion)
            return;
        _telemetry.FrameReceived(frame.Kind);

        switch (frame.Kind)
        {
            case "result" or "error" when frame.Corr is { Length: > 0 } corr:
                // Only for a call this peer actually made. A reply with no pending request has
                // nothing to attach itself to, which is what makes a forged answer harmless.
                if (_pending.TryGetValue(corr, out var waiting))
                    waiting.TrySetResult(frame);
                return;

            case "ticket" when frame.Corr is { Length: > 0 } ticketCorr:
                // A later answer for a call already answered once. Accepted only for a ticket this
                // peer is holding, which is a fact it has rather than one the frame asserts.
                if (_tickets.TryGetValue(ticketCorr, out var sink))
                {
                    if (sink.Settle(frame.Outcome, frame.Body))
                        _tickets.TryRemove(ticketCorr, out _);
                }
                else
                {
                    _log.LogDebug("SourceRpc ignored a ticket frame for {Correlation}, which is not a call this peer has out", ticketCorr);
                }
                return;

            case "event":
                Deliver(frame);
                return;

            case "call" or "subscribe" or "unsubscribe":
                // A client is a peer, so it can be called. Handed to the same dispatcher a hub uses,
                // so a method behaves identically whichever direction the link was dialled.
                if (_dispatcher is null)
                    return;
                // With a reply channel, so a method served over this link may defer. Without it the
                // dispatcher refuses to defer rather than accepting work whose answer it has no way
                // to deliver - which is the right refusal, and was the one this hit.
                var reply = await _dispatcher.HandleAsync(
                    frame,
                    new RpcCaller(frame.Src, null, CancellationToken.None, later => _transport.SendAsync(later)));
                if (reply is not null)
                {
                    await _transport.SendAsync(reply);
                    _telemetry.FrameSent(reply.Kind);
                }
                return;
        }
    }

    private void Deliver(RpcFrame frame)
    {
        var key = Key(frame.Src, frame.Path ?? "", frame.Event ?? "");
        if (!_handlers.TryGetValue(key, out var handlers))
            return;
        var args = frame.Body is null ? [] : Args(frame);
        Action<object?[]>[] snapshot;
        lock (handlers)
            snapshot = handlers.ToArray();
        foreach (var handler in snapshot)
            try
            {
                handler(args);
            }
            catch (Exception e)
            {
                // A subscriber that throws must not unwind into the transport that delivered the
                // event, or one bad handler takes the link down for everyone.
                _log.LogError(e, "SourceRpc event handler for {Path}.{Event} threw", frame.Path, frame.Event);
            }
    }

    private static object?[] Args(RpcFrame frame)
    {
        var count = frame.ArgCount;
        var args = new object?[count];
        for (var index = 0; index < count; index++)
            args[index] = frame.Arg<object>(index);
        return args;
    }

    private static string Key(string peer, string path, string eventName) => peer + "\0" + path + "\0" + eventName;

    private static RpcErrorCode CodeOf(string? code) =>
        Enum.TryParse<RpcErrorCode>(code, ignoreCase: false, out var parsed) ? parsed : RpcErrorCode.Exception;

    private static string MessageOf(object? body) =>
        body switch
        {
            null => "the call failed",
            JsonElement element when element.TryGetProperty("message", out var message) => message.GetString() ?? "the call failed",
            System.Collections.IDictionary map when map["message"] is string message => message,
            _ => body.ToString() ?? "the call failed"
        };

    private static T? Convert<T>(object? value)
    {
        if (value is null)
            return default;
        if (value is T typed)
            return typed;
        if (value is JsonElement element)
            return element.Deserialize<T>();
        try
        {
            return (T)System.Convert.ChangeType(value, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T), System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is InvalidCastException or FormatException or OverflowException)
        {
            return default;
        }
    }

    private void Drop(string target, string path, string eventName, Action<object?[]> handler)
    {
        if (!_handlers.TryGetValue(Key(target, path, eventName), out var handlers))
            return;
        lock (handlers)
            handlers.Remove(handler);
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        _transport.FrameReceived -= OnFrameAsync;
        await _transport.DisposeAsync();
    }

    /// <summary>What a ticket frame is delivered to, without the client knowing the ticket's type.</summary>
    private interface IRpcTicketSink
    {
        /// <summary>Returns true when this settles the ticket, so it can be forgotten.</summary>
        bool Settle(string? outcome, object? body);
    }

    /// <summary>
    /// Holds a ticket's answers, including the ones that arrive before there is a ticket to put
    /// them on.
    ///
    /// That window is not exotic, it is the ordinary case on a fast link: the far end may send its
    /// first ticket frame the instant it has accepted the work, and a method that turns out to have
    /// nothing to wait for sends the *outcome* before the receipt it is answering with. Both beat
    /// the caller's continuation, because completing the receipt's task queues that continuation
    /// rather than running it. Dropping those frames lost the progress, and lost `resolved` too -
    /// which is not a missing notification but a caller that waits for ever.
    /// </summary>
    private sealed class TicketSink<T>(string correlation) : IRpcTicketSink
    {
        private readonly List<(string? Outcome, object? Body)> _early = [];
        private RpcTicket<T>? _ticket;
        private bool _settled;

        public RpcTicket<T> Ticket => _ticket ?? throw new InvalidOperationException("the ticket has not been opened");

        /// <summary>Build the ticket and replay whatever already arrived. True when it is already settled.</summary>
        public bool Open(long expiresAt)
        {
            (string?, object?)[] waiting;
            lock (_early)
            {
                _ticket ??= new RpcTicket<T>(
                    correlation,
                    DateTimeOffset.FromUnixTimeMilliseconds(expiresAt == 0 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : expiresAt));
                waiting = _early.Select(one => (one.Outcome, one.Body)).ToArray();
                _early.Clear();
            }
            var settled = false;
            foreach (var (outcome, body) in waiting)
                settled |= Deliver(outcome, body);
            return settled;
        }

        public bool Settle(string? outcome, object? body)
        {
            lock (_early)
            {
                if (_ticket is null)
                {
                    // Held rather than dropped. Replayed by Open, in arrival order.
                    _early.Add((outcome, body));
                    return false;
                }
            }
            return Deliver(outcome, body);
        }

        private bool Deliver(string? outcome, object? body)
        {
            var ticket = _ticket!;
            switch (outcome)
            {
                case "progress":
                    ticket.OnProgress(body);
                    return false;
                case "rejected":
                    _settled = true;
                    ticket.Reject(new SourceRpcException(RpcErrorCode.Exception, MessageOf(body)));
                    return true;
                default:
                    _settled = true;
                    ticket.Resolve(Convert<T>(body)!);
                    return true;
            }
        }

        /// <summary>Whether the answer has already been delivered, so the client can stop tracking it.</summary>
        public bool Settled => _settled;
    }

    private sealed class Subscription(SourceRpcClient client, string target, string path, string eventName, Action<object?[]> handler) : IRpcSubscription
    {
        public async ValueTask DisposeAsync()
        {
            client.Drop(target, path, eventName, handler);
            // Told rather than merely forgotten: leaving the far end sending is a cost somebody else
            // pays. Failures are swallowed - a link already gone cannot be told anything, and a
            // dispose that throws is worse than a subscription that outlives its handler.
            try
            {
                // One correlation, used for both the frame and the wait. Two would have been a
                // subscription that could only ever time out on the way out.
                var correlation = Guid.NewGuid().ToString("N");
                await client.ExchangeAsync(
                    new RpcFrame
                    {
                        Src = client._options.Name,
                        Tgt = target,
                        Kind = "unsubscribe",
                        Corr = correlation,
                        Path = path,
                        Method = "off",
                        Body = new object?[] { eventName }
                    },
                    correlation,
                    client._options.CallTimeout,
                    CancellationToken.None);
            }
            catch (Exception e)
            {
                client._log.LogDebug(e, "SourceRpc could not tell {Target} to stop sending {Path}.{Event}", target, path, eventName);
            }
        }
    }
}
