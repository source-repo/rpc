# Cross-language handoff fixtures

Four documents, read verbatim by the TypeScript suite in `packages/continuity` and by the .NET suite in `packages/csharp/SourceRpc.Tests`. Neither generates them, and that is the point: a fixture the code constructs agrees with whatever the code now does, which is the one thing a regression test must not do. These were produced once, by the TypeScript implementation, and committed.

What they are for is one claim, and it is the claim the whole cross-language phase rests on: **a snapshot written by one language verifies to the same content hash in the other.** Two implementations that both compute a digest are not two implementations of one digest until one file has been asked of both and the answers compared.

## `mixer-handoff.json`

A `quiescent-handoff` capture with **every obligation kind present**, so a port that forgot one fails here rather than in a plant. It also carries a migration record with a defaulted value, because provenance is inside the hash and a reader that skipped it would verify a snapshot it had not fully read.

Three of its positions are past 2^53:

```
"lastAppliedInputSequence": "9007199254740993"
"lastCommittedOutputSequence": "9007199254740992"
"lastAcknowledgedSequence": "9007199254740991"
```

`9007199254740993` is the smallest integer a double cannot represent — it round-trips through IEEE-754 as `9007199254740992`, silently. That is why every position on the wire is a decimal string and why reading one from a JSON *number* is refused rather than converted: a successor that starts at a rounded sequence position reprocesses input or skips it, with no indication at the time and no way to tell afterwards which happened. A reader that treats these as numbers passes every other check in this directory and fails this one, which is exactly what it is here to do.

## `mixer-held-state-only.json`

The same component, captured as values only. It exists so that both implementations agree about a snapshot that is *not* admissible for a handoff — `admissibleForHandoff` must refuse it, and refuse it for the right reason.

## `dotnet-rev-2.manifest.json`

A revision manifest for a .NET replacement of a TypeScript activation. Its `state.schemaId`, `state.version` and `state.schemaHash` are the ones `mixer-handoff.json` carries, so `reconcile` agrees and reports no migration needed. Its `requiredCapabilities` are deliberately three, out of order in the source, and sorted in the file — a manifest listing the same capabilities in a different order is the same manifest, and an artifact rebuilt on a machine that walked its imports differently must not read as a different revision.

## `oven-journal.json`

Six entries, chained, covering all four entry kinds — a state transition, three inputs, an obligation and an ownership change. A journal is what turns `failed-after-commit`'s *recover forward* into a procedure, and a .NET activation that has taken over from a TypeScript one is exactly the case where both implementations have to agree about what the record says.

Its claim is stronger than a snapshot's, and deliberately: a snapshot hash is over one document, while a chain is over every document **and the order they are in**. Each entry carries the hash of the one before it, so an entry altered in place fails its own hash and one removed from the middle breaks the link — and both suites check that against the same bytes.

Its three input positions are consecutive and past 2^53:

```
"inputSequence": "9007199254740993"
"inputSequence": "9007199254740994"
"inputSequence": "9007199254740995"
```

Consecutive on purpose, because that is what a replay needs: the plan from a snapshot at `…993` is exactly `…994` and `…995`, and both implementations must produce it. The first of them is `9007199254740992` as a double — a position that is not itself — so a reader that took these as numbers would begin a replay one input earlier than the snapshot reached and re-apply a command, with nothing at the time to say so. The .NET suite cannot even write the assertion for the other half of that: the literal `9007199254740993d` is already `9007199254740992` by the time the compiler is done with it.

## Changing these

Don't, unless the format itself changed. If it did: bump `snapshotFormatVersion` or `manifestVersion`, add a new file beside the old one, and keep the old one — an implementation that can no longer read what it wrote last year is the failure these are here to catch.
