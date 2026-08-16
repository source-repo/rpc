using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace SourceRpc.SignalR;

/// <summary>
/// The name this process answers to on the network.
///
/// Its own singleton rather than a property of the responder, and the reason is a dependency cycle
/// that is easy to walk into: <see cref="RpcEvents"/> needs the name to address the frames it sends,
/// and whatever emits events needs <see cref="RpcEvents"/> - so a name owned by the responder makes
/// the two require each other and the container refuses to build either. Identity is configuration,
/// not behaviour, so it is separated from both.
/// </summary>
public sealed record RpcPeer(string Name);

/// <summary>
/// What a .NET process exposes to a Source RPC network: a method, found by instance and name.
///
/// Deliberately tiny. The library on the TypeScript side does a great deal more - authorization,
/// deadlines, idempotency, owner fences, contract versions - and a hub that needs those implements
/// them here, in front of Invoke. What this interface fixes is only the part the wire format
/// dictates: a call names a path and a method and carries an argument array, and it is answered.
/// </summary>
public interface IRpcResponder
{
    /// <summary>
    /// Run a method. Throw to have the caller receive an error frame; the exception message
    /// travels, so make it one an operator can read.
    /// </summary>
    Task<object?> Invoke(string path, string method, JsonElement? args, RpcFrame frame);
}

/// <summary>
/// A Source RPC hub: routes flat frames between the connected peers and this process.
///
/// Wire it up with:
/// <code>
/// builder.Services.AddSignalR();
/// builder.Services.AddSingleton(new RpcPeer("vs-automation"));
/// builder.Services.AddSingleton&lt;PeerTable&gt;();
/// builder.Services.AddSingleton&lt;SubscriptionTable&gt;();
/// builder.Services.AddSingleton&lt;RpcEvents&gt;();
/// builder.Services.AddSingleton&lt;IRpcResponder, MyAutomationSurface&gt;();
/// // ...
/// app.MapHub&lt;RpcHub&gt;("/rpc");
/// </code>
///
/// A TypeScript peer then reaches it with:
/// <code>
/// new RpcClient(undefined, {
///     name: 'hmi',
///     defaultTarget: 'vs-automation',
///     useMsgPack: false,                       // JSON hub protocol, which is what this file assumes
///     transport: new SignalRClientTransport('hmi', 'http://localhost:5217/rpc')
/// })
/// </code>
///
/// Compiled and exercised: `csharp/testhost` runs this hub, and `src/Interop.test.ts` drives a real
/// TypeScript client against it - calls, errors, subscriptions and the event cursor.
/// </summary>
public class RpcHub : Hub
{
    private readonly PeerTable _peers;
    private readonly SubscriptionTable _subscriptions;
    private readonly RpcPeer _self;
    private readonly IRpcResponder _responder;

    public RpcHub(PeerTable peers, SubscriptionTable subscriptions, RpcPeer self, IRpcResponder responder)
    {
        _peers = peers;
        _subscriptions = subscriptions;
        _self = self;
        _responder = responder;
    }

    /// <summary>
    /// A peer saying who it is, which is the whole of discovery here. Answered with the peers
    /// already connected, which is this transport's stand-in for retained presence.
    /// </summary>
    public async Task Presence(PresenceAnnouncement who)
    {
        if (string.IsNullOrEmpty(who.Name))
            return;

        // If you authenticate connections, this is where a name stops being a claim. Compare
        // who.Name with Context.User and refuse the mismatch - without it, any connected peer can
        // announce itself as any name and be handed everyone else's traffic.
        _peers.Add(who.Name, Context.ConnectionId);

        await Clients.Others.SendAsync("presence", new PresenceUpdate { Peer = who.Name, State = "online", Shape = who.Shape });

        // This process's own name goes first: a newcomer has to know what to call the thing it just
        // connected to before it can address anything at all.
        var peers = new List<string> { _self.Name };
        peers.AddRange(_peers.Names().Where(name => name != who.Name));
        await Clients.Caller.SendAsync("presence", new PresenceUpdate { Peers = peers.ToArray() });
    }

    /// <summary>One frame, either for this process or for another peer connected to this hub.</summary>
    public async Task Frame(RpcFrame frame)
    {
        if (frame.V != 2)
            return;

        // A batch is an envelope and nothing more: unpack it and feed each frame through the
        // ordinary path, so every per-call rule still applies per call. It is not a transaction.
        if (frame.Kind == "batch" && frame.Batch is not null)
        {
            foreach (var carried in frame.Batch)
                await Frame(carried);
            return;
        }

        // Learned here as well as from Presence, because a peer may never announce and still be
        // addressable from the frames it sends.
        if (!string.IsNullOrEmpty(frame.Src))
            _peers.Add(frame.Src, Context.ConnectionId);

        if (frame.Tgt != _self.Name)
        {
            // Somebody else's. Forwarded if this hub can reach them, refused if it cannot -
            // refused rather than dropped, because a caller waiting on silence learns nothing.
            var connection = _peers.ConnectionFor(frame.Tgt);
            if (connection is null)
            {
                await Answer(frame.Reply("error", new { name = "RpcError", message = $"no route to '{frame.Tgt}'" }, "TransportError"));
                return;
            }
            await Clients.Client(connection).SendAsync("frame", frame with { Hops = (frame.Hops ?? 0) + 1 });
            return;
        }

        if (frame.Kind == "subscribe" || frame.Kind == "unsubscribe")
        {
            await Watch(frame);
            return;
        }

        if (frame.Kind != "call")
        {
            // Results and tickets are answers to calls this process made, which needs a client of
            // its own to have made them. Worth having; not needed to serve methods and events,
            // which is what this hub is for.
            await Answer(frame.Reply("error", new { name = "RpcError", message = $"this hub does not handle '{frame.Kind}' frames" }, "MethodNotFound"));
            return;
        }

        try
        {
            var result = await _responder.Invoke(frame.Path ?? "", frame.Method ?? "", frame.Body, frame);
            await Answer(frame.Reply("result", result));
        }
        catch (Exception e)
        {
            // The shape an error frame's body has: {name, message, stack?}. A caller turns it back
            // into a rejected promise, so the message is what somebody eventually reads.
            await Answer(frame.Reply("error", new { name = e.GetType().Name, message = e.Message }, "Exception"));
        }
    }

    /// <summary>
    /// Take or drop a subscription. `subscribe` and `unsubscribe` are ordinary requests whose kind
    /// says what they are, and whose body is the argument array holding the event name - so every
    /// request has one shape, and a caller writes `proxy.on('built', handler)` without knowing that
    /// anything different happens on the wire.
    /// </summary>
    private async Task Watch(RpcFrame frame)
    {
        var ev = EventNameIn(frame.Body);
        if (string.IsNullOrEmpty(ev))
        {
            await Answer(frame.Reply("error", new { name = "RpcError", message = "a subscribe names its event in the argument array" }, "InvalidParams"));
            return;
        }
        var path = frame.Path ?? "";

        if (frame.Kind == "unsubscribe")
        {
            // Deliberately not authorized, and this is not an oversight. The key includes the
            // caller, so a peer can only ever drop its own subscription, and refusing to let
            // somebody stop receiving events would be a strange thing to enforce.
            var dropped = _subscriptions.Remove(path, ev, frame.Src);
            await Answer(frame.Reply("result", dropped ? "ok" : "ok - was not subscribed"));
            return;
        }

        // Where an authorization check belongs, and the reason it belongs *here* rather than beside
        // Invoke: a subscription is a standing grant to receive, taken once and honoured for as long
        // as the peer stays connected, so a rule applied only to calls would never see it. Answer
        // code Forbidden to refuse one.
        var added = _subscriptions.Add(path, ev, frame.Src);

        // "already exists" rather than an error, because a client replaying its subscriptions after
        // a reconnect is doing the right thing and must not end up receiving everything twice.
        await Answer(frame.Reply("result", added ? "ok" : "ok - already exists"));
    }

    /// <summary>The event name a subscribe carried, or null if it carried nothing usable.</summary>
    private static string? EventNameIn(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Array } array || array.GetArrayLength() == 0)
            return null;
        var first = array[0];
        return first.ValueKind == JsonValueKind.String ? first.GetString() : null;
    }

    private Task Answer(RpcFrame reply) => Clients.Caller.SendAsync("frame", reply);

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var name in _peers.Remove(Context.ConnectionId))
        {
            // Whatever it was watching goes with it. There is no frame for a subscriber that simply
            // vanished, so the disconnection is the only signal - and without acting on it the hub
            // walks a growing list of the departed on every emission.
            _subscriptions.RemovePeer(name);
            Clients.Others.SendAsync("presence", new PresenceUpdate { Peer = name, State = "offline" });
        }
        return base.OnDisconnectedAsync(exception);
    }
}

/// <summary>
/// Which connection reaches which peer. A singleton, because it outlives any one hub instance -
/// ASP.NET Core creates a Hub per invocation.
/// </summary>
public sealed class PeerTable
{
    private readonly ConcurrentDictionary<string, string> _byName = new();

    public void Add(string name, string connectionId) => _byName[name] = connectionId;

    public string? ConnectionFor(string name) => _byName.TryGetValue(name, out var id) ? id : null;

    public IEnumerable<string> Names() => _byName.Keys;

    /// <summary>Forget a dropped connection, returning the peers that went with it.</summary>
    public IEnumerable<string> Remove(string connectionId)
    {
        var gone = _byName.Where(entry => entry.Value == connectionId).Select(entry => entry.Key).ToList();
        foreach (var name in gone)
            _byName.TryRemove(name, out _);
        return gone;
    }
}
