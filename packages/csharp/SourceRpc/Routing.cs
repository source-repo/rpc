using System.Collections.Concurrent;

namespace SourceRpc;

/// <summary>How a peer is reached, and by whose authority it is listed.</summary>
/// <param name="Name">The peer name.</param>
/// <param name="ConnectionId">The connection that reaches it.</param>
/// <param name="Carried">False when the peer announced itself; true when a neighbour advertised it.</param>
/// <param name="Shape">A short hash of the surface it serves, when it announced one.</param>
internal sealed record PeerRoute(string Name, string ConnectionId, bool Carried, string? Shape);

/// <summary>
/// Who is reachable, through which link, and which of them a given link is entitled to speak for.
///
/// Public because a binding has to do routing and this is the shape of it - unlike the subscription
/// table, which the dispatcher owns and no transport needs to see. The record it stores is not
/// public: what a route *is* has already changed twice.
///
/// That last clause is the reason this is not a dictionary. Three things the hub needs turn out to
/// be one question:
///
/// - **Identity.** A frame's `src` is written by whoever sent it. Without a check, any connected
///   client can send `src: "plc-production-1"` and be treated as that peer - and since subscriptions
///   are keyed by the same field, it can cancel another peer's subscriptions too.
/// - **Carried peers.** A bridge advertises the peers behind it, and they must be addressable
///   *before* they have spoken - reachability comes from presence, not from waiting for the
///   destination to talk first.
/// - **Shapes.** A newcomer's first snapshot should tell it as much as it would have learned by
///   witnessing every announcement it missed.
///
/// The single answer is a route per name recording the connection that holds it. Carried peers are
/// routes too, which makes them addressable; a frame may be originated only for a name this
/// connection holds a route for, which is the identity check; and the route carries the shape.
/// </summary>
public sealed class RpcRouter
{
    private readonly ConcurrentDictionary<string, PeerRoute> _routes = new();

    /// <summary>
    /// Register a peer that announced itself, taking the name over if another connection held it.
    ///
    /// The takeover is deliberate rather than an oversight: a peer reconnecting after a blip
    /// announces itself while the hub may still hold the dead connection, and refusing would lock a
    /// peer out of its own name until a timeout it cannot see. Where the hub authenticates, the
    /// caller has already established that this connection is entitled to the name, so a takeover
    /// is that peer returning; where it does not, a name was never evidence of anything.
    /// </summary>
    public void Announce(string name, string connectionId, string? shape) =>
        _routes[name] = new PeerRoute(name, connectionId, Carried: false, Shape: shape);

    /// <summary>
    /// Apply a connection's latest claim about what lies behind it, adding and dropping as it changes.
    ///
    /// A carried claim never displaces a peer that announced itself, nor one another link already
    /// carries. Letting it would make two neighbours advertising the same peer flip the route back
    /// and forth, each flip re-announced onwards - chatter that never settles - and would hand any
    /// connection a way to capture a name simply by claiming to carry it.
    /// </summary>
    public void SetCarried(string connectionId, string announcer, IReadOnlyCollection<string> carrying, int maximum)
    {
        var claimed = carrying
            .Where(name => !string.IsNullOrEmpty(name) && name != announcer)
            .Distinct()
            .Take(maximum)
            .ToHashSet();

        // Anything this connection used to carry and no longer claims stops being reachable here.
        foreach (var route in _routes.Values.Where(r => r.ConnectionId == connectionId && r.Carried))
            if (!claimed.Contains(route.Name))
                _routes.TryRemove(route.Name, out _);

        foreach (var name in claimed)
            _routes.AddOrUpdate(
                name,
                _ => new PeerRoute(name, connectionId, Carried: true, Shape: null),
                (_, existing) => existing.Carried && existing.ConnectionId != connectionId ? existing : existing.Carried ? existing with { ConnectionId = connectionId } : existing);
    }

    /// <summary>
    /// Whether this connection may send a frame claiming to come from this name.
    ///
    /// The whole identity check, in one line: a connection speaks for the peers it holds routes for
    /// and for nobody else. A bridge therefore speaks for itself and for what it advertised as
    /// carried, which is what makes relaying work without making impersonation work.
    /// </summary>
    public bool MayOriginate(string connectionId, string name) =>
        _routes.TryGetValue(name, out var route) && route.ConnectionId == connectionId;

    /// <summary>The connection that reaches a peer, or null when nothing here does.</summary>
    public string? ConnectionFor(string name) => _routes.TryGetValue(name, out var route) ? route.ConnectionId : null;

    /// <summary>Every peer this hub can put a frame in front of.</summary>
    public IEnumerable<string> Names() => _routes.Keys;

    /// <summary>The shapes known for the peers listed, for a snapshot that should not be poorer than the announcements it replaces.</summary>
    public Dictionary<string, string> ShapesFor(IEnumerable<string> names)
    {
        var shapes = new Dictionary<string, string>();
        foreach (var name in names)
            if (_routes.TryGetValue(name, out var route) && route.Shape is { Length: > 0 } shape)
                shapes[name] = shape;
        return shapes;
    }

    /// <summary>Forget a dropped connection, returning the peers that went with it.</summary>
    public IReadOnlyCollection<string> Remove(string connectionId)
    {
        var gone = _routes.Values.Where(route => route.ConnectionId == connectionId).Select(route => route.Name).ToList();
        foreach (var name in gone)
            _routes.TryRemove(name, out _);
        return gone;
    }
}

/// <summary>One peer's interest in one event of one instance.</summary>
/// <param name="Path">The exposed instance.</param>
/// <param name="Event">The event on it.</param>
/// <param name="Peer">The subscriber.</param>
internal sealed record SubscriptionKey(string Path, string Event, string Peer);

/// <summary>
/// Who is subscribed to what.
///
/// Public and shared rather than owned by the dispatcher, and that is a scar: making it the
/// dispatcher's private field produced a dependency cycle - dispatcher needs the responder, the
/// responder needs the event publisher, the publisher needs to know who is subscribed - and a
/// container cannot build any of the three. The symptom was not an error but a hub whose methods
/// were never invoked, so a caller saw a connection that accepted everything and answered nothing.
/// One registry both sides are handed has no cycle in it.
///
/// Keyed by peer name rather than connection id, deliberately: a peer that drops and reconnects gets
/// a new connection from SignalR, and a subscription tied to the old id would survive as a row that
/// can never be delivered to. The connection is looked up at delivery time instead.
/// </summary>
public sealed class SubscriptionTable
{
    private readonly ConcurrentDictionary<SubscriptionKey, byte> _subscriptions = new();

    /// <summary>
    /// Returns false when this peer was already subscribed, which is not an error.
    ///
    /// A client replaying its subscriptions after a reconnect must not end up receiving everything
    /// twice, so one peer's interest in one event is one row however many times it asks.
    /// </summary>
    public bool Add(string path, string ev, string peer) => _subscriptions.TryAdd(new SubscriptionKey(path, ev, peer), 0);

    /// <summary>Drop one subscription. False when the peer did not hold it, which is also not an error.</summary>
    public bool Remove(string path, string ev, string peer) => _subscriptions.TryRemove(new SubscriptionKey(path, ev, peer), out _);

    /// <summary>The peers watching one event.</summary>
    public IEnumerable<string> SubscribersOf(string path, string ev) =>
        _subscriptions.Keys.Where(key => key.Path == path && key.Event == ev).Select(key => key.Peer);

    /// <summary>How many subscriptions are held, for the gauge the hub publishes.</summary>
    public int Count => _subscriptions.Count;

    /// <summary>
    /// Drop everything a departing peer was watching. The peer going is the only signal there is -
    /// there is no frame for "I have stopped caring" that a peer which has left could send.
    /// </summary>
    public void RemovePeer(string peer)
    {
        foreach (var key in _subscriptions.Keys.Where(key => key.Peer == peer).ToList())
            _subscriptions.TryRemove(key, out _);
    }
}
