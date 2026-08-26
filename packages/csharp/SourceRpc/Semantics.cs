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
    /// Claim the right to run a command, or learn that somebody else has it.
    ///
    /// Three answers, and the middle one is the reason this is not a nullable outcome. A store that
    /// can only say "here is the record" or "there is none" cannot distinguish *nobody has run this*
    /// from *somebody is running it right now* - so two attempts arriving together both read the
    /// absence of a record and both execute, which is the exact failure the store exists to prevent.
    /// </summary>
    Task<RpcIdempotencyClaim> BeginAsync(string key, CancellationToken cancellationToken = default);

    /// <summary>Record what the command did. Called before the caller is answered.</summary>
    Task CompleteAsync(string key, RpcOutcome outcome, CancellationToken cancellationToken = default);

    /// <summary>
    /// Release a claim that will never complete, so an attempt that died does not hold the key for
    /// ever. Only safe where the command certainly did not run - anything else should be recorded
    /// as an outcome rather than released, because releasing invites the second execution.
    /// </summary>
    Task AbandonAsync(string key, CancellationToken cancellationToken = default) => Task.CompletedTask;
}

/// <summary>
/// What a store says about a key: run it, wait for whoever is running it, or here is what it did.
///
/// Mirrors the TypeScript store's `'acquired' | 'in-progress' | StoredRpcOutcome`, deliberately -
/// one normative rule in two languages rather than two implementations that agree until they do not.
/// </summary>
public abstract record RpcIdempotencyClaim
{
    private RpcIdempotencyClaim() { }

    /// <summary>Nobody else holds this key. Run the command, then record the outcome.</summary>
    public sealed record Acquired : RpcIdempotencyClaim
    {
        public static readonly Acquired Instance = new();
    }

    /// <summary>Another attempt at this same command is running now. Do not run a second one.</summary>
    public sealed record InProgress : RpcIdempotencyClaim
    {
        public static readonly InProgress Instance = new();
    }

    /// <summary>It already ran, and this is what it answered.</summary>
    public sealed record Completed(RpcOutcome Outcome) : RpcIdempotencyClaim;
}

public sealed class InMemoryIdempotencyStore : IRpcIdempotencyStore
{
    /// <summary>
    /// A claimed key with no outcome yet is *running*, which is a state the map has to be able to
    /// hold. Storing a null outcome for it could not: a second attempt found the key present, read
    /// the null, and could not tell it apart from "no record", so it ran the command too.
    /// </summary>
    private sealed record Entry(RpcOutcome? Outcome);

    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Entry> _entries = new();

    /// <inheritdoc/>
    public Task<RpcIdempotencyClaim> BeginAsync(string key, CancellationToken cancellationToken = default)
    {
        var running = new Entry(null);
        // TryAdd rather than a read then a write: two attempts at one command arriving together must
        // not both find it absent and both decide to run it.
        if (_entries.TryAdd(key, running))
            return Task.FromResult<RpcIdempotencyClaim>(RpcIdempotencyClaim.Acquired.Instance);

        return Task.FromResult<RpcIdempotencyClaim>(
            _entries.TryGetValue(key, out var entry) && entry.Outcome is { } outcome
                ? new RpcIdempotencyClaim.Completed(outcome)
                // Present but not finished: somebody is running it. Answering "acquired" here is
                // what let a duplicate execute alongside the original.
                : RpcIdempotencyClaim.InProgress.Instance);
    }

    /// <inheritdoc/>
    public Task CompleteAsync(string key, RpcOutcome outcome, CancellationToken cancellationToken = default)
    {
        _entries[key] = new Entry(outcome);
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public Task AbandonAsync(string key, CancellationToken cancellationToken = default)
    {
        // Only ever called where the command certainly did not run, so the key becomes claimable
        // again rather than locked for the life of the process.
        _entries.TryRemove(key, out _);
        return Task.CompletedTask;
    }
}
