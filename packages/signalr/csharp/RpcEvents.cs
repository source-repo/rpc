using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace SourceRpc.SignalR;

/// <summary>
/// One peer's interest in one event of one instance.
///
/// Keyed by peer name rather than by connection id, deliberately: a peer that drops and reconnects
/// gets a new connection from SignalR, and a subscription tied to the old id would survive as a
/// row that can never be delivered to. The connection is looked up at delivery time instead, so a
/// reconnected subscriber keeps receiving without re-subscribing.
/// </summary>
public sealed record SubscriptionKey(string Path, string Event, string Peer);

/// <summary>
/// Who is subscribed to what. A singleton: it outlives any one hub instance, since ASP.NET Core
/// creates a <see cref="Hub"/> per invocation.
/// </summary>
public sealed class SubscriptionTable
{
    private readonly ConcurrentDictionary<SubscriptionKey, byte> _subscriptions = new();

    /// <summary>
    /// Returns false when this peer was already subscribed, which is not an error.
    ///
    /// A client replaying its subscriptions after a reconnect must not end up receiving every event
    /// twice, so one peer's interest in one event is one row however many times it asks. The caller
    /// uses the answer only to say which of the two happened.
    /// </summary>
    public bool Add(string path, string ev, string peer) => _subscriptions.TryAdd(new SubscriptionKey(path, ev, peer), 0);

    public bool Remove(string path, string ev, string peer) => _subscriptions.TryRemove(new SubscriptionKey(path, ev, peer), out _);

    public IEnumerable<string> SubscribersOf(string path, string ev) =>
        _subscriptions.Keys.Where(key => key.Path == path && key.Event == ev).Select(key => key.Peer);

    /// <summary>
    /// Drop everything a departing peer was watching.
    ///
    /// Without this a hub accumulates subscriptions for peers that will never come back, and every
    /// emission walks them. The peer going is the only signal there is - there is no frame for
    /// "I have stopped caring" other than an unsubscribe the peer is no longer around to send.
    /// </summary>
    public void RemovePeer(string peer)
    {
        foreach (var key in _subscriptions.Keys.Where(key => key.Peer == peer).ToList())
            _subscriptions.TryRemove(key, out _);
    }
}

/// <summary>
/// Publishes events to whoever subscribed. Inject it wherever something happens worth telling the
/// network about, and call <see cref="Emit"/>:
///
/// <code>
/// public sealed class BuildWatcher
/// {
///     private readonly RpcEvents _events;
///     public BuildWatcher(RpcEvents events) => _events = events;
///
///     private void OnBuildDone(bool succeeded) =>
///         _ = _events.Emit("solution", "built", succeeded);
/// }
/// </code>
///
/// Registered as a singleton alongside <see cref="SubscriptionTable"/> and <see cref="PeerTable"/>.
/// It takes <see cref="IHubContext{T}"/> rather than a <see cref="Hub"/>, because emitting happens
/// outside any hub invocation - a build finishing is not a client calling something - and a Hub
/// instance is only valid for the duration of one call.
/// </summary>
public sealed class RpcEvents
{
    private readonly IHubContext<RpcHub> _hub;
    private readonly SubscriptionTable _subscriptions;
    private readonly PeerTable _peers;
    private readonly RpcPeer _self;
    private readonly ConcurrentDictionary<string, long> _sequences = new();

    /// <summary>
    /// This process's incarnation. A sequence orders emissions within one run and says nothing
    /// across a restart, so a subscriber that sees a new epoch knows to treat its held cursor as
    /// unknowable rather than to subtract and get a plausible number.
    ///
    /// Regenerated per process, which is the point. Persisting it would be worse than useless: it
    /// would claim continuity across a restart that reset the counters.
    /// </summary>
    public string Epoch { get; } = Guid.NewGuid().ToString("N").Substring(0, 8);

    public RpcEvents(IHubContext<RpcHub> hub, SubscriptionTable subscriptions, PeerTable peers, RpcPeer self)
    {
        _hub = hub;
        _subscriptions = subscriptions;
        _peers = peers;
        _self = self;
    }

    /// <summary>
    /// One emission: counted, then delivered to every peer watching it.
    ///
    /// **Counted whether or not anyone is listening**, which is the whole point of the sequence. A
    /// counter that only advanced while somebody watched could never answer the question it exists
    /// for - a subscriber that joins, leaves and rejoins wants to know how many it missed, and a
    /// number that stood still while it was away cannot tell it.
    ///
    /// The count here runs from process start. The TypeScript server starts counting when an event
    /// is first tracked - at expose for a declared event, at first subscribe for an ad-hoc one -
    /// so this is the simpler promise and the stronger one, and a subscriber reads it the same way.
    /// </summary>
    public async Task Emit(string path, string ev, params object?[] args)
    {
        // NUL joins the two halves of the key because it cannot occur in an instance name or an
        // event name, so no choice of one can be made to collide with a different pair. Written as
        // the escape and never as the byte: a literal NUL makes this file binary to everything that
        // sniffs content, and the first thing that costs is grep, which then matches and silently
        // prints nothing. See the top of CLAUDE.md - it has happened twice in this repository.
        var seq = _sequences.AddOrUpdate(path + "\0" + ev, 1, (_, previous) => previous + 1);
        var body = JsonSerializer.SerializeToElement(args);

        foreach (var peer in _subscriptions.SubscribersOf(path, ev))
        {
            var connection = _peers.ConnectionFor(peer);
            // Subscribed but not currently reachable. Dropped rather than queued: this hub is not a
            // broker, and an event held for a peer that may never return is a leak with a delivery
            // guarantee nobody promised. The peer's next subscribe starts it counting again from
            // wherever the sequence has reached, which is how it learns what it missed.
            if (connection is null)
                continue;

            await _hub.Clients.Client(connection).SendAsync(
                "frame",
                new RpcFrame
                {
                    Src = _self.Name,
                    Tgt = peer,
                    Kind = "event",
                    Path = path,
                    Event = ev,
                    Seq = seq,
                    Epoch = Epoch,
                    // The emit arguments, and nothing else - an event has no correlation because
                    // nobody asked for this one in particular.
                    Body = body
                }
            );
        }
    }

    /// <summary>Where the count for one event has reached, for a caller that wants a cursor.</summary>
    public long SequenceOf(string path, string ev) => _sequences.TryGetValue(path + "\0" + ev, out var seq) ? seq : 0;
}
