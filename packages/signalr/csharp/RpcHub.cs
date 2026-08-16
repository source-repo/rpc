using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace SourceRpc.SignalR;

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
    /// <summary>The peer name this process answers to on the network.</summary>
    string Name { get; }

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
/// builder.Services.AddSingleton&lt;PeerTable&gt;();
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
/// **This file has not been compiled.** It is written against the specification rather than against
/// a build, so treat the first compile as part of adopting it.
/// </summary>
public class RpcHub : Hub
{
    private readonly PeerTable _peers;
    private readonly IRpcResponder _responder;

    public RpcHub(PeerTable peers, IRpcResponder responder)
    {
        _peers = peers;
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
        var peers = new List<string> { _responder.Name };
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

        if (frame.Tgt != _responder.Name)
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

        if (frame.Kind != "call")
        {
            // subscribe/unsubscribe need an event registry, and results and tickets are answers to
            // calls this process made. Both are worth having; neither is needed to serve methods,
            // which is what a first hub is for.
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

    private Task Answer(RpcFrame reply) => Clients.Caller.SendAsync("frame", reply);

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var name in _peers.Remove(Context.ConnectionId))
            Clients.Others.SendAsync("presence", new PresenceUpdate { Peer = name, State = "offline" });
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
