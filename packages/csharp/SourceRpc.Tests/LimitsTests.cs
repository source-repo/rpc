using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// What this peer refuses to absorb.
///
/// Each of these was unbounded, which is the same as trusting the far end to be reasonable. The
/// hop limit is the one an ordinary network reaches first: two peers each relaying for the other
/// pass one frame between them for as long as the process lives, and nothing reports it.
/// </summary>
public class LimitsTests
{
    private sealed class Responder(Func<RpcInvocation, Task<object?>> handle) : ISourceRpcResponder
    {
        public async ValueTask<object?> InvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default) =>
            await handle(invocation);
    }

    private static RpcDispatcher Dispatcher(ISourceRpcResponder responder, RpcLimits? limits = null) =>
        new(new SourceRpcOptions { Name = "plant", Limits = limits ?? new RpcLimits(), AllowUnenforcedIdempotencyKeys = true },
            new SubscriptionTable(),
            new SourceRpcTelemetry(),
            responder);

    private static RpcCaller Caller() => new("hmi", null, CancellationToken.None, _ => Task.CompletedTask);

    private static RpcFrame Call(string method = "read") =>
        new() { Src = "hmi", Tgt = "plant", Kind = "call", Corr = "c-1", Path = "meter", Method = method, Body = Array.Empty<object?>() };

    [Fact]
    public async Task A_frame_that_has_been_relayed_too_many_times_is_refused()
    {
        var dispatcher = Dispatcher(new Responder(_ => Task.FromResult<object?>("ran")), new RpcLimits { MaxHops = 3 });

        var within = await dispatcher.HandleAsync(Call() with { Hops = 3 }, Caller());
        Assert.Equal("result", within!.Kind);

        // One more relay than this peer accepts. Without the ceiling a relay loop is invisible.
        var beyond = await dispatcher.HandleAsync(Call() with { Hops = 4 }, Caller());
        Assert.Equal("error", beyond!.Kind);
        Assert.Equal(nameof(RpcErrorCode.LimitExceeded), beyond.Code);
    }

    [Fact]
    public async Task A_batch_may_not_carry_a_batch()
    {
        var dispatcher = Dispatcher(new Responder(_ => Task.FromResult<object?>("ran")));
        var nested = new RpcFrame
        {
            Src = "hmi", Tgt = "plant", Kind = "batch",
            Batch = [new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "batch", Batch = [Call()] }]
        };

        var answer = await dispatcher.HandleAsync(nested, Caller());
        Assert.Equal(nameof(RpcErrorCode.LimitExceeded), answer!.Code);
    }

    [Fact]
    public async Task An_identifier_longer_than_anything_legitimate_is_refused()
    {
        var dispatcher = Dispatcher(new Responder(_ => Task.FromResult<object?>("ran")), new RpcLimits { MaxIdentifierLength = 32 });
        var answer = await dispatcher.HandleAsync(Call(new string('m', 33)), Caller());
        Assert.Equal(nameof(RpcErrorCode.LimitExceeded), answer!.Code);
    }

    /// <summary>
    /// Transports do not await dispatch, on purpose - a responder has to be able to call out and
    /// receive the reply. The cost is that a burst becomes as many concurrent invocations as
    /// arrive unless something here says no.
    /// </summary>
    [Fact]
    public async Task Beyond_the_concurrent_call_limit_a_call_is_refused_rather_than_queued()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var inside = 0;

        var dispatcher = Dispatcher(
            new Responder(async _ =>
            {
                if (Interlocked.Increment(ref inside) == 2)
                    entered.TrySetResult();
                await release.Task;
                return "ran";
            }),
            new RpcLimits { MaxConcurrentCalls = 2 });

        // Two calls take both slots and stay inside the responder.
        var first = dispatcher.HandleAsync(Call(), Caller());
        var second = dispatcher.HandleAsync(Call(), Caller());
        Assert.Same(entered.Task, await Task.WhenAny(entered.Task, Task.Delay(TimeSpan.FromSeconds(5))));

        var third = await dispatcher.HandleAsync(Call(), Caller());
        Assert.Equal("error", third!.Kind);
        Assert.Equal(nameof(RpcErrorCode.Busy), third.Code);

        // And the slot comes back, so this is a limit rather than a latch.
        release.SetResult();
        await Task.WhenAll(first, second);
        var after = await dispatcher.HandleAsync(Call(), Caller());
        Assert.Equal("result", after!.Kind);
    }
}
