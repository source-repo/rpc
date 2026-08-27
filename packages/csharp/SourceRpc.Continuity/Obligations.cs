using System.Text.Json.Serialization;

namespace SourceRpc.Continuity;

/// <summary>
/// What a running activation was still holding when the barrier went in.
///
/// A port of `Obligations.ts`, and the vocabulary is the contract: a .NET revision taking over from
/// a TypeScript one has to understand every kind, because an obligation it does not recognise is one
/// it cannot honour, and the restore rules turn that into a refusal rather than
/// into silence.
///
/// The deadlines are <see cref="long"/> here and decimal strings on the wire, for the reason every
/// position is: JSON has one numeric type and it is a double.
/// </summary>
public enum RpcClockKind
{
    /// <summary>A clock the simulation advances. Not interchangeable with either of the others.</summary>
    Simulation,
    Monotonic,
    Wall
}

/// <summary>
/// What happens to a timer when the process holding it is replaced.
///
/// There is deliberately no default. Every one is right for something and catastrophic for something
/// else - a dwell timer that restarts has doubled a bake, a watchdog that preserves its deadline
/// through a two-minute handoff fires the moment the successor comes up - so the component's author
/// names one at the timer, or the handoff refuses.
/// </summary>
public enum RpcTimerPolicy
{
    /// <summary>Handoff time counts against it: it fires when it would have fired.</summary>
    PreserveDeadline,

    /// <summary>Effectively paused for the handoff: it fires after the time it had left.</summary>
    PreserveRemaining,

    /// <summary>Begin its declared duration again.</summary>
    Restart,

    /// <summary>Deliver it immediately once the successor is authoritative.</summary>
    FireOnActivation,

    /// <summary>Abort the handoff if the deadline passed while the handoff was being prepared.</summary>
    RefuseIfOverdue
}

// `RpcMethodSemantics` is the core's, deliberately. What repeating a call costs is the founding
// distinction this whole library is arranged around, and a second enum here - identical, in a
// different namespace, with its own wire spelling - is how the two would eventually disagree about
// what a non-repeatable command is. An obligation's semantics and a call's are the same question.

/// <summary>What the transport will do to a re-established feed. Never inferred from "recreated".</summary>
public enum RpcRedelivery
{
    ExactlyOnce,
    AtLeastOnceDeduplicated,
    AtLeastOnce,
    GapPossible
}

public sealed record RpcPeriodicTimer
{
    public required long Interval { get; init; }

    /// <summary>What a tick missed during the handoff means. Same argument as the policy itself.</summary>
    public required string MissedTickPolicy { get; init; }
}

public sealed record RpcTimerObligation
{
    public required string Id { get; init; }
    public required RpcClockKind Clock { get; init; }
    public required long DueAt { get; init; }
    public required long CapturedAt { get; init; }
    public required RpcTimerPolicy Policy { get; init; }
    public RpcPeriodicTimer? Periodic { get; init; }
}

public sealed record RpcOutboundCallObligation
{
    public required string Id { get; init; }
    public required string Target { get; init; }
    public required string Method { get; init; }
    public RpcMethodSemantics? Semantics { get; init; }

    /// <summary>The key that would make a second attempt the same command, where the caller named one.</summary>
    public string? IdempotencyKey { get; init; }
}

public sealed record RpcInboundWorkObligation
{
    public required string Id { get; init; }
    public required string From { get; init; }
    public required string Method { get; init; }

    /// <summary>Whether it changes anything. A state-mutating handler must complete before capture.</summary>
    public required bool Mutating { get; init; }
}

public sealed record RpcSubscriptionObligation
{
    public required string Id { get; init; }
    public required string Event { get; init; }

    /// <summary>Where the subscriber had got to, so a re-established feed continues rather than resets.</summary>
    public long? LastAcknowledgedSequence { get; init; }
}

public sealed record RpcPublicationObligation
{
    public required string Id { get; init; }
    public required string Event { get; init; }
    public required long Sequence { get; init; }
}

public sealed record RpcLeaseObligation
{
    public required string Id { get; init; }
    public required string Issuer { get; init; }
    public required long ExpiresAt { get; init; }

    /// <summary>
    /// Whether the issuer knows how to keep a lease for a *logical* component rather than a process.
    ///
    /// Declared by whoever registered it, because only they have talked to the issuer. Assuming it
    /// would hand the successor an authority the issuer does not believe it has.
    /// </summary>
    public required bool IssuerSupportsLogicalOwner { get; init; }
}

public sealed record RpcSequenceObligation
{
    public required string Id { get; init; }
    public required long Position { get; init; }
}

public sealed record RpcWatchdogObligation
{
    public required string Id { get; init; }
    public required long DueAt { get; init; }
    public required RpcTimerPolicy Policy { get; init; }
}

/// <summary>The manifest, grouped as the design groups it, so a reader finds what they expect.</summary>
public sealed record RpcObligations
{
    public IReadOnlyList<RpcTimerObligation> Timers { get; init; } = [];
    public IReadOnlyList<RpcOutboundCallObligation> OutboundCalls { get; init; } = [];
    public IReadOnlyList<RpcInboundWorkObligation> InboundWork { get; init; } = [];
    public IReadOnlyList<RpcSubscriptionObligation> Subscriptions { get; init; } = [];
    public IReadOnlyList<RpcPublicationObligation> PendingPublications { get; init; } = [];
    public IReadOnlyList<RpcLeaseObligation> Leases { get; init; } = [];
    public IReadOnlyList<RpcSequenceObligation> Sequences { get; init; } = [];
    public IReadOnlyList<RpcWatchdogObligation> Watchdogs { get; init; } = [];

    /// <summary>Everything, in one list, when what is wanted is the count or a search by id.</summary>
    [JsonIgnore]
    public IReadOnlyList<object> All =>
    [
        .. Timers.Cast<object>(),
        .. OutboundCalls,
        .. InboundWork,
        .. Subscriptions,
        .. PendingPublications,
        .. Leases,
        .. Sequences,
        .. Watchdogs
    ];
}

/// <summary>
/// The obligations manifest in the form the content hash is taken over.
///
/// Written out rather than reflected over, for the same reason the envelope's is: a field that
/// joined or left the digest by accident would make every snapshot taken by one language unverifiable
/// by the other, and the failure would look like corruption rather than like a schema change.
/// </summary>
internal static class RpcObligationsCanonical
{
    internal static IReadOnlyDictionary<string, object?> Form(RpcObligations obligations) =>
        new Dictionary<string, object?>
        {
            ["timers"] = obligations.Timers.Select(Timer).ToList(),
            ["outboundCalls"] = obligations.OutboundCalls.Select(OutboundCall).ToList(),
            ["inboundWork"] = obligations.InboundWork.Select(InboundWork).ToList(),
            ["subscriptions"] = obligations.Subscriptions.Select(Subscription).ToList(),
            ["pendingPublications"] = obligations.PendingPublications.Select(Publication).ToList(),
            ["leases"] = obligations.Leases.Select(Lease).ToList(),
            ["sequences"] = obligations.Sequences.Select(Sequence).ToList(),
            ["watchdogs"] = obligations.Watchdogs.Select(Watchdog).ToList()
        };

    private static object Integer(long value) => new System.Numerics.BigInteger(value);

    private static object Absent(object? value) => value ?? RpcCanonical.Absent;

    private static IReadOnlyDictionary<string, object?> Timer(RpcTimerObligation one) =>
        new Dictionary<string, object?>
        {
            ["kind"] = "timer",
            ["id"] = one.Id,
            ["clock"] = RpcNames.Clock(one.Clock),
            ["dueAt"] = Integer(one.DueAt),
            ["capturedAt"] = Integer(one.CapturedAt),
            ["policy"] = RpcNames.Policy(one.Policy),
            ["periodic"] = one.Periodic is null
                ? RpcCanonical.Absent
                : new Dictionary<string, object?> { ["interval"] = Integer(one.Periodic.Interval), ["missedTickPolicy"] = one.Periodic.MissedTickPolicy }
        };

    private static IReadOnlyDictionary<string, object?> OutboundCall(RpcOutboundCallObligation one) =>
        new Dictionary<string, object?>
        {
            ["kind"] = "outbound-call",
            ["id"] = one.Id,
            ["target"] = one.Target,
            ["method"] = one.Method,
            ["semantics"] = Absent(one.Semantics is null ? null : RpcNames.Semantics(one.Semantics.Value)),
            ["idempotencyKey"] = Absent(one.IdempotencyKey)
        };

    private static IReadOnlyDictionary<string, object?> InboundWork(RpcInboundWorkObligation one) =>
        new Dictionary<string, object?> { ["kind"] = "inbound-work", ["id"] = one.Id, ["from"] = one.From, ["method"] = one.Method, ["mutating"] = one.Mutating };

    private static IReadOnlyDictionary<string, object?> Subscription(RpcSubscriptionObligation one) =>
        new Dictionary<string, object?>
        {
            ["kind"] = "subscription",
            ["id"] = one.Id,
            ["event"] = one.Event,
            ["lastAcknowledgedSequence"] = one.LastAcknowledgedSequence is null ? RpcCanonical.Absent : Integer(one.LastAcknowledgedSequence.Value)
        };

    private static IReadOnlyDictionary<string, object?> Publication(RpcPublicationObligation one) =>
        new Dictionary<string, object?> { ["kind"] = "publication", ["id"] = one.Id, ["event"] = one.Event, ["sequence"] = Integer(one.Sequence) };

    private static IReadOnlyDictionary<string, object?> Lease(RpcLeaseObligation one) =>
        new Dictionary<string, object?>
        {
            ["kind"] = "lease",
            ["id"] = one.Id,
            ["issuer"] = one.Issuer,
            ["expiresAt"] = Integer(one.ExpiresAt),
            ["issuerSupportsLogicalOwner"] = one.IssuerSupportsLogicalOwner
        };

    private static IReadOnlyDictionary<string, object?> Sequence(RpcSequenceObligation one) =>
        new Dictionary<string, object?> { ["kind"] = "sequence", ["id"] = one.Id, ["position"] = Integer(one.Position) };

    private static IReadOnlyDictionary<string, object?> Watchdog(RpcWatchdogObligation one) =>
        new Dictionary<string, object?> { ["kind"] = "watchdog", ["id"] = one.Id, ["dueAt"] = Integer(one.DueAt), ["policy"] = RpcNames.Policy(one.Policy) };
}

/// <summary>
/// The wire spelling of every enum here.
///
/// Kebab-case strings, because that is what the TypeScript union members are and the wire form is
/// theirs. Written as a switch rather than derived from the member name, so that renaming a C# member
/// for clarity cannot silently change what crosses the boundary.
/// </summary>
public static class RpcNames
{
    public static string Clock(RpcClockKind kind) =>
        kind switch
        {
            RpcClockKind.Simulation => "simulation",
            RpcClockKind.Monotonic => "monotonic",
            RpcClockKind.Wall => "wall",
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };

    public static string Policy(RpcTimerPolicy policy) =>
        policy switch
        {
            RpcTimerPolicy.PreserveDeadline => "preserve-deadline",
            RpcTimerPolicy.PreserveRemaining => "preserve-remaining",
            RpcTimerPolicy.Restart => "restart",
            RpcTimerPolicy.FireOnActivation => "fire-on-activation",
            RpcTimerPolicy.RefuseIfOverdue => "refuse-if-overdue",
            _ => throw new ArgumentOutOfRangeException(nameof(policy))
        };

    public static string Semantics(RpcMethodSemantics semantics) =>
        semantics switch
        {
            RpcMethodSemantics.Query => "query",
            RpcMethodSemantics.IdempotentCommand => "idempotent-command",
            RpcMethodSemantics.NonRepeatableCommand => "non-repeatable-command",
            _ => throw new ArgumentOutOfRangeException(nameof(semantics))
        };

    public static string Redelivery(RpcRedelivery redelivery) =>
        redelivery switch
        {
            RpcRedelivery.ExactlyOnce => "exactly-once",
            RpcRedelivery.AtLeastOnceDeduplicated => "at-least-once-deduplicated",
            RpcRedelivery.AtLeastOnce => "at-least-once",
            RpcRedelivery.GapPossible => "gap-possible",
            _ => throw new ArgumentOutOfRangeException(nameof(redelivery))
        };
}
