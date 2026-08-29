using System.Text.Json;

namespace SourceRpc.Continuity;

/// <summary>
/// What a component did, as another language wrote it down.
///
/// A journal is what turns <c>failed-after-commit</c>'s <em>recover forward</em> into something a
/// successor can carry out: the last snapshot, plus every input recorded after it, replayed in
/// order. A .NET activation that has taken over from a TypeScript one is exactly the case where
/// that matters and exactly the case where the two implementations have to agree about what the
/// record says - so this reads the same file the TypeScript suite reads, and computes the same
/// hashes over it.
///
/// Hand-parsed for the same reason the snapshot reader is: every position on the wire is a decimal
/// string and has to become an integer here, every kind is a lower-case string and has to become a
/// member, and an unknown value in either has to be a refusal naming the field. A reader lenient
/// enough to take this format is lenient enough to take one that says something else, which is not
/// a risk worth running in a process about to replay a plant's history into a live component.
/// </summary>
public sealed record RpcJournalEntry
{
    /// <summary>Which version of the format this entry was written in. Per entry, because a chain may span an upgrade.</summary>
    public required int JournalFormatVersion { get; init; }

    /// <summary>The journal's own position. Monotonic per component, and gapless by construction.</summary>
    public required long Sequence { get; init; }

    public required string ComponentId { get; init; }

    public required RpcJournalEntryKind Kind { get; init; }

    /// <summary>Which activation wrote it. An entry from a fenced epoch is still history.</summary>
    public required long Epoch { get; init; }

    /// <summary>Wall clock, because "what was it doing at 03:14" is asked in wall clock.</summary>
    public required string At { get; init; }

    public long? LogicalTime { get; init; }

    /// <summary>
    /// For an <c>input</c>: the position it was applied at, and the only join between a journal and
    /// a snapshot. A snapshot's <c>lastAppliedInputSequence</c> says where it stopped; replay
    /// begins at the entry after it.
    /// </summary>
    public long? InputSequence { get; init; }

    /// <summary>What happened, left as parsed JSON: this reader does not interpret a payload.</summary>
    public required JsonElement Payload { get; init; }

    public required string PreviousHash { get; init; }

    public required string EntryHash { get; init; }
}

/// <summary>What kind of transition an entry records.</summary>
public enum RpcJournalEntryKind
{
    /// <summary>An input applied at a position. The only kind a replay consumes.</summary>
    Input,

    /// <summary>A state transition, or the sealing of a snapshot. What a replay starts from.</summary>
    State,

    /// <summary>An obligation taken on or discharged.</summary>
    Obligation,

    /// <summary>An ownership transition: a handoff attempted, committed, abandoned, or failed after commit.</summary>
    Activation
}

/// <summary>Reading a journal another language wrote.</summary>
public static class RpcPortableJournal
{
    /// <summary>The highest format version this implementation understands.</summary>
    public const int Version = 1;

    public static IReadOnlyList<RpcJournalEntry> Read(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Array) throw new RpcPortableSnapshot.RefusedException("a journal is a JSON array of entries");
        return document.RootElement.EnumerateArray().Select(ReadEntry).ToList();
    }

    public static RpcJournalEntry ReadEntry(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new RpcPortableSnapshot.RefusedException("a journal entry is a JSON object");
        var format = Number(root, "journalFormatVersion");
        // Refused rather than read optimistically, like a snapshot format from the future: a later
        // version may differ in what a field *means* rather than in which fields exist.
        if (format > Version)
            throw new RpcPortableSnapshot.RefusedException($"this entry is journal format version {format} and this implementation reads up to {Version}", "journalFormatVersion");

        return new RpcJournalEntry
        {
            JournalFormatVersion = format,
            Sequence = Position(root, "sequence"),
            ComponentId = String(root, "componentId"),
            Kind = EntryKind(String(root, "kind")),
            Epoch = Position(root, "epoch"),
            At = String(root, "at"),
            LogicalTime = OptionalPosition(root, "logicalTime"),
            InputSequence = OptionalPosition(root, "inputSequence"),
            Payload = root.TryGetProperty("payload", out var payload) ? payload.Clone() : throw new RpcPortableSnapshot.RefusedException("a journal entry carries a payload", "payload"),
            PreviousHash = root.TryGetProperty("previousHash", out var previous) && previous.ValueKind == JsonValueKind.String ? previous.GetString()! : throw new RpcPortableSnapshot.RefusedException("a journal entry names what it follows", "previousHash"),
            EntryHash = String(root, "entryHash")
        };
    }

    private static string String(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw new RpcPortableSnapshot.RefusedException($"a journal entry states its {name}", name);

    private static int Number(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : throw new RpcPortableSnapshot.RefusedException($"a journal entry states its {name}", name);

    /// <summary>
    /// One position, from the decimal string it crosses as. A number is refused, never converted.
    ///
    /// The rule the whole cross-language format is shaped around: JSON has one numeric type and it
    /// is a double, so an input sequence past 2^53 has already been rounded by the time it reaches
    /// a reader as a number. Converting it here would launder that into an authoritative position,
    /// and a replay starting from a rounded position re-applies an input or skips one.
    /// </summary>
    private static long Position(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value)) throw new RpcPortableSnapshot.RefusedException($"a journal entry states its {name}", name);
        if (value.ValueKind == JsonValueKind.Number)
            throw new RpcPortableSnapshot.RefusedException($"{name} is a JSON number, and a position crosses as a decimal string - a number here has already been through a double", name);
        if (value.ValueKind != JsonValueKind.String) throw new RpcPortableSnapshot.RefusedException($"{name} is {value.ValueKind}, and a position crosses as a decimal string", name);
        var text = value.GetString()!;
        if (!long.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var position))
            throw new RpcPortableSnapshot.RefusedException($"{name} is \"{text}\", which is not a decimal integer", name);
        return position;
    }

    private static long? OptionalPosition(JsonElement root, string name) => root.TryGetProperty(name, out _) ? Position(root, name) : null;

    private static RpcJournalEntryKind EntryKind(string kind) =>
        kind switch
        {
            "input" => RpcJournalEntryKind.Input,
            "state" => RpcJournalEntryKind.State,
            "obligation" => RpcJournalEntryKind.Obligation,
            "activation" => RpcJournalEntryKind.Activation,
            _ => throw new RpcPortableSnapshot.RefusedException($"{kind} is not a journal entry kind this implementation knows", "kind")
        };
}

/// <summary>Verifying a journal, and working out what it can carry forward.</summary>
public static class RpcJournals
{
    /// <summary>
    /// Walk the chain. The first thing that does not hold, or null.
    ///
    /// Reported on the first break rather than as a list, because a journal with one altered entry
    /// has every entry after it in question - listing them would be listing consequences as though
    /// they were causes.
    /// </summary>
    public static string? Verify(IReadOnlyList<RpcJournalEntry> entries)
    {
        var previousHash = string.Empty;
        long? previousSequence = null;
        foreach (var entry in entries)
        {
            if (previousSequence is not null && entry.Sequence != previousSequence + 1)
                return $"the journal jumps from {previousSequence} to {entry.Sequence}: entries are missing, and what a component did between them cannot be reconstructed from what is left";
            if (entry.PreviousHash != previousHash)
                return $"entry {entry.Sequence} follows {(entry.PreviousHash.Length == 0 ? "(nothing)" : entry.PreviousHash)} and the entry before it hashes to {(previousHash.Length == 0 ? "(nothing)" : previousHash)}: the chain has been rewritten";
            var expected = RpcCanonicalDigest.Digest(HashedForm(entry));
            if (expected != entry.EntryHash) return $"entry {entry.Sequence} hashes to {expected}, not the {entry.EntryHash} it carries: its content changed after it was written";
            previousHash = entry.EntryHash;
            previousSequence = entry.Sequence;
        }

        return null;
    }

    /// <summary>
    /// The inputs that carry <paramref name="snapshot"/> to the end of this journal, or a refusal.
    ///
    /// **A gap refuses.** A journal missing input 41 can still apply 42 onwards, and the state that
    /// results never existed in the plant: it is the state of a component that received one fewer
    /// input than it did. It would look exactly like a recovery, which is why it is refused rather
    /// than reported.
    /// </summary>
    public static RpcReplayPlan ReplayableFrom(RpcSnapshotEnvelope snapshot, IReadOnlyList<RpcJournalEntry> entries)
    {
        if (snapshot.CaptureKind != RpcCaptureKind.QuiescentHandoff || snapshot.LastAppliedInputSequence is null)
            return new RpcReplayPlan
            {
                Refused = $"{snapshot.ComponentId}'s snapshot names no input position: a held-state-only capture says what the values were and not where in the input they were, so nothing can be replayed onto it"
            };

        var mine = entries.Where(entry => entry.ComponentId == snapshot.ComponentId).ToList();
        if (mine.Count != entries.Count)
            return new RpcReplayPlan
            {
                Refused = $"{entries.Count - mine.Count} of these entries belong to another component, and a replay that mixed two components' inputs would produce a state neither of them was ever in"
            };

        var broken = Verify(mine);
        if (broken is not null) return new RpcReplayPlan { Refused = $"this journal cannot be replayed from: {broken}" };

        var from = snapshot.LastAppliedInputSequence.Value;
        var inputs = mine.Where(entry => entry.Kind == RpcJournalEntryKind.Input && entry.InputSequence > from).OrderBy(entry => entry.InputSequence).ToList();
        var expected = from + 1;
        foreach (var entry in inputs)
        {
            if (entry.InputSequence != expected)
                return new RpcReplayPlan
                {
                    Refused =
                        $"this journal reaches input {expected - 1} and the next it holds is {entry.InputSequence}: replaying across that gap would produce the state of a component that received one fewer input than it did, which is a fabrication rather than a recovery"
                };
            expected++;
        }

        return new RpcReplayPlan { FromInputSequence = from, Inputs = inputs, ToInputSequence = inputs.Count == 0 ? from : inputs[^1].InputSequence!.Value };
    }

    /// <summary>
    /// The fields the hash is taken over, in the reference's order.
    ///
    /// Written out rather than reflected over, for the reason the snapshot's is: the *set* is
    /// load-bearing across two implementations, and a field that joined or left the digest silently
    /// would make every entry disagree.
    /// </summary>
    internal static IReadOnlyDictionary<string, object?> HashedForm(RpcJournalEntry entry) =>
        new Dictionary<string, object?>
        {
            ["journalFormatVersion"] = (double)entry.JournalFormatVersion,
            ["sequence"] = new System.Numerics.BigInteger(entry.Sequence),
            ["componentId"] = entry.ComponentId,
            ["kind"] = entry.Kind switch
            {
                RpcJournalEntryKind.Input => "input",
                RpcJournalEntryKind.State => "state",
                RpcJournalEntryKind.Obligation => "obligation",
                _ => "activation"
            },
            ["epoch"] = new System.Numerics.BigInteger(entry.Epoch),
            ["at"] = entry.At,
            ["logicalTime"] = entry.LogicalTime is null ? RpcCanonical.Absent : new System.Numerics.BigInteger(entry.LogicalTime.Value),
            ["inputSequence"] = entry.InputSequence is null ? RpcCanonical.Absent : new System.Numerics.BigInteger(entry.InputSequence.Value),
            ["payload"] = entry.Payload,
            ["previousHash"] = entry.PreviousHash
        };
}

/// <summary>What a replay would apply, or why it cannot be attempted.</summary>
public sealed record RpcReplayPlan
{
    /// <summary>Why this journal cannot carry that snapshot forward, or null when it can.</summary>
    public string? Refused { get; init; }

    public long FromInputSequence { get; init; }

    public long ToInputSequence { get; init; }

    /// <summary>The inputs to apply, in order. Every one of them, or this is a refusal instead.</summary>
    public IReadOnlyList<RpcJournalEntry> Inputs { get; init; } = [];
}
