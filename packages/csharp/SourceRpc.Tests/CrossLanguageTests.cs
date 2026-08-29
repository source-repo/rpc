using System.Text.Json;
using SourceRpc.Continuity;

namespace SourceRpc.Tests;

/// <summary>
/// The other half of the cross-language claim.
///
/// These read the same files the TypeScript suite reads, and ask the same questions of them.
/// Two implementations that both compute a digest are not two implementations of one digest until
/// one file has been asked of both and the answers compared - everything else is two suites that
/// are green about different things.
/// </summary>
public class CrossLanguageTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name));

    private static RpcSnapshotEnvelope Handoff() => RpcPortableSnapshot.Read(Fixture("mixer-handoff.json"));

    [Fact]
    public void A_snapshot_written_by_TypeScript_verifies_to_the_same_hash_here()
    {
        // The claim the whole phase rests on. If this fails, nothing else about the two revisions
        // being interface-compatible matters: they do not agree about what the state *is*.
        var snapshot = Handoff();
        Assert.Null(RpcSnapshots.Verify(snapshot));
        Assert.Equal("McY0gkGLUUc6KlTfmIudWcLKdJ9nXG2S3qhO_iBMw9o", snapshot.ContentHash);
    }

    [Fact]
    public void A_position_past_2_to_the_53_arrives_intact()
    {
        var snapshot = Handoff();
        Assert.Equal(9007199254740993L, snapshot.LastAppliedInputSequence);
        Assert.Equal(9007199254740991L, snapshot.Obligations!.Subscriptions[0].LastAcknowledgedSequence);
        Assert.Equal(9007199254740990L, snapshot.Obligations.Sequences[0].Position);
        // Nested, and the one a top-level walk would have missed on either side.
        Assert.Equal(60_000L, snapshot.Obligations.Timers[0].Periodic!.Interval);

        // What a double makes of it, which is why the field is not one.
        Assert.Equal(9007199254740992d, (double)9007199254740993L);
    }

    [Fact]
    public void A_position_that_arrived_as_a_JSON_number_is_refused_rather_than_converted()
    {
        var mangled = Fixture("mixer-handoff.json").Replace("\"lastAppliedInputSequence\": \"9007199254740993\"", "\"lastAppliedInputSequence\": 9007199254740993");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableSnapshot.Read(mangled));
        Assert.Equal("lastAppliedInputSequence", refusal.Path);
        Assert.Contains("already been through a double", refusal.Message);
    }

    [Fact]
    public void Every_obligation_kind_in_the_fixture_is_understood()
    {
        // A kind this implementation had forgotten would come back as an empty group and read as
        // "the incumbent owed nothing of that sort", which is the failure the manifest exists to
        // prevent. Counting them is how the fixture enforces that the port is complete.
        var obligations = Handoff().Obligations!;
        Assert.Equal(8, obligations.All.Count);
        Assert.Equal("mix-dwell", obligations.Timers[0].Id);
        Assert.Equal(RpcTimerPolicy.PreserveRemaining, obligations.Timers[0].Policy);
        Assert.Equal(RpcMethodSemantics.NonRepeatableCommand, obligations.OutboundCalls[0].Semantics);
        Assert.Equal("batch-19/dispense", obligations.OutboundCalls[0].IdempotencyKey);
        Assert.True(obligations.InboundWork[0].Mutating);
        Assert.True(obligations.Leases[0].IssuerSupportsLogicalOwner);
        Assert.Equal(RpcTimerPolicy.FireOnActivation, obligations.Watchdogs[0].Policy);
    }

    [Fact]
    public void A_held_state_only_capture_is_refused_here_for_the_same_reason()
    {
        var held = RpcPortableSnapshot.Read(Fixture("mixer-held-state-only.json"));
        Assert.Null(RpcSnapshots.Verify(held));
        Assert.Contains("says what the values were, not where the component had got to", RpcSnapshots.AdmissibleForHandoff(held));
    }

    [Fact]
    public void A_manifest_may_be_empty_and_may_not_be_absent()
    {
        Assert.Null(RpcSnapshots.AdmissibleForHandoff(Handoff()));

        // A component that owes nothing owes nothing, and saying so is a finding. A missing manifest
        // means nobody looked, and a successor told it had assumed everything when nothing was
        // recorded is the failure the whole capture path exists to prevent.
        Assert.Contains("nothing is known about the work the old activation still owed", RpcSnapshots.AdmissibleForHandoff(Handoff() with { Obligations = null }));
        Assert.Null(RpcSnapshots.AdmissibleForHandoff(Handoff() with { Obligations = new RpcObligations() }));

        // And a handoff capture missing a position does not describe one instant, whichever it is.
        Assert.Contains("missing lastAppliedInputSequence", RpcSnapshots.AdmissibleForHandoff(Handoff() with { LastAppliedInputSequence = null }));
        Assert.Contains("missing activationEpoch", RpcSnapshots.AdmissibleForHandoff(Handoff() with { ActivationEpoch = null }));
    }

    [Fact]
    public void A_dotnet_manifest_verifies_and_agrees_with_the_TypeScript_snapshot()
    {
        var manifest = RpcManifests.Read(Fixture("dotnet-rev-2.manifest.json"));
        Assert.Null(RpcManifests.Verify(manifest));
        Assert.Equal("v4cabJGjDJIqz9dHPCmZ-S52RpEkJO1A_JOv4L7jzF0", manifest.ManifestHash);
        Assert.Equal(RpcArtifactType.DotNet, manifest.ArtifactType);

        var reconciled = RpcManifests.Reconcile(manifest, Handoff());
        Assert.True(reconciled.Agreed);
        Assert.False(reconciled.MigrationNeeded);
    }

    [Fact]
    public void A_manifest_describes_a_revision_and_does_not_approve_one()
    {
        var manifest = RpcManifests.Read(Fixture("dotnet-rev-2.manifest.json"));
        var policy = new RpcIdentityPolicy
        {
            ComponentId = "mixer1",
            ComponentType = "mixer",
            ApprovedArtifacts = [],
            CapabilityEnvelope = manifest.RequiredCapabilities,
            OnlineChangePermitted = true
        };
        Assert.Contains("it does not approve one", RpcManifests.Authorised(manifest, policy));

        var approved = policy with { ApprovedArtifacts = [manifest.ArtifactHash] };
        Assert.Null(RpcManifests.Authorised(manifest, approved));
        Assert.Contains("does not inherit an authority the identity never had", RpcManifests.Authorised(manifest, approved with { CapabilityEnvelope = ["plant.write"] }));
        Assert.Contains("controlled restart rather than a handoff", RpcManifests.Authorised(manifest, approved with { OnlineChangePermitted = false }));
    }

    [Fact]
    public void The_successor_plans_a_restore_from_a_snapshot_it_did_not_write()
    {
        // The acceptance criterion, from the side that has to act on it: a .NET revision reading a
        // TypeScript activation's outstanding work and saying what it will do with each of it.
        var snapshot = Handoff();
        var plan = RpcRestore.Plan(
            snapshot,
            [
                new RpcRestoreDeclaration { Id = "mix-dwell", Resolution = RpcResolution.Assumed, TimerPolicy = RpcTimerPolicy.PreserveRemaining },
                new RpcRestoreDeclaration { Id = "stir-watchdog", Resolution = RpcResolution.Assumed, TimerPolicy = RpcTimerPolicy.FireOnActivation },
                new RpcRestoreDeclaration { Id = "dispense-7", Resolution = RpcResolution.Completed },
                new RpcRestoreDeclaration { Id = "setpoint-441", Resolution = RpcResolution.Completed },
                new RpcRestoreDeclaration { Id = "alarms", Resolution = RpcResolution.Reestablished, Redelivery = RpcRedelivery.AtLeastOnceDeduplicated },
                new RpcRestoreDeclaration { Id = "batch-complete-18", Resolution = RpcResolution.Assumed },
                new RpcRestoreDeclaration { Id = "hopper-lock", Resolution = RpcResolution.Assumed },
                new RpcRestoreDeclaration { Id = "outbox", Resolution = RpcResolution.Assumed }
            ],
            new RpcRestoreClock { Now = 2_000 });

        Assert.True(plan.Admissible);
        Assert.Equal(8, plan.Entries.Count);
        // Fired on activation is not when it was due, so it is re-established rather than assumed -
        // the same answer the TypeScript implementation gives about the same timer.
        Assert.Equal(RpcResolution.Reestablished, plan.Entries.Single(entry => entry.Id == "stir-watchdog").Resolution);
    }

    [Fact]
    public void Silence_is_not_a_claim_here_either()
    {
        // The rule that matters most across a language boundary: a .NET revision has no compiler in
        // common with the TypeScript one, so everything it knows about the incumbent's obligations
        // is what the snapshot says, and every disposition it claims is a claim.
        var plan = RpcRestore.Plan(Handoff(), [], new RpcRestoreClock { Now = 2_000 });
        Assert.False(plan.Admissible);
        Assert.Contains("silence is not a claim", plan.Why);
        Assert.Equal(RpcResolution.Unhonourable, plan.Entries[0].Resolution);
    }

    [Fact]
    public void A_timer_with_no_declared_policy_refuses_because_there_is_no_default()
    {
        var plan = RpcRestore.Plan(Handoff(), [new RpcRestoreDeclaration { Id = "mix-dwell", Resolution = RpcResolution.Assumed }], new RpcRestoreClock { Now = 2_000 });
        Assert.False(plan.Admissible);
        Assert.Contains("doubled a bake", plan.Why);
    }

    [Fact]
    public void A_snapshot_format_this_implementation_does_not_know_is_refused_rather_than_read()
    {
        // A later format may differ in what a field *means* rather than in which fields exist, and
        // reading it anyway is how a successor comes to hold values it has misunderstood.
        var ahead = Fixture("mixer-handoff.json").Replace("\"snapshotFormatVersion\": 1", "\"snapshotFormatVersion\": 2");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableSnapshot.Read(ahead));
        Assert.Contains("reads up to 1", refusal.Message);
    }

    [Fact]
    public void A_timer_policy_this_implementation_does_not_know_is_refused_rather_than_defaulted()
    {
        var unknown = Fixture("mixer-handoff.json").Replace("\"policy\": \"preserve-remaining\"", "\"policy\": \"preserve-nothing\"");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableSnapshot.Read(unknown));
        Assert.Contains("a timer policy it guessed at is a doubled bake", refusal.Message);
    }

    [Fact]
    public void Held_state_arrives_as_the_values_it_was_rather_than_as_a_shape_a_deserialiser_guessed()
    {
        var held = Handoff().HeldState;
        Assert.Equal(3, held.GetProperty("batches").GetInt32());
        Assert.True(held.GetProperty("dwelling").GetBoolean());
        Assert.Equal(480.5, held.GetProperty("recipe").GetProperty("litres").GetDouble());
        Assert.Equal(2, held.GetProperty("tags").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, held.GetProperty("lastOperator").ValueKind);
    }

    [Fact]
    public void A_tampered_snapshot_fails_verification_here_as_it_would_there()
    {
        var tampered = Fixture("mixer-handoff.json").Replace("\"batches\": 3", "\"batches\": 4");
        var snapshot = RpcPortableSnapshot.Read(tampered);
        // The hash names the content, and the content moved. Nothing else about the document changed
        // - which is the point: a value edited in a file is not distinguishable from one edited in
        // transit, and neither should be restored.
        Assert.Contains("hashes to", RpcSnapshots.Verify(snapshot));
    }

    [Fact]
    public void A_capture_kind_this_implementation_does_not_know_is_refused_rather_than_guessed()
    {
        // Guessing "handoff" would be the convenient reading and the dangerous one: it is the kind
        // that claims to describe one instant with the outstanding work recorded, and a snapshot
        // read as one when it is not is a successor told it owes nothing.
        var unknown = Fixture("mixer-handoff.json").Replace("\"captureKind\": \"quiescent-handoff\"", "\"captureKind\": \"partial-cut\"");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableSnapshot.Read(unknown));
        Assert.Equal("captureKind", refusal.Path);
        Assert.Contains("one of held-state-only or quiescent-handoff", refusal.Message);
    }

    [Fact]
    public void Two_revisions_that_claim_one_schema_version_and_describe_it_differently_are_refused()
    {
        var manifest = RpcManifests.Read(Fixture("dotnet-rev-2.manifest.json"));
        var snapshot = Handoff();

        // A published version cannot be redefined, because snapshots in the field carry its hash.
        // One of these two did it anyway, and catching it here is what stops a migration running
        // against a description of the state that is not the one it was written under.
        var drifted = manifest with { State = manifest.State with { SchemaHash = "something-else" } };
        var refused = RpcManifests.Reconcile(drifted, snapshot);
        Assert.False(refused.Agreed);
        Assert.Contains("a published version cannot be redefined, and one of these two was", refused.Why);

        var older = RpcManifests.Reconcile(manifest with { State = manifest.State with { Version = 1 } }, snapshot);
        Assert.False(older.Agreed);
        Assert.Contains("migration is forward only, and this would be a rollback", older.Why);

        var wrongType = RpcManifests.Reconcile(manifest with { ComponentType = "oven" }, snapshot);
        Assert.False(wrongType.Agreed);
        Assert.Contains("two component types are not two versions of one", wrongType.Why);
    }

    [Fact]
    public void A_snapshot_at_an_older_state_version_reconciles_and_says_migration_is_needed()
    {
        // Reconciling is not "the same"; it is "these can be brought together". The version may
        // legitimately differ - that is what the migration chain is for - so it is reported rather
        // than refused, and separately from the identity mismatches that are never migratable.
        var manifest = RpcManifests.Read(Fixture("dotnet-rev-2.manifest.json"));
        var reconciled = RpcManifests.Reconcile(manifest with { State = manifest.State with { Version = 3, SchemaHash = "v3-hash" } }, Handoff());
        Assert.True(reconciled.Agreed);
        Assert.True(reconciled.MigrationNeeded);
    }

    private static IReadOnlyList<RpcJournalEntry> Journal() => RpcPortableJournal.Read(Fixture("oven-journal.json"));

    [Fact]
    public void A_journal_written_by_TypeScript_chains_to_the_same_hashes_here()
    {
        // The journal's equivalent of the snapshot claim, and it is a stronger one: a snapshot hash
        // is over one document, and a chain is over every document and the order they are in. If
        // this holds, the two implementations agree about what a component did and when.
        var entries = Journal();
        Assert.Equal(6, entries.Count);
        Assert.Null(RpcJournals.Verify(entries));
        Assert.Equal("urSBtdjl45PORyyKqQGVIJs24cJ6kgC4aTcygc2MwUo", entries[0].EntryHash);
        Assert.Equal("i0OGEM9qx9zB0-9kkX474yiMsgYQMV5iJo7V7URI0fs", entries[^1].EntryHash);
    }

    [Fact]
    public void Every_journal_entry_kind_in_the_fixture_is_understood()
    {
        // A kind this implementation had forgotten would refuse rather than be read as something
        // else, which is the point - but only if the fixture carries all of them.
        var kinds = Journal().Select(entry => entry.Kind).Distinct().OrderBy(kind => kind).ToList();
        Assert.Equal([RpcJournalEntryKind.Input, RpcJournalEntryKind.State, RpcJournalEntryKind.Obligation, RpcJournalEntryKind.Activation], kinds);
    }

    [Fact]
    public void An_input_position_past_2_to_the_53_arrives_intact_in_a_journal_too()
    {
        var inputs = Journal().Where(entry => entry.Kind == RpcJournalEntryKind.Input).ToList();
        Assert.Equal([9007199254740993L, 9007199254740994L, 9007199254740995L], inputs.Select(entry => entry.InputSequence!.Value));

        // The first of them is 9007199254740992 as a double - a position that is not itself. A
        // reader that took these as numbers would begin a replay one input earlier than the
        // snapshot actually reached, re-applying a command with nothing at the time to say so.
        // Writing the other half of that as an assertion is impossible, and instructively so: the
        // literal 9007199254740993d is already 9007199254740992 by the time the compiler is done
        // with it. The value cannot be named in the type the wire would have used.
        Assert.Equal(9007199254740992d, (double)9007199254740993L);
    }

    [Fact]
    public void A_journal_position_that_arrived_as_a_JSON_number_is_refused_rather_than_converted()
    {
        var mangled = Fixture("oven-journal.json").Replace("\"inputSequence\": \"9007199254740993\"", "\"inputSequence\": 9007199254740993");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableJournal.Read(mangled));
        Assert.Equal("inputSequence", refusal.Path);
        Assert.Contains("already been through a double", refusal.Message);
    }

    [Fact]
    public void An_entry_altered_after_it_was_written_fails_its_own_hash()
    {
        var mangled = Fixture("oven-journal.json").Replace("\"target\": 205", "\"target\": 900");
        var broken = RpcJournals.Verify(RpcPortableJournal.Read(mangled));
        Assert.NotNull(broken);
        Assert.Contains("its content changed after it was written", broken);
    }

    [Fact]
    public void A_dotnet_successor_can_work_out_what_it_would_have_to_replay()
    {
        // The case the whole phase is about: a .NET activation has taken over, the handoff failed
        // past the commit point, and this is what recovering forward would mean here.
        var snapshot = Handoff() with { ComponentId = "oven3", LastAppliedInputSequence = 9007199254740993L };
        var plan = RpcJournals.ReplayableFrom(snapshot, Journal());

        Assert.Null(plan.Refused);
        Assert.Equal(9007199254740993L, plan.FromInputSequence);
        Assert.Equal(9007199254740995L, plan.ToInputSequence);
        Assert.Equal([9007199254740994L, 9007199254740995L], plan.Inputs.Select(entry => entry.InputSequence!.Value));
    }

    [Fact]
    public void A_gap_refuses_here_for_the_same_reason_it_refuses_there()
    {
        var snapshot = Handoff() with { ComponentId = "oven3", LastAppliedInputSequence = 9007199254740991L };
        var plan = RpcJournals.ReplayableFrom(snapshot, Journal());

        Assert.NotNull(plan.Refused);
        Assert.Contains("a fabrication rather than a recovery", plan.Refused);
    }

    [Fact]
    public void An_unknown_journal_entry_kind_refuses_rather_than_being_read_as_something_else()
    {
        var unknown = Fixture("oven-journal.json").Replace("\"kind\": \"obligation\"", "\"kind\": \"speculation\"");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableJournal.Read(unknown));
        Assert.Equal("kind", refusal.Path);
    }

    [Fact]
    public void A_journal_format_from_the_future_is_refused_rather_than_read_optimistically()
    {
        var ahead = Fixture("oven-journal.json").Replace("\"journalFormatVersion\": 1", "\"journalFormatVersion\": 2");
        var refusal = Assert.Throws<RpcPortableSnapshot.RefusedException>(() => RpcPortableJournal.Read(ahead));
        Assert.Equal("journalFormatVersion", refusal.Path);
    }
}
