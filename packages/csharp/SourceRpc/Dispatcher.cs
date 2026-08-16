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

        return frame.Kind switch
        {
            "call" => await DispatchAsync(frame, caller),
            "subscribe" or "unsubscribe" => Watch(frame, caller),
            _ => frame.Reply("error", Error($"this peer does not handle '{frame.Kind}' frames"), RpcErrorCode.MethodNotFound)
        };
    }

    private async Task<RpcFrame> DispatchAsync(RpcFrame frame, RpcCaller caller)
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

        RpcOutcome? recorded = null;
        if (frame.Idem is { Length: > 0 } key && _idempotency is not null)
        {
            try
            {
                recorded = await _idempotency.BeginAsync(key, caller.Cancellation);
            }
            catch (Exception e)
            {
                // Refused rather than run. A store that cannot be reached is the one condition under
                // which running risks the double execution it was installed to prevent.
                _log.LogError(e, "SourceRpc idempotency store refused key {Key}", key);
                return frame.Reply("error", Error("the idempotency store could not be reached"), RpcErrorCode.TransportError);
            }
            if (recorded is not null)
            {
                _log.LogDebug("SourceRpc answered {Path}.{Method} from the idempotency record for {Key}", path, method, key);
                return recorded.Failed
                    ? frame.Reply("error", Error(recorded.Message ?? "the command failed"), recorded.Code ?? nameof(RpcErrorCode.Exception))
                    : frame.Reply("result", recorded.Value);
            }
        }

        var started = Stopwatch.GetTimestamp();
        RpcErrorCode? failure = null;
        try
        {
            var result = await _responder.InvokeAsync(invocation, caller.Cancellation);

            // A method that answered with a receipt is answering later. The caller is told so now,
            // and whatever it produces goes down the link afterwards.
            if (result is RpcTicketReceipt receipt)
                return frame.Reply("result", receipt) with { Deferred = true };

            await RecordAsync(frame, new RpcOutcome(Failed: false, Value: result), caller.Cancellation);
            return frame.Reply("result", result);
        }
        catch (SourceRpcException e)
        {
            // Thrown on purpose, so the message was written for whoever reads it and travels.
            failure = e.Code;
            await RecordAsync(frame, new RpcOutcome(Failed: true, Code: e.Code.ToString(), Message: e.Message), caller.Cancellation);
            return frame.Reply("error", Error(e.Message), e.Code);
        }
        catch (OperationCanceledException) when (caller.Cancellation.IsCancellationRequested)
        {
            // Nobody is waiting: the caller went away. Answering a link that has gone is not a
            // failure worth recording as one, and there is nothing to send it to.
            failure = RpcErrorCode.TransportError;
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
            return frame.Reply("error", Error(detail, e.GetType().Name), RpcErrorCode.Exception);
        }
        finally
        {
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
    private async Task RecordAsync(RpcFrame frame, RpcOutcome outcome, CancellationToken cancellationToken)
    {
        if (frame.Idem is not { Length: > 0 } key || _idempotency is null)
            return;
        try
        {
            await _idempotency.CompleteAsync(key, outcome, cancellationToken);
        }
        catch (Exception e)
        {
            // The command has already run, so refusing now would be a lie. Logged loudly instead:
            // what is lost is the protection against a *retry*, and somebody should know.
            _log.LogError(e, "SourceRpc ran {Path}.{Method} but could not record its outcome for {Key}", frame.Path, frame.Method, key);
        }
    }

    internal static object Error(string message, string? name = null) => new { name = name ?? "RpcError", message };
}
