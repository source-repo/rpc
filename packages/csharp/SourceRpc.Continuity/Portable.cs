using System.Text.Json;

namespace SourceRpc.Continuity;

/// <summary>
/// Reading a snapshot that another language wrote.
///
/// Hand-parsed rather than left to a deserialiser with attributes, and that is a decision. Every
/// position on the wire is a decimal *string* and has to become an integer here; every enum is a
/// kebab-case string and has to become a member; and an unknown value in either has to be a refusal
/// naming the field rather than a default. A deserialiser configured to be lenient enough to read
/// this would be lenient enough to read a snapshot that says something else, which is the one thing
/// a process about to become authoritative for a plant must not do.
///
/// What it will not do is verify. Parsing and verifying are separate acts and a caller has to be
/// able to say which one failed; <see cref="RpcSnapshots.Verify"/> is the next call.
/// </summary>
public static class RpcPortableSnapshot
{
    /// <summary>Refused because a document does not say what a snapshot has to say.</summary>
    public sealed class RefusedException(string message, string? path = null) : Exception(message)
    {
        /// <summary>The field this is about, where it is about one.</summary>
        public string? Path { get; } = path;
    }

    public static RpcSnapshotEnvelope Read(string json)
    {
        using var document = JsonDocument.Parse(json);
        return Read(document.RootElement);
    }

    public static RpcSnapshotEnvelope Read(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new RefusedException("a snapshot is a JSON object");
        var format = (int)Number(root, "snapshotFormatVersion");
        // Refused rather than read optimistically. A format this does not know may differ in what a
        // field *means* rather than in which fields exist, and reading it anyway is how a successor
        // comes to hold values it has misunderstood.
        if (format > RpcSnapshotFormat.Version)
            throw new RefusedException($"this snapshot is format version {format} and this implementation reads up to {RpcSnapshotFormat.Version}", "snapshotFormatVersion");

        return new RpcSnapshotEnvelope
        {
            SnapshotFormatVersion = format,
            SnapshotId = String(root, "snapshotId"),
            CaptureKind = CaptureKind(String(root, "captureKind")),
            ComponentType = String(root, "componentType"),
            ComponentId = String(root, "componentId"),
            SourceRevision = String(root, "sourceRevision"),
            StateSchemaId = String(root, "stateSchemaId"),
            StateVersion = (int)Number(root, "stateVersion"),
            StateSchemaHash = String(root, "stateSchemaHash"),
            ActivationEpoch = Position(root, "activationEpoch"),
            LogicalTime = Position(root, "logicalTime"),
            LastAppliedInputSequence = Position(root, "lastAppliedInputSequence"),
            LastCommittedOutputSequence = Position(root, "lastCommittedOutputSequence"),
            HeldState = root.TryGetProperty("heldState", out var held) ? held.Clone() : throw new RefusedException("a snapshot carries heldState", "heldState"),
            Obligations = root.TryGetProperty("obligations", out var obligations) && obligations.ValueKind == JsonValueKind.Object ? Obligations(obligations) : null,
            Provenance = root.TryGetProperty("provenance", out var provenance) ? provenance.EnumerateArray().Select(MigrationRecord).ToList() : [],
            CapturedAt = String(root, "capturedAt"),
            ParentSnapshotHash = Optional(root, "parentSnapshotHash"),
            ContentHash = String(root, "contentHash")
        };
    }

    private static RpcCaptureKind CaptureKind(string value) =>
        value switch
        {
            "held-state-only" => RpcCaptureKind.HeldStateOnly,
            "quiescent-handoff" => RpcCaptureKind.QuiescentHandoff,
            _ => throw new RefusedException($"captureKind is \"{value}\", and a snapshot is one of held-state-only or quiescent-handoff", "captureKind")
        };

    private static RpcObligations Obligations(JsonElement element) =>
        new()
        {
            Timers = Group(element, "timers", Timer),
            OutboundCalls = Group(element, "outboundCalls", OutboundCall),
            InboundWork = Group(element, "inboundWork", InboundWork),
            Subscriptions = Group(element, "subscriptions", Subscription),
            PendingPublications = Group(element, "pendingPublications", Publication),
            Leases = Group(element, "leases", Lease),
            Sequences = Group(element, "sequences", Sequence),
            Watchdogs = Group(element, "watchdogs", Watchdog)
        };

    private static IReadOnlyList<T> Group<T>(JsonElement element, string name, Func<JsonElement, T> read) =>
        element.TryGetProperty(name, out var group) && group.ValueKind == JsonValueKind.Array ? group.EnumerateArray().Select(read).ToList() : [];

    private static RpcTimerObligation Timer(JsonElement one) =>
        new()
        {
            Id = String(one, "id"),
            Clock = Clock(String(one, "clock")),
            DueAt = RequiredPosition(one, "dueAt"),
            CapturedAt = RequiredPosition(one, "capturedAt"),
            Policy = Policy(String(one, "policy")),
            Periodic = one.TryGetProperty("periodic", out var periodic) && periodic.ValueKind == JsonValueKind.Object
                ? new RpcPeriodicTimer { Interval = RequiredPosition(periodic, "interval"), MissedTickPolicy = String(periodic, "missedTickPolicy") }
                : null
        };

    private static RpcOutboundCallObligation OutboundCall(JsonElement one) =>
        new()
        {
            Id = String(one, "id"),
            Target = String(one, "target"),
            Method = String(one, "method"),
            Semantics = Optional(one, "semantics") is { } semantics ? Semantics(semantics) : null,
            IdempotencyKey = Optional(one, "idempotencyKey")
        };

    private static RpcInboundWorkObligation InboundWork(JsonElement one) =>
        new() { Id = String(one, "id"), From = String(one, "from"), Method = String(one, "method"), Mutating = Boolean(one, "mutating") };

    private static RpcSubscriptionObligation Subscription(JsonElement one) =>
        new() { Id = String(one, "id"), Event = String(one, "event"), LastAcknowledgedSequence = Position(one, "lastAcknowledgedSequence") };

    private static RpcPublicationObligation Publication(JsonElement one) => new() { Id = String(one, "id"), Event = String(one, "event"), Sequence = RequiredPosition(one, "sequence") };

    private static RpcLeaseObligation Lease(JsonElement one) =>
        new()
        {
            Id = String(one, "id"),
            Issuer = String(one, "issuer"),
            ExpiresAt = RequiredPosition(one, "expiresAt"),
            IssuerSupportsLogicalOwner = Boolean(one, "issuerSupportsLogicalOwner")
        };

    private static RpcSequenceObligation Sequence(JsonElement one) => new() { Id = String(one, "id"), Position = RequiredPosition(one, "position") };

    private static RpcWatchdogObligation Watchdog(JsonElement one) => new() { Id = String(one, "id"), DueAt = RequiredPosition(one, "dueAt"), Policy = Policy(String(one, "policy")) };

    private static RpcMigrationRecord MigrationRecord(JsonElement one) =>
        new()
        {
            StepId = String(one, "stepId"),
            SchemaId = String(one, "schemaId"),
            FromVersion = (int)Number(one, "fromVersion"),
            ToVersion = (int)Number(one, "toVersion"),
            Approval = new RpcMigrationApproval { By = String(one.GetProperty("approval"), "by"), Reference = String(one.GetProperty("approval"), "reference") },
            Transformed = one.TryGetProperty("transformed", out var transformed) ? transformed.EnumerateArray().Select(item => item.GetString()!).ToList() : [],
            Defaulted = one.TryGetProperty("defaulted", out var defaulted)
                ? defaulted.EnumerateArray().Select(item => new RpcDefaultedValue { Path = String(item, "path"), Value = item.GetProperty("value").Clone(), Why = String(item, "why") }).ToList()
                : [],
            InputHash = String(one, "inputHash"),
            OutputHash = String(one, "outputHash")
        };

    private static RpcClockKind Clock(string value) =>
        value switch
        {
            "simulation" => RpcClockKind.Simulation,
            "monotonic" => RpcClockKind.Monotonic,
            "wall" => RpcClockKind.Wall,
            _ => throw new RefusedException($"clock is \"{value}\", and the three are not interchangeable, so there is nothing to fall back to", "clock")
        };

    private static RpcTimerPolicy Policy(string value) =>
        value switch
        {
            "preserve-deadline" => RpcTimerPolicy.PreserveDeadline,
            "preserve-remaining" => RpcTimerPolicy.PreserveRemaining,
            "restart" => RpcTimerPolicy.Restart,
            "fire-on-activation" => RpcTimerPolicy.FireOnActivation,
            "refuse-if-overdue" => RpcTimerPolicy.RefuseIfOverdue,
            _ => throw new RefusedException($"policy is \"{value}\", which this implementation does not know - and a timer policy it guessed at is a doubled bake or a watchdog that fires on activation", "policy")
        };

    private static RpcMethodSemantics Semantics(string value) =>
        value switch
        {
            "query" => RpcMethodSemantics.Query,
            "idempotent-command" => RpcMethodSemantics.IdempotentCommand,
            "non-repeatable-command" => RpcMethodSemantics.NonRepeatableCommand,
            _ => throw new RefusedException($"semantics is \"{value}\", and what repeating a call costs is not something to default", "semantics")
        };

    private static string String(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw new RefusedException($"a snapshot carries {name} as a string", name);

    private static string? Optional(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool Boolean(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
            ? value.GetBoolean()
            : throw new RefusedException($"a snapshot carries {name} as a boolean", name);

    private static double Number(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetDouble()
            : throw new RefusedException($"a snapshot carries {name} as a number", name);

    /// <summary>
    /// A position, from the decimal string it crosses as.
    ///
    /// A number here is refused rather than converted, and that is the whole reason the field is a
    /// string. Something that arrived as a JSON number has already been through a double: if it is
    /// large enough to matter it is already the wrong value, and converting it now would launder a
    /// rounding error into an authoritative sequence position.
    /// </summary>
    private static long? Position(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind == JsonValueKind.Number)
            throw new RefusedException($"{name} is a JSON number, and a position crosses as a decimal string - a number here has already been through a double", name);
        if (value.ValueKind != JsonValueKind.String) throw new RefusedException($"{name} is not a decimal string", name);
        var text = value.GetString()!;
        if (!long.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
            throw new RefusedException($"{name} is \"{text}\", which is not an integer this runtime can hold", name);
        return parsed;
    }

    private static long RequiredPosition(JsonElement element, string name) =>
        Position(element, name) ?? throw new RefusedException($"a snapshot carries {name}", name);
}

/// <summary>The snapshot format version this implementation writes and the highest it reads.</summary>
public static class RpcSnapshotFormat
{
    public const int Version = 1;
}
