# SourceRpc.Continuity

Read, verify and take over a [Source RPC](https://github.com/source-repo/rpc) component's state, in .NET: the snapshot envelope, the revision manifest, the obligations a running activation was holding, the journal of what it did between snapshots, and the rules that decide whether a .NET revision may replace a TypeScript one.

Beside `SourceRpc` rather than in it, for `SourceRpc.Query`'s reason: a device binding that answers calls and is never replaced online should not carry the snapshot envelope, the obligation vocabulary and the restore rules to reach a network it only ever serves. Unlike `SourceRpc.Query` it takes no dependency at all beyond the core — what it does is read a document and apply rules, and both of those are arithmetic. That is deliberate. This runs in the process that is about to become authoritative for a piece of plant, and the fewer things that have to load correctly before it can say *no*, the better.

## The one claim

**A snapshot written by one language verifies to the same content hash in the other.** Everything else here follows from that; without it, two revisions being interface-compatible says nothing about whether they agree on what the state *is*.

```csharp
var snapshot = RpcPortableSnapshot.Read(File.ReadAllText("mixer-handoff.json"));
if (RpcSnapshots.Verify(snapshot) is { } wrong) throw new Exception(wrong);
if (RpcSnapshots.AdmissibleForHandoff(snapshot) is { } why) throw new Exception(why);
```

It is checked rather than asserted: the fixtures under `packages/conformance/fixtures/continuity` are read verbatim by this suite and by the TypeScript one, and two implementations that both compute a digest are not two implementations of one digest until a single file has been asked of both.

## What it did between the snapshots

A snapshot describes one instant. A journal describes what happened between them, and it is what turns a coordinator's `failed-after-commit` — *recover forward* — into something a .NET successor can actually carry out.

```csharp
var entries = RpcPortableJournal.Read(File.ReadAllText("oven-journal.json"));
if (RpcJournals.Verify(entries) is { } broken) throw new Exception(broken);

var plan = RpcJournals.ReplayableFrom(snapshot, entries);
if (plan.Refused is { } why) throw new Exception(why);   // a gap refuses; it never replays what is left
```

The claim here is stronger than the snapshot's, and checked against the same fixture: a snapshot hash is over one document, while a **chain** is over every document and the order they are in. An entry altered in place fails its own hash and one removed from the middle breaks the link, in both implementations, over the same bytes.

**A gap refuses.** A journal missing input 41 can still apply 42 onwards, and the state that results never existed in the plant — it is the state of a component that received one fewer input than it did. It would look exactly like a recovery.

## Positions are decimal strings

JSON has one numeric type and it is an IEEE-754 double. `9007199254740993` — the smallest integer a double cannot represent — round-trips as `9007199254740992`, silently, and a successor that starts at a rounded sequence position reprocesses input or skips it, with no indication at the time and no way to tell afterwards which happened.

So every position crosses as a string, and a position that arrived as a JSON *number* is **refused rather than converted**. Nothing here can tell whether the value was small enough to have survived, and converting it would launder a rounding error into an authoritative sequence position.

## Nothing is defaulted

An unknown capture kind, an unknown timer policy, a snapshot format ahead of this reader, a `semantics` this implementation does not know: each is a refusal naming the field, never a fallback. A reader lenient enough to take this document is lenient enough to take one that says something else.

That is stronger than it sounds for a timer policy. There is no default because every policy is right for something and catastrophic for something else — a dwell that restarts has doubled a bake, a watchdog that preserved its deadline fires the instant the successor comes up — so a policy guessed at is a plant behaviour nobody chose.

## Silence is not a claim

`RpcRestore.Plan` pairs the incumbent's obligations manifest against what this revision declares about each. An obligation it says nothing about resolves to `Unhonourable`, never `Assumed`, and the plan refuses on the first one nobody can honour rather than reporting a plan with a hole in it.

The rule matters more across a language boundary than within one. This revision has no compiler in common with the incumbent: what it knows about the work outstanding is what the snapshot says, and every disposition it claims is a claim.

## A manifest describes a revision and does not approve one

`RpcRevisionManifest` is what an artifact says about itself — component type, contract hash, state schema hash, required capabilities, and whether it can be changed online at all. `RpcManifests.Reconcile` measures it against a snapshot; `RpcManifests.Authorised` measures it against an identity policy the deployment owns.

An artifact that could authorise itself by asserting its own capabilities would make the whole approval path decorative, so an unapproved artifact hash, a capability outside the envelope, and an identity not eligible for online change are three different refusals rather than one shrug.

## License

MIT
