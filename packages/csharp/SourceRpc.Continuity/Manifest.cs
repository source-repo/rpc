namespace SourceRpc.Continuity;

/// <summary>
/// What a compiled artifact says about itself, and what has to be checked against it.
///
/// A port of `Manifest.ts`. Until cross-language handoff, a replacement was checked by the compiler
/// that built both sides; here nothing is checked by anything unless it is written down. So the
/// artifact carries a manifest, and every function in this file takes it as a *claim*.
///
/// **The manifest describes the revision. It does not grant authority.** A manifest is emitted by
/// the artifact, and an artifact that could authorise itself by asserting its own capabilities would
/// make the whole approval path decorative.
/// </summary>
public enum RpcArtifactType
{
    JavaScript,
    DotNet,
    Wasm,
    Native,
    SourceIr
}

/// <summary>
/// What the artifact claims about its own suitability for online change.
///
/// Every field is a claim about the *code*, which is why none can be verified by a runtime and all
/// have to be declared. <see cref="SerialisedHandlers"/> is the one the barrier rests on: a component
/// whose state is changed by anything other than a handler the runtime dispatched is not quiescent
/// when the queue is empty, and no barrier can detect it.
/// </summary>
public sealed record RpcOnlineChangeProfile
{
    public required bool Supported { get; init; }
    public required bool SerialisedHandlers { get; init; }
    public required bool RuntimeManagedObligations { get; init; }
    public required int QuiescenceDeadlineMs { get; init; }
}

public sealed record RpcContractReference
{
    public required string Id { get; init; }
    public required int Version { get; init; }
    public required string SchemaHash { get; init; }
}

public sealed record RpcStateReference
{
    public required string SchemaId { get; init; }
    public required int Version { get; init; }
    public required string SchemaHash { get; init; }
}

public sealed record RpcRevisionManifest
{
    public required int ManifestVersion { get; init; }
    public required string ComponentType { get; init; }
    public required string RevisionId { get; init; }
    public required RpcArtifactType ArtifactType { get; init; }

    /// <summary>The digest of the built artifact, taken by whatever built it. Compared, never recomputed here.</summary>
    public required string ArtifactHash { get; init; }

    public required RpcContractReference Contract { get; init; }
    public required RpcStateReference State { get; init; }
    public IReadOnlyList<string> RequiredCapabilities { get; init; } = [];
    public required RpcOnlineChangeProfile OnlineChange { get; init; }
    public required string ManifestHash { get; init; }
}

/// <summary>What a deployment has decided a component may be, independently of what any artifact says.</summary>
public sealed record RpcIdentityPolicy
{
    public required string ComponentId { get; init; }
    public required string ComponentType { get; init; }

    /// <summary>The artifact digests approved for this identity. An empty list approves nothing, not everything.</summary>
    public IReadOnlyList<string> ApprovedArtifacts { get; init; } = [];

    /// <summary>The most this identity may ever be granted, whatever a revision asks for.</summary>
    public IReadOnlyList<string> CapabilityEnvelope { get; init; } = [];

    /// <summary>Whether this identity may be changed while running at all. Some plant is not eligible, by decision.</summary>
    public required bool OnlineChangePermitted { get; init; }
}

/// <summary>Whether this revision agrees with a snapshot, and whether the migration chain has to run.</summary>
public sealed record RpcReconciliation
{
    public required bool Agreed { get; init; }
    public bool MigrationNeeded { get; init; }
    public string? Why { get; init; }
}

public static class RpcManifests
{
    /// <summary>The manifest version this implementation writes and the highest it reads.</summary>
    public const int Version = 1;

    /// <summary>Recompute the manifest hash. The reason it does not match, or nothing.</summary>
    public static string? Verify(RpcRevisionManifest manifest)
    {
        var expected = RpcCanonicalDigest.Digest(HashedForm(manifest));
        return expected == manifest.ManifestHash ? null : $"manifest for {manifest.RevisionId} hashes to {expected}, and carries {manifest.ManifestHash}";
    }

    /// <summary>
    /// Whether a revision can take over a particular snapshot.
    ///
    /// This is the check that makes cross-language handoff mean something. The two artifacts share
    /// no compiler, no type system and no runtime; what they share is a component type, a contract
    /// hash and a state schema hash, and if those agree then the successor holds the same description
    /// of the same values that the incumbent did. If they do not, nothing else about the two being
    /// interface-compatible matters.
    ///
    /// The state *version* may legitimately differ - that is what migration is for - so a mismatch
    /// there is reported separately from a mismatch of identity, which is never migratable.
    /// </summary>
    public static RpcReconciliation Reconcile(RpcRevisionManifest manifest, RpcSnapshotEnvelope snapshot)
    {
        if (manifest.ComponentType != snapshot.ComponentType)
            return Refuse($"{manifest.RevisionId} implements {manifest.ComponentType} and this snapshot is of {snapshot.ComponentType}: two component types are not two versions of one");
        if (manifest.State.SchemaId != snapshot.StateSchemaId)
            return Refuse(
                $"{manifest.RevisionId} holds {manifest.State.SchemaId} and this snapshot carries {snapshot.StateSchemaId}: a schema id is stable for the life of a component type, so two of them are two different states");
        if (manifest.State.Version == snapshot.StateVersion && manifest.State.SchemaHash != snapshot.StateSchemaHash)
            return Refuse(
                $"{manifest.RevisionId} and this snapshot both claim {manifest.State.SchemaId} v{manifest.State.Version} and describe it differently ({manifest.State.SchemaHash} against {snapshot.StateSchemaHash}): a published version cannot be redefined, and one of these two was");
        if (manifest.State.Version < snapshot.StateVersion)
            return Refuse($"{manifest.RevisionId} holds {manifest.State.SchemaId} v{manifest.State.Version} and this snapshot is at v{snapshot.StateVersion}: migration is forward only, and this would be a rollback");
        return new RpcReconciliation { Agreed = true, MigrationNeeded = manifest.State.Version != snapshot.StateVersion };
    }

    /// <summary>
    /// Whether this artifact is allowed to be this component.
    ///
    /// The reason it is not, and there are several because they are several different conversations:
    /// the wrong type is a mistake, an unapproved artifact needs a deployment approval, a capability
    /// outside the envelope needs the envelope widened by whoever owns the identity, and an identity
    /// that is not eligible for online change needs a controlled restart instead. Collapsing them
    /// into `false` would leave every one of those as the same shrug.
    /// </summary>
    public static string? Authorised(RpcRevisionManifest manifest, RpcIdentityPolicy policy)
    {
        if (manifest.ComponentType != policy.ComponentType) return $"{policy.ComponentId} is a {policy.ComponentType} and {manifest.RevisionId} implements {manifest.ComponentType}";
        if (!policy.ApprovedArtifacts.Contains(manifest.ArtifactHash))
            return $"{manifest.RevisionId} ({manifest.ArtifactHash}) is not among the artifacts approved for {policy.ComponentId}: a manifest describes a revision, it does not approve one";
        var beyond = manifest.RequiredCapabilities.Where(capability => !policy.CapabilityEnvelope.Contains(capability)).ToList();
        if (beyond.Count > 0)
            return $"{manifest.RevisionId} requires {string.Join(", ", beyond)}, which {policy.ComponentId} is not permitted to grant - an interface-compatible replacement does not inherit an authority the identity never had";
        if (!policy.OnlineChangePermitted) return $"{policy.ComponentId} is not eligible for online change, so {manifest.RevisionId} is deployed by a controlled restart rather than a handoff";
        if (!manifest.OnlineChange.Supported) return $"{manifest.RevisionId} does not support online change and says so in its own manifest";
        if (!manifest.OnlineChange.SerialisedHandlers)
            return $"{manifest.RevisionId} does not serialise its handlers, so no barrier can establish that it is quiescent - the queue being empty would say nothing about what is running";
        return null;
    }

    private static RpcReconciliation Refuse(string why) => new() { Agreed = false, Why = why };

    internal static IReadOnlyDictionary<string, object?> HashedForm(RpcRevisionManifest manifest) =>
        new Dictionary<string, object?>
        {
            ["manifestVersion"] = (double)manifest.ManifestVersion,
            ["componentType"] = manifest.ComponentType,
            ["revisionId"] = manifest.RevisionId,
            ["artifactType"] = ArtifactName(manifest.ArtifactType),
            ["artifactHash"] = manifest.ArtifactHash,
            ["contract"] = new Dictionary<string, object?> { ["id"] = manifest.Contract.Id, ["version"] = (double)manifest.Contract.Version, ["schemaHash"] = manifest.Contract.SchemaHash },
            ["state"] = new Dictionary<string, object?>
            {
                ["schemaId"] = manifest.State.SchemaId,
                ["version"] = (double)manifest.State.Version,
                ["schemaHash"] = manifest.State.SchemaHash
            },
            // Sorted, because a manifest listing the same capabilities in a different order is the
            // same manifest, and an artifact rebuilt on a machine that walked its imports
            // differently would otherwise hash to something else and read as a different revision.
            ["requiredCapabilities"] = manifest.RequiredCapabilities.OrderBy(one => one, StringComparer.Ordinal).ToList(),
            ["onlineChange"] = new Dictionary<string, object?>
            {
                ["supported"] = manifest.OnlineChange.Supported,
                ["serialisedHandlers"] = manifest.OnlineChange.SerialisedHandlers,
                ["runtimeManagedObligations"] = manifest.OnlineChange.RuntimeManagedObligations,
                ["quiescenceDeadlineMs"] = (double)manifest.OnlineChange.QuiescenceDeadlineMs
            }
        };

    /// <summary>The wire spelling, as a switch rather than a member name, for <see cref="RpcNames"/>'s reason.</summary>
    public static string ArtifactName(RpcArtifactType type) =>
        type switch
        {
            RpcArtifactType.JavaScript => "javascript",
            RpcArtifactType.DotNet => "dotnet",
            RpcArtifactType.Wasm => "wasm",
            RpcArtifactType.Native => "native",
            RpcArtifactType.SourceIr => "source-ir",
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };

    /// <summary>Read a manifest another language wrote. Refuses rather than defaulting, as everything here does.</summary>
    public static RpcRevisionManifest Read(string json)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        var root = document.RootElement;
        var version = root.GetProperty("manifestVersion").GetInt32();
        if (version > Version) throw new RpcPortableSnapshot.RefusedException($"this manifest is version {version} and this implementation reads up to {Version}", "manifestVersion");
        var contract = root.GetProperty("contract");
        var state = root.GetProperty("state");
        var online = root.GetProperty("onlineChange");
        return new RpcRevisionManifest
        {
            ManifestVersion = version,
            ComponentType = root.GetProperty("componentType").GetString()!,
            RevisionId = root.GetProperty("revisionId").GetString()!,
            ArtifactType = ArtifactType(root.GetProperty("artifactType").GetString()!),
            ArtifactHash = root.GetProperty("artifactHash").GetString()!,
            Contract = new RpcContractReference
            {
                Id = contract.GetProperty("id").GetString()!,
                Version = contract.GetProperty("version").GetInt32(),
                SchemaHash = contract.GetProperty("schemaHash").GetString()!
            },
            State = new RpcStateReference
            {
                SchemaId = state.GetProperty("schemaId").GetString()!,
                Version = state.GetProperty("version").GetInt32(),
                SchemaHash = state.GetProperty("schemaHash").GetString()!
            },
            RequiredCapabilities = root.TryGetProperty("requiredCapabilities", out var capabilities) ? capabilities.EnumerateArray().Select(one => one.GetString()!).ToList() : [],
            OnlineChange = new RpcOnlineChangeProfile
            {
                Supported = online.GetProperty("supported").GetBoolean(),
                SerialisedHandlers = online.GetProperty("serialisedHandlers").GetBoolean(),
                RuntimeManagedObligations = online.GetProperty("runtimeManagedObligations").GetBoolean(),
                QuiescenceDeadlineMs = online.GetProperty("quiescenceDeadlineMs").GetInt32()
            },
            ManifestHash = root.GetProperty("manifestHash").GetString()!
        };
    }

    private static RpcArtifactType ArtifactType(string value) =>
        value switch
        {
            "javascript" => RpcArtifactType.JavaScript,
            "dotnet" => RpcArtifactType.DotNet,
            "wasm" => RpcArtifactType.Wasm,
            "native" => RpcArtifactType.Native,
            "source-ir" => RpcArtifactType.SourceIr,
            _ => throw new RpcPortableSnapshot.RefusedException($"artifactType is \"{value}\", which this implementation does not know", "artifactType")
        };
}
