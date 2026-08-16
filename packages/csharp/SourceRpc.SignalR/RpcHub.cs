using System.Diagnostics;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

using SourceRpc;

namespace SourceRpc.SignalR;

/// <summary>
/// A Source RPC hub: routes flat frames between the connected peers and this process.
///
/// **Public because ASP.NET Core requires it, not because it is the API.** SignalR builds a method
/// executor over the hub type by compiling an expression tree, which cannot reference an internal
/// type - so an internal hub is discovered, mapped, connected to, and then silently never invoked,
/// which is exactly how this spent an afternoon. Everything an application should touch is
/// `AddSourceRpc()`, `MapSourceRpc()`, `ISourceRpcResponder` and `ISourceRpcEvents`; what is in
/// here is protocol handling and it will keep changing.
///
/// The layout it speaks is docs/flat-frame-spec.md, and it is the same layout the socket.io
/// transport speaks. Compiled and exercised: `csharp/testhost` runs this hub and
/// `src/Interop.test.ts` drives a real TypeScript client against it over both hub protocols.
/// </summary>
public sealed class RpcHub : Hub
{
    private readonly RpcRouter _peers;
    private readonly RpcDispatcher _dispatcher;
    private readonly SourceRpcOptions _options;
    private readonly SourceRpcTelemetry _telemetry;
    private readonly ILogger<RpcHub> _log;

    public RpcHub(
        RpcRouter peers,
        RpcDispatcher dispatcher,
        IOptions<SourceRpcOptions> options,
        SourceRpcTelemetry telemetry,
        ILogger<RpcHub> log)
    {
        _peers = peers;
        _dispatcher = dispatcher;
        _options = options.Value;
        _telemetry = telemetry;
        _log = log;
    }

    private string Self => _options.Name;

    public override Task OnConnectedAsync()
    {
        _telemetry.ConnectionOpened();
        _log.LogDebug("SourceRpc connection {ConnectionId} established", Context.ConnectionId);
        return base.OnConnectedAsync();
    }

    /// <summary>
    /// A peer saying who it is and what lies behind it, which is the whole of discovery here.
    ///
    /// Answered with the peers already known, which is this transport's stand-in for the retained
    /// presence an MQTT subscriber is handed on subscribe.
    /// </summary>
    public async Task Presence(PresenceAnnouncement who)
    {
        if (string.IsNullOrEmpty(who.Name))
        {
            _telemetry.FrameRejected("presence names no peer");
            return;
        }

        // Where a name stops being a claim. Without this, any connected peer can announce itself as
        // any name, be handed that peer's traffic, and - since subscriptions are keyed by peer name
        // - cancel its subscriptions too.
        if (!Vouches(who.Name, out var refusal))
        {
            _log.LogWarning("SourceRpc refused presence for {Peer} on {ConnectionId}: {Reason}", who.Name, Context.ConnectionId, refusal);
            _telemetry.FrameRejected(refusal);
            throw new HubException(refusal);
        }

        _peers.Announce(who.Name, Context.ConnectionId, who.Shape);
        // What a bridge advertises. Registered here rather than learned from traffic, because
        // reachability comes from presence: a peer behind a bridge that has not spoken yet must
        // still be addressable, or a caller can only ever reach a peer that already called it.
        if (who.Carrying is { Length: > 0 })
            _peers.SetCarried(Context.ConnectionId, who.Name, who.Carrying, _options.MaximumCarriedPeers);

        await Clients.Others.SendAsync("presence", new PresenceUpdate { Peer = who.Name, State = "online", Shape = who.Shape });

        // This process's own name goes first: a newcomer has to know what to call the thing it just
        // connected to before it can address anything at all.
        var peers = new List<string> { Self };
        peers.AddRange(_peers.Names().Where(name => name != who.Name && name != Self));
        // With the shapes, so a newcomer's first picture is not poorer than the announcements it was
        // not present for - the hash exists to tell "same peer name" from "same served surface".
        var shapes = _peers.ShapesFor(peers);
        await Clients.Caller.SendAsync(
            "presence",
            new PresenceUpdate { Peers = peers.ToArray(), Shapes = shapes.Count > 0 ? shapes : null });

        _log.LogDebug("SourceRpc peer {Peer} announced on {ConnectionId}, carrying {Carried}", who.Name, Context.ConnectionId, who.Carrying?.Length ?? 0);
    }

    /// <summary>One frame, either for this process or for another peer connected to this hub.</summary>
    public async Task Frame(RpcFrame frame)
    {
        if (frame.V != 2)
        {
            _telemetry.FrameRejected("unsupported frame version");
            return;
        }

        // A batch is an envelope and nothing more: unpack it and feed each frame through the
        // ordinary path, so every per-call rule still applies per call. It is not a transaction.
        if (frame.Kind == "batch" && frame.Batch is not null)
        {
            foreach (var carried in frame.Batch)
                await Frame(carried);
            return;
        }

        _telemetry.FrameReceived(frame.Kind);

        // The identity check, and the reason the routing table is not a dictionary. A connection may
        // originate frames only for peers it holds a route for: itself, and whatever it advertised
        // as carried. A name nothing has claimed is admitted on sight, which keeps a client that
        // does not announce working; a name another connection holds is refused.
        if (!Originates(frame.Src, out var refusal))
        {
            _log.LogWarning("SourceRpc refused frame from {Source} on {ConnectionId}: {Reason}", frame.Src, Context.ConnectionId, refusal);
            _telemetry.FrameRejected(refusal);
            await Answer(frame.Reply("error", Error("this connection may not originate frames for that peer"), RpcErrorCode.Forbidden));
            return;
        }

        if (frame.Tgt != Self)
        {
            await Relay(frame);
            return;
        }

        // Everything the frame *means* is the dispatcher's: kinds, error mapping, deadline
        // conversion, the "already subscribed" answer. The hub's remaining job is who may speak,
        // where a frame goes, and putting the reply on the right connection.
        var reply = await _dispatcher.HandleAsync(frame, new RpcCaller(frame.Src, Context.User, Context.ConnectionAborted));
        if (reply is not null)
            await Answer(reply);
    }

    /// <summary>Somebody else's frame. Forwarded if this hub can reach them, refused if it cannot.</summary>
    private async Task Relay(RpcFrame frame)
    {
        var connection = _peers.ConnectionFor(frame.Tgt);
        if (connection is null)
        {
            // Refused rather than dropped: a caller waiting on silence learns nothing, and the
            // silence looks identical to a method that is merely slow.
            _telemetry.RoutingFailed();
            await Answer(frame.Reply("error", Error($"no route to '{frame.Tgt}'"), RpcErrorCode.TransportError));
            return;
        }
        await Clients.Client(connection).SendAsync("frame", frame with { Hops = (frame.Hops ?? 0) + 1 });
        _telemetry.FrameSent(frame.Kind);
    }

    /// <summary>
    /// Whether this connection may claim this name.
    ///
    /// With authentication and pinning on, the name must be the authenticated principal's. Without
    /// authentication a name was never evidence of anything, so any name is accepted - but it is
    /// still *recorded*, which is what the frame check then rests on.
    /// </summary>
    private bool Vouches(string name, out string refusal)
    {
        refusal = "";
        if (!_options.PinSourceToAuthenticatedIdentity)
            return true;
        var identity = Context.User?.Identity;
        if (identity?.IsAuthenticated != true)
            return true;
        var authenticated = Context.UserIdentifier ?? identity.Name;
        if (string.IsNullOrEmpty(authenticated) || authenticated == name)
            return true;
        refusal = $"announced name '{name}' does not match the authenticated identity '{authenticated}'";
        return false;
    }

    /// <summary>
    /// Whether this connection may send a frame claiming to come from this peer.
    ///
    /// A name nothing has claimed is admitted and recorded against this connection, which keeps a
    /// peer that never announces working. A name another connection holds is refused - that is the
    /// impersonation this exists to stop.
    /// </summary>
    private bool Originates(string source, out string refusal)
    {
        refusal = "";
        if (string.IsNullOrEmpty(source))
        {
            refusal = "frame names no source";
            return false;
        }
        if (_peers.MayOriginate(Context.ConnectionId, source))
            return true;
        if (_peers.ConnectionFor(source) is null && Vouches(source, out _))
        {
            _peers.Announce(source, Context.ConnectionId, shape: null);
            return true;
        }
        refusal = $"'{source}' is not a peer this connection speaks for";
        return false;
    }

    private static object Error(string message, string? name = null) => new { name = name ?? "RpcError", message };

    private async Task Answer(RpcFrame reply)
    {
        await Clients.Caller.SendAsync("frame", reply);
        _telemetry.FrameSent(reply.Kind);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var name in _peers.Remove(Context.ConnectionId))
        {
            // Whatever it was watching goes with it. There is no frame for a subscriber that simply
            // vanished, so the disconnection is the only signal - and without acting on it the hub
            // walks a growing list of the departed on every emission.
            _dispatcher.DropPeer(name);
            // Awaited: presence convergence is routing correctness rather than telemetry. A peer
            // that is gone but still listed is a peer frames are still addressed to, and an
            // unobserved task can be abandoned outright during the shutdown that caused this.
            await Clients.Others.SendAsync("presence", new PresenceUpdate { Peer = name, State = "offline" });
        }
        _telemetry.ConnectionClosed();
        await base.OnDisconnectedAsync(exception);
    }
}
