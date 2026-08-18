using System.Diagnostics;
using System.Security.Claims;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace SourceRpc;

/// <summary>Who sent a frame, as far as the binding that received it can vouch.</summary>
/// <param name="Source">The peer, already checked against what its link is entitled to claim.</param>
/// <param name="User">The authenticated principal behind it, where the carrier authenticates.</param>
/// <param name="Cancellation">Cancelled when the caller goes away or the host stops.</param>
/// <param name="Reply">
/// How to send a further frame to this caller, for an answer that comes after the first one. A
/// binding supplies it - the hub sends to its connection, a client transport down its link - and
/// without it a deferred method cannot answer, so the dispatcher refuses to defer rather than
/// accepting work whose result it has no way to deliver.
/// </param>
public readonly record struct RpcCaller(
    string Source,
    ClaimsPrincipal? User = null,
    CancellationToken Cancellation = default,
    Func<RpcFrame, Task>? Reply = null);

/// <summary>
/// What to do with a frame addressed to this process, independent of what carried it.
///
/// Every binding funnels inbound frames through here rather than interpreting them itself, and that
/// is the point: a call, a subscribe and an unsubscribe mean one thing over SignalR, socket.io and
/// MQTT, and error mapping, deadline conversion and the "already subscribed" answer are written
/// once. A binding that interpreted frames for itself would be a fourth dialect of the protocol
/// dressed as a transport.
/// </summary>
public sealed class RpcDispatcher
{
    private readonly ISourceRpcResponder? _responder;
    private readonly IRpcOwnership? _ownership;
    private readonly IRpcIdempotencyStore? _idempotency;

    /// <summary>How many calls may run at once, so a burst is refused rather than absorbed.</summary>
    private readonly SemaphoreSlim _running;
    private readonly SubscriptionTable _subscriptions;
    private readonly SourceRpcOptions _options;
    private readonly SourceRpcTelemetry _telemetry;
    private readonly ILogger _log;

    /// <summary>Creates a dispatcher. A hub or a client transport owns one.</summary>
    public RpcDispatcher(
        SourceRpcOptions options,
        SubscriptionTable subscriptions,
        SourceRpcTelemetry telemetry,
        ISourceRpcResponder? responder = null,
        ILogger? log = null,
        IRpcOwnership? ownership = null,
        IRpcIdempotencyStore? idempotency = null)
    {
        _ownership = ownership;
        _idempotency = idempotency;
        _options = options;
        _subscriptions = subscriptions;
        _telemetry = telemetry;
        _responder = responder;
        _log = log ?? NullLogger.Instance;
        _running = new SemaphoreSlim(options.Limits.MaxConcurrentCalls, options.Limits.MaxConcurrentCalls);
        telemetry.Subscriptions = () => _subscriptions.Count;
    }

    /// <summary>
    /// The peers watching one event, for a binding about to fan one out.
    ///
    /// This much of the subscription table is binding-facing and no more: who to send to. The table
    /// itself stays internal because it has changed twice already, and a transport that had built
    /// against its shape would have been broken by both.
    /// </summary>
    public IEnumerable<string> SubscribersOf(string path, string eventName) => _subscriptions.SubscribersOf(path, eventName);

    /// <summary>Drop everything a departed peer was watching. Nothing else will ever drop it.</summary>
    public void DropPeer(string peer) => _subscriptions.RemovePeer(peer);

    /// <summary>
    /// Handle one frame and produce the reply to send back, or null when nothing should be sent.
    ///
    /// Returning the reply rather than sending it is what keeps this transport-neutral: a hub sends
    /// to `Clients.Caller`, an MQTT binding publishes to a response topic, and neither concern
    /// belongs here.
    /// </summary>
    public async Task<RpcFrame?> HandleAsync(RpcFrame frame, RpcCaller caller)
    {
        _telemetry.FrameReceived(frame.Kind);

        // Checked before anything acts on the frame, because the cheapest place to refuse a frame
        // that is out of bounds is before it has cost anything.
        if (Exceeds(frame) is { } broken)
        {
            _log.LogWarning("SourceRpc refused a frame from {Source}: {Reason}", frame.Src, broken);
            _telemetry.FrameRejected(broken);
            return frame.Reply("error", Error(broken), RpcErrorCode.LimitExceeded);
        }

        return frame.Kind switch
        {
            "call" => await DispatchAsync(frame, caller),
            "subscribe" or "unsubscribe" => Watch(frame, caller),
            _ => frame.Reply("error", Error($"this peer does not handle '{frame.Kind}' frames"), RpcErrorCode.MethodNotFound)
        };
    }

    /// <summary>
    /// Why this frame is outside what this peer accepts, or null when it is within them.
    ///
    /// The hop count is the one that matters most in an ordinary network: a hub increments it when
    /// it relays, and two peers each relaying for the other will otherwise pass one frame between
    /// them for as long as the process lives - a loop nobody configured and nothing reports.
    /// </summary>
    private string? Exceeds(RpcFrame frame)
    {
        var limits = _options.Limits;
        if (frame.Hops is { } hops && hops > limits.MaxHops)
            return $"the frame has passed through {hops} relays, and this peer accepts {limits.MaxHops}";
        if (frame.Path is { Length: > 0 } path && path.Length > limits.MaxIdentifierLength)
            return "the path is longer than this peer accepts";
        if (frame.Method is { Length: > 0 } method && method.Length > limits.MaxIdentifierLength)
            return "the method name is longer than this peer accepts";
        if (frame.Corr is { Length: > 0 } corr && corr.Length > limits.MaxIdentifierLength)
            return "the correlation is longer than this peer accepts";
        if (frame.Batch is { } batch)
        {
            if (batch.Length > limits.MaxBatchItems)
                return $"the batch carries {batch.Length} frames, and this peer accepts {limits.MaxBatchItems}";
            // Depth is checked by refusing a batch inside a batch rather than by recursing, which
            // is the point: unpacking to find out how deep something goes is the thing being
            // guarded against.
            if (limits.MaxBatchDepth <= 1 && batch.Any(carried => carried.Batch is not null))
                return "a batch may not carry another batch";
        }
        return null;
    }

    /// <summary>
    /// Run one call and produce its answer - or null, for the one case that has no answer: a
    /// duplicate of a command already running under the same idempotency key, which is dropped
    /// because its caller is already waiting on the attempt that holds the key.
    /// </summary>
    private async Task<RpcFrame?> DispatchAsync(RpcFrame frame, RpcCaller caller)
    {
        if (_responder is null)
            return frame.Reply("error", Error("this peer serves no methods"), RpcErrorCode.ClassNotFound);

        var path = frame.Path ?? "";
        var method = frame.Method ?? "";
        // A span per call, so an RPC can be followed into whatever the method went on to do.
        using var activity = SourceRpcTelemetry.Source.StartActivity($"rpc {path}.{method}", ActivityKind.Server);
        activity?.SetTag("rpc.path", path);
        activity?.SetTag("rpc.method", method);
        activity?.SetTag("rpc.source", caller.Source);

        var invocation = new RpcInvocation
        {
            Path = path,
            Method = method,
            Source = caller.Source,
            Target = _options.Name,
            User = caller.User,
            // A duration on the wire becomes a moment here, because this is where the arrival time
            // is known and because two machines' clocks cannot be compared.
            Deadline = frame.Ttl is { } ttl and > 0 ? DateTimeOffset.UtcNow.AddMilliseconds(ttl) : null,
            Fence = frame.Fence,
            IdempotencyKey = frame.Idem,
            Frame = frame,
            Reply = caller.Reply
        };

        // Before anything runs, and in this order. A fence asks whether this command still belongs
        // to the world its caller observed; the deadline asks whether anyone is still waiting; the
        // idempotency store asks whether it has already been done. Running first and checking after
        // would answer all three too late.
        if (Fenced(frame, path) is { } fenced)
            return frame.Reply("error", Error(fenced), RpcErrorCode.OwnershipChanged);

        if (invocation.Expired)
            // Checked immediately before running rather than only on arrival: what a deadline
            // catches is the time spent queued inside this process, which is the part a caller
            // cannot see and the broker cannot deduct.
            return frame.Reply("error", Error("the caller's deadline had passed before this ran"), RpcErrorCode.Timeout);

        var claimed = false;
        if (frame.Idem is { Length: > 0 } key)
        {
            if (_idempotency is null)
            {
                // Refused rather than run unguarded. A caller sends a key precisely because running
                // twice matters, and carrying it while enforcing nothing tells that caller a guard
                // was applied when none was. `AllowUnenforcedIdempotencyKeys` opts back into the old
                // behaviour for a network still being migrated.
                if (!_options.AllowUnenforcedIdempotencyKeys)
                {
                    _log.LogWarning("SourceRpc refused {Path}.{Method}: it carried an idempotency key and no store is registered", path, method);
                    return frame.Reply("error", Error("this peer has no idempotency store, so the key on this call cannot be honoured"), RpcErrorCode.IdempotencyUnavailable);
                }
            }
            else
            {
                RpcIdempotencyClaim claim;
                try
                {
                    claim = await _idempotency.BeginAsync(key, caller.Cancellation);
                }
                catch (Exception e)
                {
                    // Refused rather than run. A store that cannot be reached is the one condition
                    // under which running risks the double execution it was installed to prevent -
                    // and the caller is told the outcome is unknown rather than that the transport
                    // failed, because "it failed" invites exactly the retry that must not happen.
                    _log.LogError(e, "SourceRpc idempotency store refused key {Key}", key);
                    return frame.Reply("error", Error("the idempotency store could not be reached, so this command was not run"), RpcErrorCode.UnknownOutcome);
                }

                switch (claim)
                {
                    case RpcIdempotencyClaim.Completed(var recorded):
                        _log.LogDebug("SourceRpc answered {Path}.{Method} from the idempotency record for {Key}", path, method, key);
                        return recorded.Failed
                            ? frame.Reply("error", Error(recorded.Message ?? "the command failed"), recorded.Code ?? nameof(RpcErrorCode.Exception))
                            : frame.Reply("result", recorded.Value);

                    case RpcIdempotencyClaim.InProgress:
                        // Dropped rather than answered, which is what the TypeScript side does and
                        // for its reason: the caller is already waiting on the attempt that holds
                        // the key, and two answers to one request would be worse than one.
                        _log.LogDebug("SourceRpc dropped a duplicate of {Path}.{Method}: {Key} is already running", path, method, key);
                        return null;

                    default:
                        claimed = true;
                        break;
                }
            }
        }

        // Refused rather than queued, and refused *before* the claim would be taken. Transports
        // deliberately do not await dispatch - a responder must be able to call out and receive the
        // reply - so without a gate here a burst becomes as many concurrent invocations as arrive,
        // and the first sign of trouble is memory rather than a message anybody can act on.
        if (!_running.Wait(0))
        {
            _log.LogWarning("SourceRpc refused {Path}.{Method}: already running {Limit} calls", path, method, _options.Limits.MaxConcurrentCalls);
            _telemetry.FrameRejected("at the concurrent call limit");
            if (claimed && frame.Idem is { Length: > 0 } busyKey && _idempotency is not null)
                // The claim goes back, because this certainly did not run.
                await _idempotency.AbandonAsync(busyKey, CancellationToken.None);
            return frame.Reply("error", Error("this peer is already running as many calls as it will run at once"), RpcErrorCode.Busy);
        }

        var started = Stopwatch.GetTimestamp();
        RpcErrorCode? failure = null;
        try
        {
            var result = await _responder.InvokeAsync(invocation, caller.Cancellation);

            // A method that answered with a receipt is answering later. The caller is told so now,
            // and whatever it produces goes down the link afterwards.
            if (result is RpcTicketReceipt receipt)
            {
                // The claim stays held until something records an outcome for it, and nothing here
                // does: the answer is produced by the deferred object long after this returns. That
                // is the safe half of the problem - a retry is dropped as in-progress rather than
                // running the command a second time - but the claim is not released when the ticket
                // settles either, so the key stays unusable until the store expires it. Wiring the
                // deferred completion into the store is the missing piece.
                if (claimed)
                    _log.LogWarning(
                        "SourceRpc is holding idempotency key {Key} for a deferred {Path}.{Method}; it will not be released when the ticket settles",
                        frame.Idem, path, method);
                return frame.Reply("result", receipt) with { Deferred = true };
            }

            return await RecordedAsync(frame, new RpcOutcome(Failed: false, Value: result), frame.Reply("result", result), caller.Cancellation);
        }
        catch (SourceRpcException e)
        {
            // Thrown on purpose, so the message was written for whoever reads it and travels.
            failure = e.Code;
            return await RecordedAsync(
                frame,
                new RpcOutcome(Failed: true, Code: e.Code.ToString(), Message: e.Message),
                frame.Reply("error", Error(e.Message), e.Code),
                caller.Cancellation);
        }
        catch (OperationCanceledException) when (caller.Cancellation.IsCancellationRequested)
        {
            // Nobody is waiting: the caller went away. There is nothing to send an answer to - but
            // the command may have run before the cancellation was observed, so the key is recorded
            // as unknown rather than left claimed. A retry then hears "it may have run" instead of
            // running it again, which is the whole reason the caller sent a key.
            failure = RpcErrorCode.TransportError;
            await RecordAsync(
                frame,
                new RpcOutcome(Failed: true, Code: nameof(RpcErrorCode.UnknownOutcome), Message: "the caller went away while this was running"),
                CancellationToken.None);
            return frame.Reply("error", Error("the caller went away"), RpcErrorCode.TransportError);
        }
        catch (Exception e)
        {
            failure = RpcErrorCode.Exception;
            // Logged in full, sent in outline. What escaped a method carries whatever the CLR or a
            // vendor library put in it - a path, a connection string, the innards of a COM error -
            // and a plant network is not the place to publish it.
            _log.LogError(e, "SourceRpc call {Path}.{Method} from {Source} threw", path, method, caller.Source);
            var detail = _options.IncludeExceptionDetail ? e.Message : "the method failed; see the server log";
            // Recorded like any other outcome. Leaving it unrecorded would hold the claim for ever,
            // so every later retry of a command that failed once would be dropped rather than
            // answered - and the caller would never learn what happened.
            return await RecordedAsync(
                frame,
                new RpcOutcome(Failed: true, Code: nameof(RpcErrorCode.Exception), Message: detail),
                frame.Reply("error", Error(detail, e.GetType().Name), RpcErrorCode.Exception),
                caller.Cancellation);
        }
        finally
        {
            _running.Release();
            var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            _telemetry.CallCompleted(path, method, elapsed, failure);
            activity?.SetStatus(failure is null ? ActivityStatusCode.Ok : ActivityStatusCode.Error);
            _log.LogDebug(
                "SourceRpc call {Path}.{Method} from {Source} took {Duration}ms {Outcome}",
                path, method, caller.Source, elapsed, failure?.ToString() ?? "ok");
        }
    }

    /// <summary>
    /// Take or drop a subscription. Both are ordinary requests whose kind says what they are and
    /// whose body is the argument array holding the event name, so every request has one shape and a
    /// caller writes `proxy.on('built', handler)` without knowing anything different happens.
    /// </summary>
    private RpcFrame Watch(RpcFrame frame, RpcCaller caller)
    {
        var ev = frame.Arg<string>(0);
        if (string.IsNullOrEmpty(ev))
            return frame.Reply("error", Error("a subscribe names its event in the argument array"), RpcErrorCode.InvalidParams);

        var path = frame.Path ?? "";
        if (frame.Kind == "unsubscribe")
        {
            // Deliberately not authorized beyond the identity check the binding already applied: the
            // key includes the caller, so a peer can only drop its own subscription, and refusing to
            // let somebody stop receiving events would be a strange thing to enforce.
            var dropped = _subscriptions.Remove(path, ev, caller.Source);
            return frame.Reply("result", dropped ? "ok" : "ok - was not subscribed");
        }

        var added = _subscriptions.Add(path, ev, caller.Source);
        _log.LogDebug("SourceRpc {Peer} subscribed to {Path}.{Event}", caller.Source, path, ev);
        // "already exists" rather than an error, because a client replaying its subscriptions after
        // a reconnect is doing the right thing and must not end up receiving everything twice.
        return frame.Reply("result", added ? "ok" : "ok - already exists");
    }

    /// <summary>
    /// Why this fenced call must not run, or null when it may.
    ///
    /// Fails closed in both directions that matter: a fence with no ownership recorded anywhere, and
    /// a fence against an instance this process holds no record of, are both refused. A peer that
    /// accepted a fence it could not check would be telling the caller its command had been guarded
    /// when nothing had guarded it, which is worse than refusing.
    /// </summary>
    private string? Fenced(RpcFrame frame, string path)
    {
        if (frame.Fence is not { Length: > 0 } fence)
            return null;
        if (_ownership is null)
            return $"'{path}' was called with an owner fence and this peer records no ownership to check it against";
        var epoch = _ownership.OwnerEpochOf(path);
        if (epoch is null)
            return $"'{path}' has no owner recorded here to check the fence against";
        if (epoch != fence)
            return $"'{path}' changed owner generation while this call was on its way - read the topology again and decide again";
        return null;
    }

    /// <summary>
    /// Record an outcome before the caller is answered.
    ///
    /// Before, deliberately: a crash between running the command and recording it would leave one
    /// that ran and can be run again, which is the failure the store exists to prevent. So the
    /// record is the commit point rather than the reply.
    /// </summary>
    private async Task<bool> RecordAsync(RpcFrame frame, RpcOutcome outcome, CancellationToken cancellationToken)
    {
        if (frame.Idem is not { Length: > 0 } key || _idempotency is null)
            return true;
        try
        {
            await _idempotency.CompleteAsync(key, outcome, cancellationToken);
            return true;
        }
        catch (Exception e)
        {
            _log.LogError(e, "SourceRpc ran {Path}.{Method} but could not record its outcome for {Key}", frame.Path, frame.Method, key);
            return false;
        }
    }

    /// <summary>
    /// Write the outcome down, and answer only if that worked.
    ///
    /// A command that ran but whose record was not committed is the one case where the ordinary
    /// answer is a lie: the caller is told it succeeded, the guard against a *retry* is not in
    /// place, and if the answer is then lost the retry runs the command a second time. So the
    /// caller is told the outcome is unknown, which is the one thing that is certainly true, and
    /// which says go and look rather than try again.
    /// </summary>
    private async Task<RpcFrame> RecordedAsync(RpcFrame frame, RpcOutcome outcome, RpcFrame answer, CancellationToken cancellationToken)
    {
        if (await RecordAsync(frame, outcome, cancellationToken))
            return answer;
        return frame.Reply(
            "error",
            Error("the command ran, but its outcome could not be recorded - it may or may not have taken effect, and it must not be blindly retried"),
            RpcErrorCode.UnknownOutcome);
    }

    internal static object Error(string message, string? name = null) => new { name = name ?? "RpcError", message };
}
