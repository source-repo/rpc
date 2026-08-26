using Polly;
using Polly.Retry;
using Polly.Timeout;

namespace SourceRpc.Query;

/// <summary>
/// How long a call may take, across every attempt at it.
///
/// **A budget the caller declared, not a per-attempt timeout**, and the difference is the whole
/// reason this type exists rather than a number. Three attempts under a "ten second timeout" that
/// each restart the clock is a caller waiting thirty seconds having asked for ten - and, on a plant,
/// a command still being sent long after the person who ordered it stopped watching.
///
/// It is one of the four things the library specifies once and implements twice, and it is the one
/// most easily lost in a policy library: every resilience engine offers a timeout per attempt, and
/// almost none offers what remains.
/// </summary>
public sealed class RpcCallBudget
{
    private readonly long _startedAt;

    /// <summary>Start a budget of this length, running from now.</summary>
    public RpcCallBudget(TimeSpan total, TimeProvider? time = null)
    {
        if (total <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(total), total, "a budget is a length of time; zero means no deadline, which is the absence of a budget rather than an empty one");
        Time = time ?? TimeProvider.System;
        Total = total;
        _startedAt = Time.GetTimestamp();
    }

    /// <summary>The clock this budget is measured against, so a test need not wait out a real one.</summary>
    public TimeProvider Time { get; }

    /// <summary>The whole budget, as declared.</summary>
    public TimeSpan Total { get; }

    /// <summary>
    /// What is left of it. Never negative: a budget that has run out has nothing left rather than a
    /// negative amount, and a caller reading this as a timeout must not be handed one that reads as
    /// "no deadline".
    /// </summary>
    public TimeSpan Remaining
    {
        get
        {
            var left = Total - Time.GetElapsedTime(_startedAt);
            return left > TimeSpan.Zero ? left : TimeSpan.Zero;
        }
    }

    /// <summary>Whether there is anything left to spend.</summary>
    public bool Exhausted => Remaining <= TimeSpan.Zero;

    /// <summary>
    /// The options to put on the next attempt, carrying what remains as its deadline.
    ///
    /// The remaining budget travels as the ttl, so the far end is told what this caller is actually
    /// going to wait and can refuse work that is already too late rather than doing it for nobody.
    /// The idempotency key is carried unchanged, which is what makes the attempt an attempt rather
    /// than a second command.
    /// </summary>
    public RpcCallOptions Next(string? idempotencyKey = null, string? ownerFence = null)
    {
        var left = Remaining;
        if (left <= TimeSpan.Zero)
            // Refused rather than sent with what is left of nothing. A zero here would travel as *no
            // deadline* on this wire, so the call with no time left would become the one that may run
            // for ever - the exact inversion of the rule it was keeping.
            throw new SourceRpcException(RpcErrorCode.Timeout, "the deadline for this call passed before it could be issued");
        return new RpcCallOptions { Timeout = left, IdempotencyKey = idempotencyKey, OwnerFence = ownerFence };
    }
}

/// <summary>How a pipeline should behave for one call.</summary>
public sealed record RpcResilienceOptions
{
    /// <summary>
    /// What the caller says the method does. **Absent means nothing is retried**, which is the safe
    /// reading: undeclared means undeclared, and anything else means the first caller who forgets it
    /// gets automatic retries on `Dispense()`.
    /// </summary>
    public RpcMethodSemantics? Semantics { get; init; }

    /// <summary>Attempts beyond the first, for a call that may be sent again at all.</summary>
    public int Attempts { get; init; } = 2;

    /// <summary>
    /// The first backoff, doubling from there. A second is already close to the floor on a link with
    /// a multi-second round trip, which is the link this library was written for.
    /// </summary>
    public TimeSpan Backoff { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>The longest a retry waits, whatever the backoff worked out to.</summary>
    public TimeSpan BackoffCap { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// A Polly pipeline that knows what this library's failures mean.
///
/// **The two defaults a resilience library has that are wrong here**, and neither is a flaw in Polly
/// - both are right for the thing it was built for, and wrong for the same reason: this library
/// refuses to guess what a call does.
///
/// A generic `ShouldHandle` retries on failure. Here `TransportError` - certainly did not run - is
/// retryable and `UnknownOutcome` must never be for a command, because it is precisely the one a
/// person goes and looks at. A predicate treating them alike turns the library's headline
/// distinction back into a spinner.
///
/// And a generic timeout bounds an attempt. Here the caller declared a budget, so the pipeline
/// carries an **outer** total timeout with the per-attempt deadline computed from what remains -
/// which makes "the deadline is absolute across retries" a shape in a type rather than a sentence in
/// a comment.
/// </summary>
public static class RpcResilience
{
    /// <summary>
    /// Build a pipeline for one call.
    ///
    /// The outer timeout is the budget; the retry sits inside it, so a caller that declared ten
    /// seconds waits ten however many attempts fit. What each attempt tells the *far end* is not
    /// this pipeline's to set - that is <see cref="RpcCallBudget.Next"/>, which the callback asks
    /// for - because the ttl on the wire has to be what remains rather than what was declared.
    /// </summary>
    public static ResiliencePipeline PipelineFor(RpcCallBudget budget, RpcResilienceOptions? options = null)
    {
        var settings = options ?? new RpcResilienceOptions();
        var builder = new ResiliencePipelineBuilder { TimeProvider = budget.Time };
        // Outermost, deliberately: everything below it happens inside the caller's declared budget,
        // so no arrangement of retries and backoffs can outlive it.
        builder.AddTimeout(new TimeoutStrategyOptions { Timeout = budget.Total });
        builder.AddRetry(new RetryStrategyOptions
        {
            MaxRetryAttempts = Math.Max(0, settings.Attempts),
            Delay = settings.Backoff,
            MaxDelay = settings.BackoffCap,
            BackoffType = DelayBackoffType.Exponential,
            UseJitter = true,
            ShouldHandle = arguments => ValueTask.FromResult(
                // Not `budget.Exhausted` as a separate clause: the outer timeout has already
                // cancelled by then, and a retry decision made after cancellation would be a wait
                // nobody is left to benefit from.
                arguments.Outcome.Exception is { } failure && RpcOutcomes.MayRetry(failure, settings.Semantics))
        });
        return builder.Build();
    }

    /// <summary>
    /// Run one call under a budget, with the remaining time on every attempt.
    ///
    /// The shape a caller wants, since the interesting arithmetic is in what each attempt is *told*
    /// rather than in when the pipeline gives up: `attempt` is handed the options for this go, with
    /// the ttl set to what is left and the idempotency key unchanged - so a peer holding a durable
    /// store answers the second attempt from the first's record rather than running it twice.
    /// </summary>
    public static async Task<T> ExecuteAsync<T>(
        RpcCallBudget budget,
        Func<RpcCallOptions, CancellationToken, Task<T>> attempt,
        RpcResilienceOptions? options = null,
        string? idempotencyKey = null,
        string? ownerFence = null,
        CancellationToken cancellationToken = default)
    {
        var pipeline = PipelineFor(budget, options);
        return await pipeline.ExecuteAsync(
            async token => await attempt(budget.Next(idempotencyKey, ownerFence), token),
            cancellationToken);
    }
}
