using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// What an idempotency store must do when two attempts at one command arrive together.
///
/// These are here rather than in the TypeScript interop suite because the failure is a race inside
/// one process: two callers reaching <c>BeginAsync</c> before either has finished. Nothing driven
/// over a wire can hold two attempts at that exact point, which is why the defect survived a suite
/// that exercises every semantic this store is supposed to provide.
/// </summary>
public class IdempotencyTests
{
    /// <summary>
    /// The defect this file exists for.
    ///
    /// The store used to hold a null outcome to mean "claimed but still running". A second attempt
    /// found the key present, read the null, and could not tell it apart from "no record at all" -
    /// so it was told it owned the key and ran the command alongside the first. For a non-repeatable
    /// command that is two pump starts.
    /// </summary>
    [Fact]
    public async Task A_second_attempt_while_the_first_is_running_is_told_it_is_in_progress()
    {
        var store = new InMemoryIdempotencyStore();

        var first = await store.BeginAsync("dispense-1");
        Assert.IsType<RpcIdempotencyClaim.Acquired>(first);

        // The first attempt has not completed, so it is still running.
        var second = await store.BeginAsync("dispense-1");
        Assert.IsType<RpcIdempotencyClaim.InProgress>(second);
    }

    [Fact]
    public async Task Once_it_has_completed_a_retry_is_answered_from_the_record()
    {
        var store = new InMemoryIdempotencyStore();
        await store.BeginAsync("dispense-2");
        await store.CompleteAsync("dispense-2", new RpcOutcome(Failed: false, Value: "poured"));

        var claim = await store.BeginAsync("dispense-2");
        var completed = Assert.IsType<RpcIdempotencyClaim.Completed>(claim);
        Assert.Equal("poured", completed.Outcome.Value);
        Assert.False(completed.Outcome.Failed);
    }

    [Fact]
    public async Task A_failure_is_recorded_and_replayed_rather_than_run_again()
    {
        var store = new InMemoryIdempotencyStore();
        await store.BeginAsync("dispense-3");
        await store.CompleteAsync("dispense-3", new RpcOutcome(Failed: true, Code: "Forbidden", Message: "no"));

        var completed = Assert.IsType<RpcIdempotencyClaim.Completed>(await store.BeginAsync("dispense-3"));
        Assert.True(completed.Outcome.Failed);
        Assert.Equal("Forbidden", completed.Outcome.Code);
    }

    [Fact]
    public async Task An_abandoned_claim_can_be_taken_again()
    {
        var store = new InMemoryIdempotencyStore();
        Assert.IsType<RpcIdempotencyClaim.Acquired>(await store.BeginAsync("dispense-4"));
        await store.AbandonAsync("dispense-4");

        // Only ever done where the command certainly did not run - otherwise this is an invitation
        // to the second execution the store exists to prevent.
        Assert.IsType<RpcIdempotencyClaim.Acquired>(await store.BeginAsync("dispense-4"));
    }

    /// <summary>
    /// The same thing under real contention rather than in sequence, because the sequential test
    /// would still pass against a store that had a narrower window rather than none.
    /// </summary>
    [Fact]
    public async Task Exactly_one_of_many_simultaneous_attempts_acquires_the_key()
    {
        var store = new InMemoryIdempotencyStore();
        const int attempts = 64;
        using var gate = new SemaphoreSlim(0, attempts);

        var claims = Enumerable.Range(0, attempts).Select(async _ =>
        {
            await gate.WaitAsync();
            return await store.BeginAsync("start-pump");
        }).ToArray();

        // Released together, so they arrive at TryAdd at the same moment.
        gate.Release(attempts);
        var results = await Task.WhenAll(claims);

        Assert.Equal(1, results.Count(claim => claim is RpcIdempotencyClaim.Acquired));
        Assert.Equal(attempts - 1, results.Count(claim => claim is RpcIdempotencyClaim.InProgress));
        Assert.DoesNotContain(results, claim => claim is RpcIdempotencyClaim.Completed);
    }
}
