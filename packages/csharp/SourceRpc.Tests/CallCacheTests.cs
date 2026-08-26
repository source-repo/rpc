using SourceRpc.Query;
using ZiggyCreatures.Caching.Fusion;

namespace SourceRpc.Tests;

/// <summary>
/// The cache half.
///
/// What is asserted is the behaviour this library needs rather than FusionCache's own surface - but
/// two of these are worth having precisely *because* they are somebody else's implementation of a
/// rule this repository had already written down for itself, which is the strongest reason to take a
/// dependency rather than the weakest.
/// </summary>
public class CallCacheTests
{
    private static RpcQuestion Readings(int page = 0) => new("oven3", "plant", "readings", new { page, size = 50 });

    [Fact]
    public async Task Two_callers_asking_at_once_ask_once()
    {
        var cache = RpcCallCache.Create();
        var asked = 0;
        async Task<int> Ask(CancellationToken _)
        {
            Interlocked.Increment(ref asked);
            await Task.Delay(50);
            return 180;
        }

        var both = await Task.WhenAll(
            cache.GetOrAskAsync(Readings(), Ask).AsTask(),
            cache.GetOrAskAsync(Readings(), Ask).AsTask());

        Assert.Equal([180, 180], both);
        Assert.Equal(1, asked);
    }

    [Fact]
    public async Task A_different_page_is_a_different_question()
    {
        var cache = RpcCallCache.Create();
        var asked = 0;
        Task<int> Ask(CancellationToken _) => Task.FromResult(Interlocked.Increment(ref asked));

        Assert.Equal(1, await cache.GetOrAskAsync(Readings(0), Ask));
        Assert.Equal(2, await cache.GetOrAskAsync(Readings(1), Ask));
        Assert.Equal(1, await cache.GetOrAskAsync(Readings(0), Ask));
    }

    [Fact]
    public async Task What_came_from_a_peer_can_be_forgotten_in_one_operation()
    {
        // A peer that went away, or came back new, invalidates everything it said. By tag rather
        // than by walking the entries, because a walk is a walk.
        var cache = RpcCallCache.Create();
        var asked = 0;
        Task<int> Ask(CancellationToken _) => Task.FromResult(Interlocked.Increment(ref asked));

        await cache.GetOrAskAsync(Readings(0), Ask);
        await cache.GetOrAskAsync(new RpcQuestion("oven4", "plant", "readings", new { page = 0 }), Ask);
        await cache.ForgetPeerAsync("oven3");

        Assert.Equal(3, await cache.GetOrAskAsync(Readings(0), Ask));
        Assert.Equal(2, await cache.GetOrAskAsync(new RpcQuestion("oven4", "plant", "readings", new { page = 0 }), Ask));
    }

    [Fact]
    public async Task A_settled_command_narrows_to_the_instance_it_touched()
    {
        var cache = RpcCallCache.Create();
        var asked = 0;
        Task<int> Ask(CancellationToken _) => Task.FromResult(Interlocked.Increment(ref asked));

        await cache.GetOrAskAsync(Readings(0), Ask);
        await cache.GetOrAskAsync(new RpcQuestion("oven3", "alarms", "current", null), Ask);
        await cache.ForgetAsync("oven3", "plant");

        Assert.Equal(3, await cache.GetOrAskAsync(Readings(0), Ask));
        Assert.Equal(2, await cache.GetOrAskAsync(new RpcQuestion("oven3", "alarms", "current", null), Ask));
    }

    [Fact]
    public async Task A_failure_annotates_the_previous_answer_rather_than_clearing_it()
    {
        // Fail-safe, which is the rule the console's polling loop already had written down before
        // this dependency was chosen: a link that dropped is not a collection that emptied, and
        // drawing it as one is a lie an operator cannot see through. Last known beats a blank.
        var cache = RpcCallCache.Create();
        var options = new FusionCacheEntryOptions
        {
            Duration = TimeSpan.FromMilliseconds(50),
            IsFailSafeEnabled = true,
            FailSafeMaxDuration = TimeSpan.FromMinutes(5),
            FailSafeThrottleDuration = TimeSpan.FromMilliseconds(10)
        };
        var alive = true;
        Task<int> Ask(CancellationToken _) => alive ? Task.FromResult(180) : throw new SourceRpcException(RpcErrorCode.TransportError, "the link went");

        Assert.Equal(180, await cache.GetOrAskAsync(Readings(), Ask, options));
        alive = false;
        await Task.Delay(120);

        Assert.Equal(180, await cache.GetOrAskAsync(Readings(), Ask, options));
    }
}
