using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// Who a name currently belongs to, and what happens when it changes hands.
///
/// A peer reconnecting takes its own name back, which is deliberate. The hazard is that the old
/// connection's teardown is usually still running when it does, and a teardown that removes by name
/// alone deletes the route the new connection has just installed.
/// </summary>
public class RoutingTests
{
    [Fact]
    public void A_peer_that_reconnected_keeps_the_route_its_old_connection_is_still_tearing_down()
    {
        var router = new RpcRouter();
        router.Announce("plc-1", "connection-1", null);

        // The peer comes back on a new connection and takes its name over, which is what should
        // happen: the old link is gone and the new one is how the peer is now reached.
        router.Announce("plc-1", "connection-2", null);

        // The old connection's teardown arrives afterwards, as it does in practice - a dropped
        // socket is noticed on its own schedule.
        var gone = router.Remove("connection-1");

        // Nothing was removed, because nothing there still belonged to connection-1. Reporting a
        // name here would announce a perfectly connected peer offline and drop its subscriptions.
        Assert.Empty(gone);
        Assert.True(router.MayOriginate("connection-2", "plc-1"));
    }

    [Fact]
    public void A_connection_that_leaves_without_being_replaced_does_report_its_peer_gone()
    {
        var router = new RpcRouter();
        router.Announce("plc-1", "connection-1", null);

        var gone = router.Remove("connection-1");

        Assert.Equal(["plc-1"], gone);
        Assert.False(router.MayOriginate("connection-1", "plc-1"));
    }

    /// <summary>
    /// The race itself, which the sequential test above cannot reach.
    ///
    /// Once the new connection has announced, the departing connection no longer *matches* the
    /// route, so a teardown that runs afterwards leaves it alone either way. The hazard is the
    /// interleaving: the teardown reads the routes, the reconnect replaces one of them, and the
    /// teardown then removes what it read. Only running the two concurrently reaches it.
    /// </summary>
    [Fact]
    public async Task A_reconnect_racing_a_teardown_never_loses_the_new_route()
    {
        for (var attempt = 0; attempt < 2000; attempt++)
        {
            var router = new RpcRouter();
            router.Announce("plc-1", "connection-1", null);

            using var start = new Barrier(2);
            var teardown = Task.Run(() =>
            {
                start.SignalAndWait();
                router.Remove("connection-1");
            });
            var reconnect = Task.Run(() =>
            {
                start.SignalAndWait();
                router.Announce("plc-1", "connection-2", null);
            });
            await Task.WhenAll(teardown, reconnect);

            // The peer is connected on connection-2 whatever order those landed in. Losing this is
            // a peer that is up, announced offline, and unreachable until it reconnects again.
            Assert.True(router.MayOriginate("connection-2", "plc-1"), $"the route was lost on attempt {attempt}");
        }
    }

    [Fact]
    public void A_frame_naming_a_peer_the_connection_does_not_hold_is_refused()
    {
        var router = new RpcRouter();
        router.Announce("plc-1", "connection-1", null);
        router.Announce("hmi", "connection-2", null);

        // The check the whole router exists for: a name is a claim until the route says otherwise.
        Assert.True(router.MayOriginate("connection-1", "plc-1"));
        Assert.False(router.MayOriginate("connection-2", "plc-1"));
    }
}
