using SourceRpc.Query;

namespace SourceRpc.Tests;

/// <summary>
/// The budget, and the pipeline built on it.
///
/// What is being tested is the arithmetic rather than Polly: that a deadline is a length of time the
/// caller declared for the whole question, and that every attempt is told what remains of it rather
/// than handed a fresh copy. Three attempts under a ten second timeout that each restart the clock
/// is a caller waiting thirty seconds having asked for ten - and, on a plant, a command still being
/// sent long after the person who ordered it stopped watching.
/// </summary>
public class ResilienceTests
{
    /// <summary>Backoffs at a millisecond, so the arithmetic is what is slow here and not the test.</summary>
    private static RpcResilienceOptions Quick(RpcMethodSemantics? semantics, int attempts = 2) =>
        new() { Semantics = semantics, Attempts = attempts, Backoff = TimeSpan.FromMilliseconds(1), BackoffCap = TimeSpan.FromMilliseconds(1) };

    private static SourceRpcException Rpc(RpcErrorCode code) => new(code, code.ToString());

    [Fact]
    public async Task Every_attempt_is_told_what_remains_rather_than_the_whole_budget()
    {
        var budget = new RpcCallBudget(TimeSpan.FromSeconds(5));
        var told = new List<TimeSpan>();

        await Assert.ThrowsAsync<SourceRpcException>(() => RpcResilience.ExecuteAsync<int>(
            budget,
            async (options, _) =>
            {
                told.Add(options.Timeout!.Value);
                await Task.Delay(30);
                throw Rpc(RpcErrorCode.TransportError);
            },
            Quick(RpcMethodSemantics.Query)));

        Assert.Equal(3, told.Count);
        Assert.True(told[0] <= TimeSpan.FromSeconds(5));
        Assert.True(told[1] < told[0], $"the second attempt was told {told[1]}, having started after {told[0]}");
        Assert.True(told[2] < told[1]);
    }

    [Fact]
    public async Task The_key_is_the_same_on_every_attempt_which_is_what_makes_a_retry_one_command()
    {
        var budget = new RpcCallBudget(TimeSpan.FromSeconds(5));
        var keys = new List<string?>();

        await Assert.ThrowsAsync<SourceRpcException>(() => RpcResilience.ExecuteAsync<int>(
            budget,
            (options, _) =>
            {
                keys.Add(options.IdempotencyKey);
                throw Rpc(RpcErrorCode.TransportError);
            },
            Quick(RpcMethodSemantics.IdempotentCommand),
            idempotencyKey: "work-order-7"));

        // Two attempts at a command that runs once, rather than two commands. Without this a peer
        // holding a durable store would run both.
        Assert.All(keys, key => Assert.Equal("work-order-7", key));
        Assert.Equal(3, keys.Count);
    }

    [Fact]
    public void A_budget_with_nothing_left_refuses_rather_than_sending_a_zero()
    {
        // `Timeout = 0` travels as *no deadline* on this wire, so a call with no time left would
        // become the one that may run for ever - the exact inversion of the rule it was keeping.
        var budget = new RpcCallBudget(TimeSpan.FromMilliseconds(20));
        Thread.Sleep(40);
        Assert.True(budget.Exhausted);
        var refused = Assert.Throws<SourceRpcException>(() => budget.Next());
        Assert.Equal(RpcErrorCode.Timeout, refused.Code);
    }

    [Fact]
    public void A_budget_is_a_length_of_time_and_zero_is_not_one()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new RpcCallBudget(TimeSpan.Zero));
    }

    [Fact]
    public async Task An_undeclared_method_is_not_retried_when_nobody_knows_what_it_did()
    {
        var tried = 0;
        await Assert.ThrowsAsync<SourceRpcException>(() => RpcResilience.ExecuteAsync<int>(
            new RpcCallBudget(TimeSpan.FromSeconds(5)),
            (_, _) => { tried++; throw Rpc(RpcErrorCode.UnknownOutcome); },
            Quick(null)));
        Assert.Equal(1, tried);
    }

    [Fact]
    public async Task A_command_the_transport_refused_is_retried_however_dangerous_it_is()
    {
        // It never left, so it has had no effect to repeat. Refusing to retry this would make the
        // safest possible failure the one that stops a plant.
        var tried = 0;
        await Assert.ThrowsAsync<SourceRpcException>(() => RpcResilience.ExecuteAsync<int>(
            new RpcCallBudget(TimeSpan.FromSeconds(5)),
            (_, _) => { tried++; throw Rpc(RpcErrorCode.TransportError); },
            Quick(RpcMethodSemantics.NonRepeatableCommand)));
        Assert.Equal(3, tried);
    }

    [Fact]
    public async Task A_refusal_is_never_retried_whatever_the_method_is()
    {
        var tried = 0;
        await Assert.ThrowsAsync<SourceRpcException>(() => RpcResilience.ExecuteAsync<int>(
            new RpcCallBudget(TimeSpan.FromSeconds(5)),
            (_, _) => { tried++; throw Rpc(RpcErrorCode.Forbidden); },
            Quick(RpcMethodSemantics.Query)));
        Assert.Equal(1, tried);
    }

    [Fact]
    public async Task A_read_that_comes_back_is_answered_rather_than_retried_to_exhaustion()
    {
        var tried = 0;
        var answer = await RpcResilience.ExecuteAsync(
            new RpcCallBudget(TimeSpan.FromSeconds(5)),
            (_, _) =>
            {
                tried++;
                if (tried < 3) throw Rpc(RpcErrorCode.UnknownOutcome);
                return Task.FromResult(180);
            },
            Quick(RpcMethodSemantics.Query));
        Assert.Equal(180, answer);
        Assert.Equal(3, tried);
    }

    [Fact]
    public async Task No_arrangement_of_retries_outlives_the_budget()
    {
        // The outer timeout is the caller's declaration and everything else happens inside it, which
        // is what makes "absolute across retries" a shape rather than a sentence in a comment.
        var budget = new RpcCallBudget(TimeSpan.FromMilliseconds(200));
        var began = DateTimeOffset.UtcNow;
        await Assert.ThrowsAnyAsync<Exception>(() => RpcResilience.ExecuteAsync<int>(
            budget,
            async (_, token) => { await Task.Delay(5000, token); return 0; },
            new RpcResilienceOptions { Semantics = RpcMethodSemantics.Query, Attempts = 20, Backoff = TimeSpan.FromMilliseconds(1), BackoffCap = TimeSpan.FromMilliseconds(1) }));
        Assert.True(DateTimeOffset.UtcNow - began < TimeSpan.FromSeconds(2), "the pipeline outlived the budget it was given");
    }
}
