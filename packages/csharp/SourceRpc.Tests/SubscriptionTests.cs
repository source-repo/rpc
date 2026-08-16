using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// What a client owes its own subscribers.
///
/// All three of these were wrong, and none of them could be seen from the far end: the far end was
/// told something perfectly reasonable each time. They are visible only from inside the client,
/// which is why they needed a transport that goes nowhere.
/// </summary>
public class SubscriptionTests
{
    private static (SourceRpcClient Client, FakeTransport Transport) Peer()
    {
        var options = new SourceRpcOptions { Name = "hmi", CallTimeout = TimeSpan.FromSeconds(5) };
        var transport = new FakeTransport("hmi");
        return (new SourceRpcClient(transport, options, new SourceRpcTelemetry()), transport);
    }

    private static RpcFrame Event(string path, string name, params object?[] args) =>
        new() { Src = "plant", Tgt = "hmi", Kind = "event", Path = path, Event = name, Body = args };

    [Fact]
    public async Task Two_handlers_take_one_remote_subscription()
    {
        var (client, transport) = Peer();
        await using var first = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });
        await using var second = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });

        // The far end deduplicates by peer name, so a second request is harmless - but it is also
        // pointless, and sending it means the client does not know what it holds.
        Assert.Single(transport.SentOfKind("subscribe"));
    }

    /// <summary>
    /// The defect: disposing either subscription told the far end to stop sending, so the handler
    /// that was still listening went quiet. Nothing reported anything - from outside, a peer that
    /// unsubscribed and a peer whose events stopped look identical.
    /// </summary>
    [Fact]
    public async Task Disposing_one_of_two_handlers_leaves_the_other_receiving()
    {
        var (client, transport) = Peer();
        var heard = new List<string>();

        var first = await client.SubscribeAsync("plant", "machine", "alarm", _ => heard.Add("first"));
        await client.SubscribeAsync("plant", "machine", "alarm", _ => heard.Add("second"));

        await first.DisposeAsync();

        // The far end must not have been told to stop: somebody here is still listening.
        Assert.Empty(transport.SentOfKind("unsubscribe"));

        await transport.Receive(Event("machine", "alarm", 1));
        Assert.Equal(["second"], heard);
    }

    [Fact]
    public async Task The_last_handler_leaving_does_tell_the_far_end_to_stop()
    {
        var (client, transport) = Peer();
        var first = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });
        var second = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });

        await first.DisposeAsync();
        await second.DisposeAsync();

        // Exactly one, and only once the last listener has gone. Leaving the far end sending is a
        // cost somebody else pays.
        Assert.Single(transport.SentOfKind("unsubscribe"));
    }

    /// <summary>
    /// An event emitted the instant the far end acknowledges used to be dropped: the handler was
    /// registered only after the acknowledgement came back, and on a fast link the event beat it.
    /// </summary>
    [Fact]
    public async Task An_event_arriving_during_the_subscribe_is_not_lost()
    {
        var (client, transport) = Peer();
        var heard = new List<object?[]>();

        // Emitted from inside the handler registration path: the frame is delivered while
        // SubscribeAsync is still waiting for its acknowledgement.
        var subscribing = client.SubscribeAsync("plant", "machine", "alarm", args => heard.Add(args));
        await transport.Receive(Event("machine", "alarm", 42));
        await using var subscription = await subscribing;

        Assert.Single(heard);
    }

    /// <summary>
    /// A peer's subscriptions live on its connection at the far end. After a reconnect that end has
    /// never met this peer, so anything not taken out again is simply gone - and the client looks
    /// perfectly healthy while receiving nothing for ever.
    /// </summary>
    [Fact]
    public async Task Subscriptions_are_taken_out_again_when_the_link_comes_back()
    {
        var (client, transport) = Peer();
        await using var subscription = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });
        Assert.Single(transport.SentOfKind("subscribe"));

        await transport.Reconnect();

        var subscribes = transport.SentOfKind("subscribe");
        Assert.Equal(2, subscribes.Count);
        Assert.Equal("machine", subscribes[1].Path);
        Assert.Equal("plant", subscribes[1].Tgt);
    }

    [Fact]
    public async Task A_disposed_subscription_is_not_taken_out_again_after_a_reconnect()
    {
        var (client, transport) = Peer();
        var subscription = await client.SubscribeAsync("plant", "machine", "alarm", _ => { });
        await subscription.DisposeAsync();

        await transport.Reconnect();

        // One from the original subscribe and nothing since: replaying a subscription the
        // application has let go would resurrect events nobody is listening for.
        Assert.Single(transport.SentOfKind("subscribe"));
    }
}
