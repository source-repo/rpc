# @source-repo/continuity

What a [Source RPC](https://github.com/source-repo/rpc) component keeps when the process implementing it is replaced: versioned state snapshots, adjacent forward migrations with reviewed defaults, and a record of every value that moved.

**Phase 1 of the online-change design, and it makes no claim of live process replacement.** What is here is the snapshot and the migration of held state — enough to take a component's state forward across a schema change and to prove afterwards which value came from where. Handing an activation over needs the obligations a running one holds, and that is the next phase; `admissibleForHandoff` refuses rather than letting a caller find the gap at the barrier.

## Why held state is explicit

A logical component outlives any one activation of it. The values it carries between handlers cannot live only in a process's object layout, its closures or its stacks, because none of those can be handed over — so they are captured explicitly, versioned explicitly, and named by what they contain.

That rule is enforced rather than documented: state is `structuredClone`d before every migration step, and state that cannot be cloned is refused with the reason. A closure in a state field is the shape of everything that cannot survive the process holding it.

## A snapshot says what it is

```typescript
const snapshot = await sealSnapshot({
    captureKind: 'held-state-only',
    componentType: 'oven',
    componentId: 'oven3',
    sourceRevision: 'rev-1',
    stateSchemaId: 'oven.state',
    stateVersion: 1,
    stateSchemaHash: schemas.hashAt('oven.state', 1)!,
    heldState: { setpoint: 180, mode: 'heating' },
    provenance: [],
    capturedAt: '2026-03-14T09:15:00.000Z'
})
```

A snapshot found on a disk, in a bucket or in a message has to be readable without whatever wrote it being present to explain, so every question a restorer will ask is answered on the envelope — and one that cannot answer them is refused where it is written rather than where it is used.

**The two capture kinds are not degrees of completeness.** `held-state-only` says *these were the values*. `quiescent-handoff` says *these were the values, at this position in the input, under this activation*. The second is a statement about an instant, which is why a partial one cannot be written at all.

## One reviewed transform per adjacent version

vK to vN applies K→K+1 through N−1→N in order. That is V−1 transforms to maintain rather than one per version pair — and, more to the point, one place per version where somebody had to decide what a new field means. A direct K→N transform is a decision nobody reviewed, taken about versions that were never adjacent.

```typescript
const step: RpcMigrationStep<OvenV1, OvenV2> = {
    id: 'oven.state/1-2/setpoint-is-celsius',
    schemaId: 'oven.state',
    from: 1,
    approval: { by: 'process engineering', reference: 'PR #412' },
    apply(state, say) {
        say.transformed('targetC')
        say.defaulted('unit', 'C', 'every oven in service at v1 was commissioned in Celsius')
        return { targetC: state.setpoint, mode: state.mode, unit: 'C' }
    }
}
```

Three outcomes, and they are not degrees of success. **`total`** — the old state determined the new one. **`defaulted`** — a value came from a decision somebody reviewed, and the record names the field, the value and the grounds. **`impossible`** — a question needs a person, and `say.impossible(path, why)` refuses the whole chain rather than inventing something nothing downstream could tell from a measured value.

`why` is not optional on a default. Six months later the question is never *was a default applied*; it is *who chose 20 °C, and against what*.

## There is no separate dry run

A dry run executing different code from the committed one proves nothing about the committed one. `migrate` is a pure function of an immutable snapshot, and a dry run is calling it and not storing the answer. Two calls over one input produce the same snapshot in every field, hash included, because nothing here reads a clock — a derived snapshot carries its parent's `capturedAt`, since deriving is not observing.

**Every step runs twice and its two outputs are compared.** That is how *transforms are deterministic* becomes a checked property rather than a rule in a document: a clock or a random value is caught by the only party in a position to catch it. There is deliberately no way to turn it off, because an off switch is what gets flipped when the check fires.

## Provenance

Every step records its id, its approval, the fields it transformed, the values it defaulted with their reasons, and the canonical hash of its input and output — so a chain can be re-walked and a snapshot four versions along can say which value was decided at v2 without the v2 snapshot being present.

## Golden snapshots

`golden/` holds one real snapshot per released state version, retained as a file rather than built by a test. A fixture the code constructs agrees with whatever the code now does, which is the one thing a regression test must not do. A golden snapshot demonstrates a known case; it does not by itself prove a transform is total.

## What is not here

Reverse migrations. The pre-migration snapshot is what a rollback uses, and only until the new activation has begun authoritative work — after that, restoring it would lose history and might repeat effects. A reverse chain would look like a general undo and would not be one.

## License

MIT
