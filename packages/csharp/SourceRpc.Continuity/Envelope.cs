using System.Text.Json;
using System.Text.Json.Serialization;

namespace SourceRpc.Continuity;

/// <summary>
/// What a snapshot is, read by a process that did not write it and is not in the language that did.
///
/// **A port rather than an equivalent.** `Envelope.ts` is the reference, and the two must agree
/// exactly on one thing above all: the content hash. That hash is canonical text over the envelope's
/// own values, so a snapshot captured by a TypeScript activation and verified here has to produce
/// the same digest - and if it does not, everything else about the two revisions being
/// interface-compatible is beside the point.
///
/// The positions are <see cref="long"/> here and read from decimal strings on the wire. JSON has one
/// numeric type and it is a double: a sequence position past 2^53 rounds silently to something near
/// the value intended, and a successor that starts at a rounded position reprocesses input or skips
/// it, with no indication at the time and no way to tell afterwards which happened.
/// </summary>
public enum RpcCaptureKind
{
    /// <summary>These were the values. Enough for migration work, never enough for a handoff.</summary>
    HeldStateOnly,

    /// <summary>These were the values, at this position, under this activation, with this work outstanding.</summary>
    QuiescentHandoff
}

/// <summary>One migration that was applied, and what it did.</summary>
public sealed record RpcMigrationRecord
{
    public required string StepId { get; init; }
    public required string SchemaId { get; init; }
    public required int FromVersion { get; init; }
    public required int ToVersion { get; init; }
    public required RpcMigrationApproval Approval { get; init; }
    public IReadOnlyList<string> Transformed { get; init; } = [];
    public IReadOnlyList<RpcDefaultedValue> Defaulted { get; init; } = [];
    public required string InputHash { get; init; }
    public required string OutputHash { get; init; }
}

/// <summary>Who approved a migration step, and where the approval is recorded. Never inferred.</summary>
public sealed record RpcMigrationApproval
{
    public required string By { get; init; }
    public required string Reference { get; init; }
}

/// <summary>A value a step supplied, with the grounds. `Why` is not optional, and that is the point of it.</summary>
public sealed record RpcDefaultedValue
{
    public required string Path { get; init; }
    public required JsonElement Value { get; init; }
    public required string Why { get; init; }
}

/// <summary>
/// The envelope.
///
/// Every question a restorer will ask is answered here, because a snapshot found on a disk, in a
/// bucket or in a message has to be readable without whatever wrote it being present to explain.
/// </summary>
public sealed record RpcSnapshotEnvelope
{
    public required int SnapshotFormatVersion { get; init; }
    public required string SnapshotId { get; init; }
    public required RpcCaptureKind CaptureKind { get; init; }

    public required string ComponentType { get; init; }
    public required string ComponentId { get; init; }
    public required string SourceRevision { get; init; }

    public required string StateSchemaId { get; init; }
    public required int StateVersion { get; init; }
    public required string StateSchemaHash { get; init; }

    /// <summary>Present only on a quiescent handoff. See <see cref="RpcSnapshots.AdmissibleForHandoff"/>.</summary>
    public long? ActivationEpoch { get; init; }
    public long? LogicalTime { get; init; }
    public long? LastAppliedInputSequence { get; init; }
    public long? LastCommittedOutputSequence { get; init; }

    /// <summary>
    /// The values, as they were written down.
    ///
    /// A <see cref="JsonElement"/> rather than a typed object, because this package cannot know what
    /// a component's state is - and turning it into one is the successor's business, done against
    /// the schema the envelope names rather than against whatever shape a deserialiser guessed.
    /// </summary>
    public required JsonElement HeldState { get; init; }

    /// <summary>What the component had accepted, scheduled, awaited or promised at the barrier.</summary>
    public RpcObligations? Obligations { get; init; }

    public IReadOnlyList<RpcMigrationRecord> Provenance { get; init; } = [];

    /// <summary>Human-facing metadata. Never a simulation clock - <see cref="LogicalTime"/> is.</summary>
    public required string CapturedAt { get; init; }
    public string? ParentSnapshotHash { get; init; }
    public required string ContentHash { get; init; }
}

public static class RpcSnapshots
{
    /// <summary>
    /// Recompute the content hash and say whether it is the one carried.
    ///
    /// The reason rather than a boolean, because a caller holding a snapshot that does not verify
    /// needs to say what happened in a report somebody reads.
    /// </summary>
    public static string? Verify(RpcSnapshotEnvelope snapshot)
    {
        var expected = RpcCanonicalDigest.Digest(HashedForm(snapshot));
        return expected == snapshot.ContentHash ? null : $"snapshot {snapshot.SnapshotId} hashes to {expected}, and carries {snapshot.ContentHash}";
    }

    /// <summary>
    /// Whether this snapshot is enough to restore a live activation from.
    ///
    /// The manifest may be empty and may not be absent. A component that owes nothing owes nothing,
    /// and saying so is a finding; a missing manifest means nobody looked, and a successor told it
    /// had assumed everything when nothing was recorded is the failure the capture path exists to
    /// prevent.
    /// </summary>
    public static string? AdmissibleForHandoff(RpcSnapshotEnvelope snapshot)
    {
        if (snapshot.CaptureKind != RpcCaptureKind.QuiescentHandoff)
            return $"{snapshot.SnapshotId} is a held-state-only capture: it says what the values were, not where the component had got to";
        if (snapshot.ActivationEpoch is null) return $"{snapshot.SnapshotId} is missing activationEpoch, so it does not describe one instant";
        if (snapshot.LogicalTime is null) return $"{snapshot.SnapshotId} is missing logicalTime, so it does not describe one instant";
        if (snapshot.LastAppliedInputSequence is null) return $"{snapshot.SnapshotId} is missing lastAppliedInputSequence, so it does not describe one instant";
        if (snapshot.LastCommittedOutputSequence is null) return $"{snapshot.SnapshotId} is missing lastCommittedOutputSequence, so it does not describe one instant";
        if (snapshot.Obligations is null)
            return $"{snapshot.SnapshotId} carries no obligations manifest, so nothing is known about the work the old activation still owed";
        return null;
    }

    /// <summary>
    /// The fields the hash is taken over, in the reference's order.
    ///
    /// Order is not load-bearing - the canonical encoder sorts keys - but the *set* is, and writing
    /// it out rather than reflecting over the record is what keeps a field added here from silently
    /// joining or leaving the digest. `snapshotId` and `contentHash` are excluded because they are
    /// the name and the digest, and a value cannot be part of what names it.
    /// </summary>
    internal static IReadOnlyDictionary<string, object?> HashedForm(RpcSnapshotEnvelope snapshot) =>
        new Dictionary<string, object?>
        {
            ["snapshotFormatVersion"] = (double)snapshot.SnapshotFormatVersion,
            ["captureKind"] = snapshot.CaptureKind == RpcCaptureKind.QuiescentHandoff ? "quiescent-handoff" : "held-state-only",
            ["componentType"] = snapshot.ComponentType,
            ["componentId"] = snapshot.ComponentId,
            ["sourceRevision"] = snapshot.SourceRevision,
            ["stateSchemaId"] = snapshot.StateSchemaId,
            ["stateVersion"] = (double)snapshot.StateVersion,
            ["stateSchemaHash"] = snapshot.StateSchemaHash,
            ["activationEpoch"] = Integer(snapshot.ActivationEpoch),
            ["logicalTime"] = Integer(snapshot.LogicalTime),
            ["lastAppliedInputSequence"] = Integer(snapshot.LastAppliedInputSequence),
            ["lastCommittedOutputSequence"] = Integer(snapshot.LastCommittedOutputSequence),
            ["heldState"] = snapshot.HeldState,
            ["obligations"] = snapshot.Obligations is null ? RpcCanonical.Absent : RpcObligationsCanonical.Form(snapshot.Obligations),
            ["provenance"] = snapshot.Provenance.Select(ProvenanceForm).ToList(),
            ["capturedAt"] = snapshot.CapturedAt,
            ["parentSnapshotHash"] = snapshot.ParentSnapshotHash ?? RpcCanonical.Absent
        };

    /// <summary>
    /// A position, as the integer the reference encodes.
    ///
    /// <see cref="System.Numerics.BigInteger"/> because that is what the canonical encoder tags `i`,
    /// which is what TypeScript's `bigint` becomes. A `long` would be tagged `d` and hash as a
    /// double, and the two languages would disagree about every handoff snapshot ever taken.
    /// </summary>
    private static object Integer(long? value) => value is null ? RpcCanonical.Absent : new System.Numerics.BigInteger(value.Value);

    private static IReadOnlyDictionary<string, object?> ProvenanceForm(RpcMigrationRecord record) =>
        new Dictionary<string, object?>
        {
            ["stepId"] = record.StepId,
            ["schemaId"] = record.SchemaId,
            ["fromVersion"] = (double)record.FromVersion,
            ["toVersion"] = (double)record.ToVersion,
            ["approval"] = new Dictionary<string, object?> { ["by"] = record.Approval.By, ["reference"] = record.Approval.Reference },
            ["transformed"] = record.Transformed.ToList(),
            ["defaulted"] = record.Defaulted.Select(one => new Dictionary<string, object?> { ["path"] = one.Path, ["value"] = one.Value, ["why"] = one.Why }).ToList(),
            ["inputHash"] = record.InputHash,
            ["outputHash"] = record.OutputHash
        };
}

/// <summary>
/// Canonical text over values that may contain a <see cref="JsonElement"/>.
///
/// The core encoder knows the BCL's own types and nothing about `System.Text.Json`, which is right -
/// it is the encoder a frame uses. Held state arrives here as parsed JSON, so this converts a
/// `JsonElement` into the plain values the encoder already handles and hands the rest straight
/// through. Doing it as a conversion rather than as a second encoder is what keeps there being one
/// answer to "what is the canonical form of this".
/// </summary>
public static class RpcCanonicalDigest
{
    public static string Text(object? value) => RpcCanonical.Text(Plain(value));

    /// <summary>The base64url SHA-256 of the canonical text, which is what every hash in the envelope is.</summary>
    public static string Digest(object? value)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Text(value)));
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static object? Plain(object? value)
    {
        switch (value)
        {
            case JsonElement element:
                return FromJson(element);
            case IReadOnlyDictionary<string, object?> map:
                return map.ToDictionary(pair => pair.Key, pair => Plain(pair.Value));
            case string:
                return value;
            case System.Collections.IEnumerable list when value is not string:
                return list.Cast<object?>().Select(Plain).ToList();
            default:
                return value;
        }
    }

    private static object? FromJson(JsonElement element) =>
        element.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => element.GetDouble(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Array => element.EnumerateArray().Select(FromJson).ToList(),
            JsonValueKind.Object => element.EnumerateObject().ToDictionary(property => property.Name, property => FromJson(property.Value)),
            _ => null
        };
}

/// <summary>Options that read the portable form: camelCase names, and enums as their kebab-case strings.</summary>
public static class RpcSnapshotJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };
}
