namespace SourceRpc.Continuity;

/// <summary>
/// What the successor says it can do with what the old activation was holding.
///
/// A port of `Restore.ts`, and the rule it exists to keep is the same in both languages: the
/// manifest is an *observed fact* and a declaration is a *reviewed policy*, and one may never stand
/// in for the other. A runtime that let the first substitute for the second would be inventing plant
/// behaviour at the moment it is least able to be checked.
///
/// It matters more here than it did in one language. A .NET revision taking over from a TypeScript
/// one has no compiler in common with it: what it knows about the incumbent's obligations is what
/// the snapshot says, and every disposition it claims is a claim rather than something a type
/// checker agreed to.
/// </summary>
public enum RpcResolution
{
    /// <summary>The successor holds the same obligation, unchanged.</summary>
    Assumed,

    /// <summary>It holds an equivalent one, and something observable differs.</summary>
    Reestablished,

    /// <summary>It was discharged during the handoff.</summary>
    Completed,

    /// <summary>It could not be, and whoever is owed the result is told.</summary>
    Failed,

    /// <summary>Nobody can, and the handoff does not happen.</summary>
    Unhonourable
}

/// <summary>One thing the successor says about one obligation.</summary>
public sealed record RpcRestoreDeclaration
{
    public required string Id { get; init; }
    public required RpcResolution Resolution { get; init; }

    /// <summary>Required for a timer or a watchdog. There is no default, deliberately.</summary>
    public RpcTimerPolicy? TimerPolicy { get; init; }

    /// <summary>Required to re-establish a subscription: what the transport will actually do to it.</summary>
    public RpcRedelivery? Redelivery { get; init; }
}

public sealed record RpcRestorePlanEntry
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required RpcResolution Resolution { get; init; }

    /// <summary>Why, in the words somebody reviewing a handoff has to read.</summary>
    public required string Why { get; init; }

    public RpcTimerPolicy? TimerPolicy { get; init; }
    public RpcRedelivery? Redelivery { get; init; }
}

public sealed record RpcRestorePlan
{
    public required bool Admissible { get; init; }
    public string? Why { get; init; }
    public IReadOnlyList<RpcRestorePlanEntry> Entries { get; init; } = [];
}

/// <summary>The clock a timer is measured against, supplied so a plan can be made deterministically.</summary>
public sealed record RpcRestoreClock
{
    public required long Now { get; init; }
}

public static class RpcRestore
{
    /// <summary>
    /// Pair every obligation with what the successor declares about it, and refuse on the first one
    /// nobody can honour.
    ///
    /// Refusing on the first rather than reporting every failure is deliberate: a partial plan reads
    /// as progress, and the one thing a handoff must not do is proceed having quietly not resolved
    /// something.
    /// </summary>
    public static RpcRestorePlan Plan(RpcSnapshotEnvelope snapshot, IReadOnlyList<RpcRestoreDeclaration> declarations, RpcRestoreClock clock)
    {
        var obligations = snapshot.Obligations;
        if (obligations is null)
            return new RpcRestorePlan { Admissible = false, Why = $"{snapshot.SnapshotId} carries no obligations manifest, so nothing is known about the work the old activation still owed" };

        var declared = declarations.ToDictionary(one => one.Id);
        var entries = new List<RpcRestorePlanEntry>();
        foreach (var (id, kind, decide) in Each(obligations))
        {
            if (!declared.TryGetValue(id, out var declaration))
            {
                // Silence is not consent. A revision that has never heard of this cannot be said to
                // have preserved it, and a handoff that treated an unmentioned timer as carried
                // across would hand a plant to a program that does not know it holds a deadline.
                var entry = new RpcRestorePlanEntry
                {
                    Id = id,
                    Kind = kind,
                    Resolution = RpcResolution.Unhonourable,
                    Why = $"the successor declares nothing about it; silence is not a claim"
                };
                entries.Add(entry);
                return new RpcRestorePlan { Admissible = false, Why = $"{id} ({kind}): {entry.Why}", Entries = entries };
            }
            var resolved = decide(declaration, clock);
            entries.Add(resolved);
            if (resolved.Resolution == RpcResolution.Unhonourable) return new RpcRestorePlan { Admissible = false, Why = $"{id} ({kind}): {resolved.Why}", Entries = entries };
        }
        return new RpcRestorePlan { Admissible = true, Entries = entries };
    }

    /// <summary>
    /// Prove a plan again against the snapshot actually taken at the barrier.
    ///
    /// The earlier pass ran against whatever was current when preparation started. A component that
    /// took on work in between, or finished something, is owed a different set of things - and the
    /// moment before a cutover is the worst possible time to discover it.
    /// </summary>
    public static (bool Agreed, string? Why) ValidateAtBarrier(RpcSnapshotEnvelope atBarrier, IReadOnlyList<RpcRestoreDeclaration> declarations, RpcRestoreClock clock, RpcRestorePlan earlier)
    {
        var now = Plan(atBarrier, declarations, clock);
        if (!now.Admissible) return (false, now.Why);
        var before = earlier.Entries.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
        var after = now.Entries.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
        var arrived = after.Except(before).ToList();
        if (arrived.Count > 0) return (false, $"{string.Join(", ", arrived)} took on work while the handoff was being prepared, and the plan proved earlier says nothing about it");
        var gone = before.Except(after).ToList();
        if (gone.Count > 0) return (false, $"{string.Join(", ", gone)} finished while the handoff was being prepared, so the successor is owed a different set of things than the plan proved earlier");
        return (true, null);
    }

    private static IEnumerable<(string Id, string Kind, Func<RpcRestoreDeclaration, RpcRestoreClock, RpcRestorePlanEntry> Decide)> Each(RpcObligations obligations)
    {
        foreach (var one in obligations.Timers) yield return (one.Id, "timer", (declaration, clock) => Timer(one.Id, "timer", one.DueAt, declaration, clock));
        foreach (var one in obligations.Watchdogs) yield return (one.Id, "watchdog", (declaration, clock) => Timer(one.Id, "watchdog", one.DueAt, declaration, clock));
        foreach (var one in obligations.OutboundCalls) yield return (one.Id, "outbound-call", (declaration, _) => Simple(one.Id, "outbound-call", declaration));
        foreach (var one in obligations.InboundWork) yield return (one.Id, "inbound-work", (declaration, _) => Simple(one.Id, "inbound-work", declaration));
        foreach (var one in obligations.Subscriptions) yield return (one.Id, "subscription", (declaration, _) => Subscription(one.Id, declaration));
        foreach (var one in obligations.PendingPublications) yield return (one.Id, "publication", (declaration, _) => Simple(one.Id, "publication", declaration));
        foreach (var one in obligations.Leases) yield return (one.Id, "lease", (declaration, _) => Lease(one, declaration));
        foreach (var one in obligations.Sequences) yield return (one.Id, "sequence", (declaration, _) => Simple(one.Id, "sequence", declaration));
    }

    private static RpcRestorePlanEntry Timer(string id, string kind, long dueAt, RpcRestoreDeclaration declaration, RpcRestoreClock clock)
    {
        if (declaration.TimerPolicy is null)
            return new RpcRestorePlanEntry
            {
                Id = id,
                Kind = kind,
                Resolution = RpcResolution.Unhonourable,
                // No default, because every policy is right for something and catastrophic for
                // something else, and nobody can pick without knowing what this timer is for.
                Why = "no restore policy was declared for it, and there is no default: a dwell that restarts has doubled a bake, and a watchdog that preserved its deadline fires the instant the successor comes up"
            };
        var overdue = dueAt <= clock.Now;
        var policy = declaration.TimerPolicy.Value;
        return policy switch
        {
            RpcTimerPolicy.PreserveRemaining => Entry(id, kind, RpcResolution.Assumed, "the handoff is not counted against it: it fires after the time it had left", policy),
            RpcTimerPolicy.PreserveDeadline when overdue =>
                Entry(id, kind, RpcResolution.Failed, "its deadline passed during the handoff and it preserves deadlines, so it is delivered late rather than silently dropped - a deadline that was real is a fact somebody is owed", policy),
            RpcTimerPolicy.PreserveDeadline => Entry(id, kind, RpcResolution.Assumed, "it fires when it would have fired", policy),
            RpcTimerPolicy.Restart => Entry(id, kind, RpcResolution.Reestablished, "it begins its declared duration again, which is observably not the timer that was running", policy),
            RpcTimerPolicy.FireOnActivation => Entry(id, kind, RpcResolution.Reestablished, "it is delivered as soon as the successor is authoritative, which is not when it was due", policy),
            RpcTimerPolicy.RefuseIfOverdue when overdue =>
                Entry(id, kind, RpcResolution.Unhonourable, "its deadline passed while the handoff was being prepared, and it is declared to abort rather than decide what a missed deadline meant", policy),
            RpcTimerPolicy.RefuseIfOverdue => Entry(id, kind, RpcResolution.Assumed, "it is not yet due, so there is nothing to refuse", policy),
            _ => Entry(id, kind, RpcResolution.Unhonourable, $"the policy {policy} is not one this implementation knows", policy)
        };
    }

    private static RpcRestorePlanEntry Subscription(string id, RpcRestoreDeclaration declaration)
    {
        if (declaration.Resolution == RpcResolution.Reestablished && declaration.Redelivery is null)
            return new RpcRestorePlanEntry
            {
                Id = id,
                Kind = "subscription",
                Resolution = RpcResolution.Unhonourable,
                Why =
                    "it is declared re-established without saying what the transport will do to it, which is a claim of continuity the transport underneath has not made - and a consumer following the logical address must not see a false reset because a process changed"
            };
        return new RpcRestorePlanEntry
        {
            Id = id,
            Kind = "subscription",
            Resolution = declaration.Resolution,
            Why = declaration.Redelivery is { } redelivery ? $"re-established with {RpcNames.Redelivery(redelivery)} redelivery" : "carried across unchanged",
            Redelivery = declaration.Redelivery
        };
    }

    private static RpcRestorePlanEntry Lease(RpcLeaseObligation lease, RpcRestoreDeclaration declaration)
    {
        if (declaration.Resolution == RpcResolution.Assumed && !lease.IssuerSupportsLogicalOwner)
            return new RpcRestorePlanEntry
            {
                Id = lease.Id,
                Kind = "lease",
                Resolution = RpcResolution.Unhonourable,
                Why =
                    $"{lease.Issuer} does not support a logical owner, so a lease it granted cannot be carried across a process change - assuming it would hand the successor an authority the issuer does not believe it has"
            };
        return new RpcRestorePlanEntry { Id = lease.Id, Kind = "lease", Resolution = declaration.Resolution, Why = $"declared {declaration.Resolution.ToString().ToLowerInvariant()} against {lease.Issuer}" };
    }

    private static RpcRestorePlanEntry Simple(string id, string kind, RpcRestoreDeclaration declaration) =>
        new()
        {
            Id = id,
            Kind = kind,
            Resolution = declaration.Resolution,
            Why = $"declared {declaration.Resolution.ToString().ToLowerInvariant()} by the successor"
        };

    private static RpcRestorePlanEntry Entry(string id, string kind, RpcResolution resolution, string why, RpcTimerPolicy policy) =>
        new()
        {
            Id = id,
            Kind = kind,
            Resolution = resolution,
            Why = why,
            TimerPolicy = policy
        };
}
