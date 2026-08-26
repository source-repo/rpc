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

    private readonly ConcurrentDictionary<string, PendingExchange> _pending = new();
    private readonly ConcurrentDictionary<string, SubscriptionEntry> _subscriptions = new();
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
        _transport.LinkEstablished += ReplaySubscriptionsAsync;
    }

    /// <summary>Bring the link up. The transport keeps it up from there.</summary>
    /// <summary>
    /// Bring the link up and keep it up. **Returns before there is a connection.**
    ///
    /// That is deliberate - a peer may start before the thing it connects to, and blocking startup
    /// on something minutes away is worse than starting - but it means this is not readiness, and
    /// `await StartAsync(); await CallAsync(...)` fails with `TransportError` rather than waiting.
    /// Use <see cref="WaitUntilConnectedAsync"/> when the next thing needs a link.
    ///
    /// The token here is the transport's **lifetime**: cancelling it stops reconnecting for good.
    /// Pass the host's stopping token, not a startup timeout - a startup timeout belongs to
    /// <see cref="WaitUntilConnectedAsync"/>, where giving up waiting does not also give up trying.
    /// </summary>
    public Task StartAsync(CancellationToken cancellationToken = default) => _transport.StartAsync(cancellationToken);

    /// <summary>
    /// Wait until the link is up, or until the caller stops waiting.
    ///
    /// Cancelling this abandons the wait and nothing else: the transport goes on trying, so a
    /// startup timeout does not turn a slow server into a peer that never reconnects. Returns true
    /// if the link came up, false if the wait was abandoned first.
    /// </summary>
    public async Task<bool> WaitUntilConnectedAsync(CancellationToken cancellationToken = default)
    {
        if (_transport.Connected)
            return true;

        var connected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task Established()
        {
            connected.TrySetResult();
            return Task.CompletedTask;
        }

        _transport.LinkEstablished += Established;
        try
        {
            // Re-checked after subscribing, because the link may have come up in between - and a
            // wait that missed its own signal would run to the caller's timeout for no reason.
            if (_transport.Connected)
                return true;
            using var give_up = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            await using (give_up.Token.Register(() => connected.TrySetCanceled()))
            {
                await connected.Task;
                return true;
            }
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        finally
        {
            _transport.LinkEstablished -= Established;
        }
    }

    /// <summary>
    /// Call a method on another peer and wait for its answer.
    ///
    /// The deadline travels as `ttl`, so the far end can refuse work that is already too late rather
    /// than doing it for a caller that has stopped waiting - and the local timer is armed with the
    /// same number, so what the far end is told is exactly what this caller is going to do.
    /// </summary>
    public async Task<T?> CallAsync<T>(
        string target,
        string path,
        string method,
        object?[]? args = null,
        RpcCallOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, options, cancellationToken);
        return ConvertResult<T>(frame.Body, path, method);
    }

    /// <summary>As <see cref="CallAsync{T}"/>, for a method whose answer is not wanted typed.</summary>
    public async Task<object?> CallAsync(
        string target,
        string path,
        string method,
        object?[]? args = null,
        RpcCallOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var frame = await CallFrameAsync(target, path, method, args, options, cancellationToken);
        return frame.Body;
    }

    private Task<RpcFrame> CallFrameAsync(string target, string path, string method, object?[]? args, RpcCallOptions? options, CancellationToken cancellationToken)
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
            Ttl = (long)timeout.TotalMilliseconds,
            Idem = options?.IdempotencyKey,
            Fence = options?.OwnerFence,
            Ver = options?.ContractVersion,
            Body = args ?? []
        };
        return ExchangeAsync(frame, correlation, cancellationToken, timeout);
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
        RpcCallOptions? options = null,
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
            Ttl = (long)(options?.Timeout ?? _options.CallTimeout).TotalMilliseconds,
            Idem = options?.IdempotencyKey,
            Fence = options?.OwnerFence,
            Ver = options?.ContractVersion,
            Body = args ?? []
        };

        // Registered before the exchange, because the far end may send its first ticket frame the
        // instant it has answered the call - and on a fast link that can beat this code to it.
        var sink = new TicketSink<T>(correlation, target);
        _tickets[correlation] = sink;
        try
        {
            var answer = await ExchangeAsync(frame, correlation, cancellationToken, options?.Timeout);
            if (answer.Deferred == true && answer.Body is not null)
            {
                var receipt = RpcConversion.Optional<RpcTicketReceipt>(answer.Body);
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
        var key = Key(target, path, eventName);
        var entry = _subscriptions.GetOrAdd(key, _ => new SubscriptionEntry(target, path, eventName));

        // The handler goes on *before* the request goes out, and that ordering is the fix for a
        // real loss: the far end is entitled to emit the moment it has acknowledged, and an event
        // that arrives while this code is still awaiting the acknowledgement would find no handler
        // and be dropped. It is registered first and rolled back if the subscribe fails.
        bool first;
        lock (entry)
        {
            first = entry.Handlers.Count == 0;
            entry.Handlers.Add(handler);
        }

        if (first)
        {
            try
            {
                await SendSubscribeAsync(target, path, eventName, cancellationToken);
                lock (entry)
                    entry.RemoteActive = true;
            }
            catch
            {
                // Rolled back, so a failed subscribe does not leave a handler that will never be
                // fed and a key that later sends an unsubscribe for something never subscribed.
                Drop(target, path, eventName, handler);
                throw;
            }
        }

        return new Subscription(this, target, path, eventName, handler);
    }

    private Task SendSubscribeAsync(string target, string path, string eventName, CancellationToken cancellationToken)
    {
        var correlation = Guid.NewGuid().ToString("N");
        return ExchangeAsync(
            new RpcFrame
            {
                Src = _options.Name,
                Tgt = target,
                Kind = "subscribe",
                Corr = correlation,
                Path = path,
                Method = "on",
                Ttl = (long)_options.CallTimeout.TotalMilliseconds,
                Body = new object?[] { eventName }
            },
            correlation,
            cancellationToken);
    }

    /// <summary>
    /// Take every active subscription out again, because the far end has forgotten them.
    ///
    /// A peer's subscriptions live on its connection at the other end: when the link drops they are
    /// dropped with it, and a reconnect is - as far as the far end is concerned - a peer it has
    /// never met. Without this a reconnected client looks perfectly healthy and silently never
    /// receives another event, which is the failure mode hardest to notice in a running plant.
    /// </summary>
    private async Task ReplaySubscriptionsAsync()
    {
        foreach (var entry in _subscriptions.Values)
        {
            bool wanted;
            lock (entry)
                wanted = entry.Handlers.Count > 0;
            if (!wanted)
                continue;
            try
            {
                await SendSubscribeAsync(entry.Target, entry.Path, entry.Event, CancellationToken.None);
                lock (entry)
                    entry.RemoteActive = true;
            }
            catch (Exception e)
            {
                // One subscription that cannot be retaken must not stop the others being retaken.
                _log.LogError(e, "SourceRpc could not restore its subscription to {Path}.{Event} on {Target}", entry.Path, entry.Event, entry.Target);
            }
        }
    }

    private async Task<RpcFrame> ExchangeAsync(RpcFrame frame, string correlation, CancellationToken cancellationToken, TimeSpan? timeout = null)
    {
        if (!_transport.Connected)
            // Thrown rather than queued. A call discarded in silence leaves its caller waiting out
            // the whole deadline for a frame that was never going to be sent.
            throw new SourceRpcException(RpcErrorCode.TransportError, $"not connected to send {frame.Kind} for '{frame.Tgt}'");

        var waiting = new TaskCompletionSource<RpcFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        // Registered before sending: an answer can arrive before SendAsync's task completes. Kept
        // with the peer it was sent to, so an answer has to come back from there - see Accepts.
        _pending[correlation] = new PendingExchange(frame.Tgt, _options.Name, waiting);
        try
        {
            try
            {
                await _transport.SendAsync(frame, cancellationToken);
            }
            catch (Exception e) when (e is not SourceRpcException and not OperationCanceledException)
            {
                // It never left, so whatever it would have done, it did not. Classified rather than
                // left as whatever the carrier threw, because a caller deciding whether to send a
                // command again needs `CertainlyDidNotRun` to be true of this - and an unclassified
                // exception is read as *unknown*, which is the safe reading and the wrong one.
                throw new SourceRpcException(RpcErrorCode.TransportError, $"{frame.Path}.{frame.Method} was refused by the link before it was sent: {e.Message}", e);
            }
            _telemetry.FrameSent(frame.Kind);

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            // The same number the frame carried, so the local timer and what the far end was
            // told cannot disagree about when this caller stops waiting.
            var waitFor = timeout ?? _options.CallTimeout;
            deadline.CancelAfter(waitFor);
            await using (deadline.Token.Register(() =>
                waiting.TrySetException(new SourceRpcException(RpcErrorCode.Timeout, $"{frame.Path}.{frame.Method} did not answer within {waitFor}"))))
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

    private void Refuse(RpcFrame frame, PendingExchange pending)
    {
        // Reported rather than ignored: a reply arriving from the wrong peer is either an attack or
        // a routing bug, and both are things somebody needs to see. The exchange is left waiting,
        // so the real answer can still settle it.
        _log.LogWarning(
            "SourceRpc refused a {Kind} for {Correlation} from {Source} addressed to {Target}: that exchange is with {Expected}",
            frame.Kind, frame.Corr, frame.Src, frame.Tgt, pending.ExpectedSource);
        _telemetry.FrameRejected("reply from the wrong peer");
    }

    /// <summary>
    /// One call waiting for its answer, and who is entitled to give it.
    ///
    /// The pair matters as much as the correlation: <see cref="ExpectedSource"/> is the peer this
    /// call went to, and <see cref="ExpectedTarget"/> is this peer, so a frame has to be addressed
    /// back to us by the peer we asked.
    /// </summary>
    private sealed record PendingExchange(string ExpectedSource, string ExpectedTarget, TaskCompletionSource<RpcFrame> Completion)
    {
        public bool Accepts(RpcFrame frame) =>
            // A broadcast target ('*') is a call that may be answered by whoever holds the path, so
            // the source cannot be pinned - the correlation and the addressee are what is left.
            (ExpectedSource == "*" || frame.Src == ExpectedSource) && frame.Tgt == ExpectedTarget;
    }

    private async Task OnFrameAsync(RpcFrame frame)
    {
        if (frame.V != TransportContract.FrameVersion)
            return;
        _telemetry.FrameReceived(frame.Kind);

        switch (frame.Kind)
        {
            case "result" or "error" when frame.Corr is { Length: > 0 } corr:
                // Only for a call this peer actually made, *and* only from the peer it made it to.
                // A correlation is hard to guess and that is not the same as being permission to
                // answer: on a broker it travels in correlationData, where the broker and anyone
                // subscribed to the topic can read it. Without the source check, whoever sees one
                // can answer somebody else's exchange - a relay, a tap, a compromised bridge.
                if (_pending.TryGetValue(corr, out var pending))
                {
                    if (pending.Accepts(frame))
                        pending.Completion.TrySetResult(frame);
                    else
                        Refuse(frame, pending);
                }
                return;

            case "ticket" when frame.Corr is { Length: > 0 } ticketCorr:
                // A later answer for a call already answered once. Accepted only for a ticket this
                // peer is holding, which is a fact it has rather than one the frame asserts - and
                // only from the peer that issued the receipt.
                if (_tickets.TryGetValue(ticketCorr, out var sink))
                {
                    if (sink.Source != frame.Src || frame.Tgt != _options.Name)
                    {
                        _log.LogWarning(
                            "SourceRpc refused a ticket for {Correlation} from {Source}: that exchange is with {Expected}",
                            ticketCorr, frame.Src, sink.Source);
                        _telemetry.FrameRejected("ticket from the wrong peer");
                        return;
                    }
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
        if (!_subscriptions.TryGetValue(key, out var entry))
            return;
        var args = frame.Body is null ? [] : Args(frame);
        Action<object?[]>[] snapshot;
        lock (entry)
            snapshot = [.. entry.Handlers];
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

    /// <summary>
    /// A result as the type the caller asked for, or a refusal.
    ///
    /// Returning `default` here was the quiet version of the same mistake the argument side made:
    /// a result that could not be read became `0`, `false` or `null`, and a caller acted on it as
    /// though the far end had said so. `UnknownOutcome` would be wrong - the command certainly ran -
    /// so this is an ordinary failure naming the value that could not be read.
    /// </summary>
    private static T? ConvertResult<T>(object? value, string path, string method)
    {
        if (RpcConversion.TryConvert<T>(value, out var converted, out var why))
            return converted;
        throw new SourceRpcException(RpcErrorCode.InvalidParams, $"the answer from {path}.{method} could not be read as {typeof(T).Name}: {why}");
    }

    /// <summary>
    /// Forget one handler, and say whether the far end should now be told to stop sending.
    ///
    /// Only the last handler for a key ends the remote subscription. Telling the far end on *every*
    /// dispose is what made two subscriptions to one event destroy each other: dropping either one
    /// stopped the event arriving, and the surviving handler went quiet with nothing to show for it.
    /// </summary>
    private bool Drop(string target, string path, string eventName, Action<object?[]> handler)
    {
        if (!_subscriptions.TryGetValue(Key(target, path, eventName), out var entry))
            return false;
        lock (entry)
        {
            if (!entry.Handlers.Remove(handler) || entry.Handlers.Count > 0)
                return false;
            if (!entry.RemoteActive)
                return false;
            entry.RemoteActive = false;
            return true;
        }
    }

    /// <summary>One event this peer is watching, and everything listening to it here.</summary>
    private sealed class SubscriptionEntry(string target, string path, string eventName)
    {
        public string Target { get; } = target;
        public string Path { get; } = path;
        public string Event { get; } = eventName;
        public List<Action<object?[]>> Handlers { get; } = [];

        /// <summary>Whether the far end has been asked to send, so it is told to stop exactly once.</summary>
        public bool RemoteActive { get; set; }
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        _transport.FrameReceived -= OnFrameAsync;
        _transport.LinkEstablished -= ReplaySubscriptionsAsync;

        // Everything still waiting is told the link has gone, rather than left awaiting an answer
        // that can no longer arrive. `UnknownOutcome` rather than `TransportError` for both: the
        // request was sent, so whether it ran is exactly what nobody here can say - and for a
        // command that matters, "it failed" invites the retry that must not happen.
        foreach (var correlation in _pending.Keys.ToArray())
            if (_pending.TryRemove(correlation, out var pending))
                pending.Completion.TrySetException(new SourceRpcException(
                    RpcErrorCode.UnknownOutcome,
                    "the client closed before this call was answered - it may or may not have run"));

        foreach (var correlation in _tickets.Keys.ToArray())
            if (_tickets.TryRemove(correlation, out var ticket))
                ticket.Abandon();

        await _transport.DisposeAsync();
    }

    /// <summary>What a ticket frame is delivered to, without the client knowing the ticket's type.</summary>
    private interface IRpcTicketSink
    {
        /// <summary>The peer this ticket's answer must come from, for the same reason a reply's must.</summary>
        string Source { get; }

        /// <summary>Returns true when this settles the ticket, so it can be forgotten.</summary>
        bool Settle(string? outcome, object? body);

        /// <summary>The link has gone, so nothing more is coming. Ends the ticket in a state a caller can act on.</summary>
        void Abandon();
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
    private sealed class TicketSink<T>(string correlation, string source) : IRpcTicketSink
    {
        /// <inheritdoc/>
        public string Source { get; } = source;

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

        /// <inheritdoc/>
        public void Abandon()
        {
            lock (_early)
            {
                // A ticket never opened has nobody awaiting it: the caller is still inside the call
                // that would have returned it, and that call is being failed separately.
                if (_ticket is null)
                    return;
            }
            _ticket.Abandon();
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
                    // A ticket's answer gets the same treatment as a call's: a value that cannot be
                    // read rejects the ticket rather than resolving it with a plausible default.
                    if (RpcConversion.TryConvert<T>(body, out var resolved, out var why))
                        ticket.Resolve(resolved!);
                    else
                        ticket.Reject(new SourceRpcException(RpcErrorCode.InvalidParams, $"the deferred answer could not be read as {typeof(T).Name}: {why}"));
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
            // Only the last handler for this event ends the remote subscription; the others are
            // still listening, and telling the far end to stop would silence them too.
            if (!client.Drop(target, path, eventName, handler))
                return;
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
                    CancellationToken.None);
            }
            catch (Exception e)
            {
                client._log.LogDebug(e, "SourceRpc could not tell {Target} to stop sending {Path}.{Event}", target, path, eventName);
            }
        }
    }
}
