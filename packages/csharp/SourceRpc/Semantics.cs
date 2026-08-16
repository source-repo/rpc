namespace SourceRpc;

/// <summary>
/// What this process records about who owns an instance, so an owner fence can be checked.
///
/// Register one and fenced calls are enforced; register none and they are refused, which is the
/// same answer the TypeScript server gives for an instance it holds no record of. That is not
/// pedantry: **a fence is checked by being present**, so a peer that accepted one it could not
/// verify would be telling the caller its command had been guarded when nothing had guarded it.
/// Failing closed is the only honest answer to "I cannot check this".
/// </summary>
public interface IRpcOwnership
{
    /// <summary>
    /// The owner generation recorded for an instance, or null when none is.
    ///
    /// A generation changes whenever ownership is reassigned - it is not the owner's name but a
    /// value that is different every time, so that a command issued under the old owner cannot be
    /// mistaken for one issued under the new.
    /// </summary>
    string? OwnerEpochOf(string path);
}

/// <summary>What a command did, recorded so that a second attempt at it does not do it again.</summary>
/// <param name="Failed">Whether the recorded outcome was an error.</param>
/// <param name="Value">What the method returned, when it succeeded.</param>
/// <param name="Code">The error code, when it failed.</param>
/// <param name="Message">The error message, when it failed.</param>
public sealed record RpcOutcome(bool Failed, object? Value = null, string? Code = null, string? Message = null);

/// <summary>
/// Where the outcomes of non-repeatable commands are kept, so that a retry is answered rather than
/// re-executed.
///
/// The store is the whole mechanism, and two of its properties are what make it worth having:
///
/// - **The outcome is written before the answer goes out.** A crash between running and recording
///   would leave a command that ran and can be run again, which is the failure this exists to
///   prevent - so the record is the commit point, not the reply.
/// - **A store that cannot be reached refuses the command.** Failing open would mean the one
///   condition under which double execution is possible is also the condition under which nothing
///   is checking for it. `dispense()` twice is worse than `dispense()` never.
///
/// Implement it over whatever is already durable where the process runs - a table, a file, a Redis.
/// The keys are caller-chosen strings and should be scoped by the calling peer if two callers might
/// choose the same one.
/// </summary>
public interface IRpcIdempotencyStore
{
    /// <summary>
    /// Claim a key before running, or return the outcome already recorded for it.
    ///
    /// Null means this attempt owns the command and should run it. Non-null means somebody already
    /// did, and the caller should be answered from the record without running anything.
    /// </summary>
    Task<RpcOutcome?> BeginAsync(string key, CancellationToken cancellationToken = default);

    /// <summary>Record what the command did. Called before the caller is answered.</summary>
    Task CompleteAsync(string key, RpcOutcome outcome, CancellationToken cancellationToken = default);
}

/// <summary>
/// An in-memory idempotency store, for a process whose commands do not need to survive it.
///
/// Honest about what it is: a restart forgets every outcome, so a retry that spans one runs the
/// command again. That is the right trade for a host whose commands are cheap to repeat and the
/// wrong one for a host that dispenses, advances a batch or starts a pump - those want something
/// durable, which is why this is a class you must choose rather than the default.
/// </summary>
public sealed class InMemoryIdempotencyStore : IRpcIdempotencyStore
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, RpcOutcome?> _outcomes = new();

    /// <inheritdoc/>
    public Task<RpcOutcome?> BeginAsync(string key, CancellationToken cancellationToken = default)
    {
        // TryAdd rather than a read then a write: two attempts at one command arriving together must
        // not both find it absent and both decide to run it.
        if (_outcomes.TryAdd(key, null))
            return Task.FromResult<RpcOutcome?>(null);
        return Task.FromResult(_outcomes.TryGetValue(key, out var outcome) ? outcome : null);
    }

    /// <inheritdoc/>
    public Task CompleteAsync(string key, RpcOutcome outcome, CancellationToken cancellationToken = default)
    {
        _outcomes[key] = outcome;
        return Task.CompletedTask;
    }
}
