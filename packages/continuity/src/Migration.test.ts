import test from 'ava'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrate, sealSnapshot, RpcMigrations, RpcStateSchemas, type RpcMigrationScribe, type RpcMigrationStep, type RpcSnapshotEnvelope } from './index.js'
import { OVEN_SCHEMAS, ovenMigrations, ovenSchemas } from './Fixture.js'

/**
 * Taking a component's state forward, and refusing to.
 *
 * The three outcomes are not degrees of success. `total` says the old state determined the new one.
 * `defaulted` says a value came from a decision somebody reviewed, and names it. `impossible` says
 * a question needs a person - and answering it by inventing a value is the one failure a state
 * migration must never have, because nothing downstream can tell an invented value from a measured
 * one.
 */

/**
 * Read verbatim from disk, never constructed here.
 *
 * A fixture the code builds agrees with whatever the code now does, which is the one thing a
 * regression test must not do - it would pass through exactly the change it exists to catch. The
 * path is relative to `dist`, because that is where a compiled test runs from.
 */
const golden = (version: number): RpcSnapshotEnvelope =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../golden/oven-v${version}.json`, import.meta.url)), 'utf8')) as RpcSnapshotEnvelope

test('a supported old snapshot reaches the current version through the adjacent chain', async (t) => {
    const result = await migrate(golden(1), { schemas: await ovenSchemas(3), migrations: ovenMigrations() })
    t.is(result.outcome, 'defaulted')
    if (result.outcome === 'impossible') return
    t.is(result.snapshot.stateVersion, 3)
    t.deepEqual(result.snapshot.heldState, { zones: { main: { targetC: 180 } }, mode: 'heating', unit: 'C' })
    t.is(result.records.length, 2, 'v1 to v3 is two adjacent steps, not one transform somebody wrote for the pair')
})

test('provenance names every migration, every field moved, and every value decided', async (t) => {
    const result = await migrate(golden(1), { schemas: await ovenSchemas(3), migrations: ovenMigrations() })
    if (result.outcome === 'impossible') return t.fail(result.refusal.why)

    t.deepEqual(
        result.snapshot.provenance.map((record) => record.stepId),
        ['oven.state/1-2/setpoint-is-celsius', 'oven.state/2-3/one-zone-becomes-many']
    )
    const first = result.snapshot.provenance[0]
    t.deepEqual([...first.transformed], ['targetC'])
    t.is(first.defaulted[0].path, 'unit')
    t.is(first.defaulted[0].value, 'C')
    // The sentence, not the fact: six months later the question is never "was a default applied",
    // it is who chose this and against what.
    t.regex(first.defaulted[0].why, /commissioned in Celsius/)
    t.is(first.approval.by, 'process engineering')
    t.is(first.approval.reference, 'PR #412')
    t.truthy(first.inputHash)
    t.is(first.outputHash, result.snapshot.provenance[1].inputHash, 'the chain links, so it can be re-walked')
    t.is(result.snapshot.parentSnapshotHash, golden(1).contentHash)
})

test('an unsuppliable value refuses, naming the field and why nobody may invent it', async (t) => {
    const result = await migrate(golden(3), { schemas: await ovenSchemas(4), migrations: ovenMigrations() })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.is(result.refusal.path, 'calibratedAt')
    t.is(result.refusal.stepId, 'oven.state/3-4/calibration-date')
    t.is(result.refusal.atVersion, 3)
    t.regex(result.refusal.why, /claim about work somebody did/)
})

test('two runs over one input produce the same snapshot, hash included', async (t) => {
    // Which is what makes a dry run worth anything: there is no separate dry-run path, so the thing
    // that was checked is the thing that runs. A derived snapshot carries its parent's capturedAt,
    // because deriving is not observing - and that is what keeps a clock out of the answer.
    const options = { schemas: await ovenSchemas(3), migrations: ovenMigrations() }
    const first = await migrate(golden(1), options)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await migrate(golden(1), options)
    if (first.outcome === 'impossible' || second.outcome === 'impossible') return t.fail('the chain refused')
    t.is(first.snapshot.contentHash, second.snapshot.contentHash)
    t.deepEqual(first.snapshot, second.snapshot)
    t.is(first.snapshot.capturedAt, golden(1).capturedAt)
})

test('every released path runs against its golden snapshot', async (t) => {
    // The criterion that is about the suite rather than the code: a migration is only maintained if
    // something walks it. Driven from the registry rather than a list here, so a step added without
    // a golden to walk it fails this rather than being quietly unexercised.
    const schemas = await ovenSchemas(3)
    const migrations = ovenMigrations()
    for (const from of [1, 2]) {
        const result = await migrate(golden(from), { schemas, migrations, toVersion: from + 1 })
        t.not(result.outcome, 'impossible', `v${from} to v${from + 1} refused its own golden snapshot`)
        if (result.outcome === 'impossible') continue
        t.is(result.snapshot.stateVersion, from + 1)
        // And the step's own output is what the next version's golden holds, which is what makes
        // these one lineage rather than three unrelated files.
        t.deepEqual(result.snapshot.heldState, golden(from + 1).heldState)
    }
})

test('a gap in the chain is named rather than jumped', async (t) => {
    const schemas = await ovenSchemas(3)
    const migrations = new RpcMigrations()
    const result = await migrate(golden(1), { schemas, migrations })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.regex(result.refusal.why, /no reviewed migration from oven\.state v1 to v2/)
})

test('migration is forward only, and says why rather than pretending to undo', async (t) => {
    const result = await migrate(golden(3), { schemas: await ovenSchemas(3), migrations: ovenMigrations(), toVersion: 1 })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.regex(result.refusal.why, /forward only/)
})

test('a transform reading a clock is caught by the party in a position to catch it', async (t) => {
    // "Transforms are deterministic" is a rule in a document until something checks it. Each step
    // runs twice over one immutable input and the two outputs are compared, which catches the two
    // that actually happen: a clock and a random value.
    const schemas = new RpcStateSchemas()
    await schemas.register({ schemaId: 'drift', version: 1, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } } } } })
    await schemas.register({ schemaId: 'drift', version: 2, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } }, at: { type: { kind: 'number' } } } } })
    const migrations = new RpcMigrations().register({
        id: 'drift/1-2',
        schemaId: 'drift',
        from: 1,
        approval: { by: 'nobody', reference: 'none' },
        apply: (state: { a: number }, say: RpcMigrationScribe) => {
            say.defaulted('at', 0, 'stamped when the migration ran')
            return { ...state, at: Date.now() + Math.random() }
        }
    } as unknown as RpcMigrationStep)

    const snapshot = await sealSnapshot({
        captureKind: 'held-state-only',
        componentType: 'x',
        componentId: 'x1',
        sourceRevision: 'r',
        stateSchemaId: 'drift',
        stateVersion: 1,
        stateSchemaHash: schemas.hashAt('drift', 1)!,
        heldState: { a: 1 },
        provenance: [],
        capturedAt: '2026-03-14T09:15:00.000Z'
    })
    const result = await migrate(snapshot, { schemas, migrations })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.regex(result.refusal.why, /two different results from one input/)
})

test('a transform that writes to its input fails rather than being obeyed', async (t) => {
    const schemas = new RpcStateSchemas()
    for (const version of [1, 2]) await schemas.register({ schemaId: 'mut', version, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } } } } })
    const migrations = new RpcMigrations().register({
        id: 'mut/1-2',
        schemaId: 'mut',
        from: 1,
        approval: { by: 'nobody', reference: 'none' },
        apply: (state: { a: number }) => {
            state.a = 99
            return state
        }
    } as unknown as RpcMigrationStep)

    const snapshot = await sealSnapshot({
        captureKind: 'held-state-only',
        componentType: 'x',
        componentId: 'x1',
        sourceRevision: 'r',
        stateSchemaId: 'mut',
        stateVersion: 1,
        stateSchemaHash: schemas.hashAt('mut', 1)!,
        heldState: { a: 1 },
        provenance: [],
        capturedAt: '2026-03-14T09:15:00.000Z'
    })
    await t.throwsAsync(migrate(snapshot, { schemas, migrations }), { message: /read only|not extensible|Cannot assign/ })
    t.is(snapshot.heldState.a, 1, 'and the caller keeps its own snapshot')
})

test('a corrupt snapshot is refused before any transform sees it', async (t) => {
    const tampered = { ...golden(1), heldState: { setpoint: 300, mode: 'heating' } }
    const result = await migrate(tampered, { schemas: await ovenSchemas(3), migrations: ovenMigrations() })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.regex(result.refusal.why, /hashes to/)
})

test('a snapshot claiming a schema this process spells differently is refused', async (t) => {
    // The case that would otherwise migrate the wrong values quietly: the version number matches and
    // the shape does not, because the version was redefined somewhere this process never saw.
    const schemas = new RpcStateSchemas()
    await schemas.register({ ...OVEN_SCHEMAS[0], schema: { kind: 'object', fields: { setpoint: { type: { kind: 'string' } }, mode: { type: { kind: 'string' } } } } })
    await schemas.register(OVEN_SCHEMAS[1])
    const result = await migrate(golden(1), { schemas, migrations: ovenMigrations() })
    t.is(result.outcome, 'impossible')
    if (result.outcome !== 'impossible') return
    t.regex(result.refusal.why, /and this process has that version hashing/)
})

test('two steps for one adjacent pair are refused, because load order would decide which ran', async (t) => {
    const migrations = new RpcMigrations().register({ id: 'a', schemaId: 's', from: 1, approval: { by: 'x', reference: 'y' }, apply: (s: unknown) => s } as RpcMigrationStep)
    t.throws(() => migrations.register({ id: 'b', schemaId: 's', from: 1, approval: { by: 'x', reference: 'y' }, apply: (s: unknown) => s } as RpcMigrationStep), {
        message: /already migrates through a/
    })
})

test('a step with no recorded approval is refused', async (t) => {
    // A default or a conversion is a decision, and an unattributed decision is not reviewable.
    const migrations = new RpcMigrations()
    t.throws(() => migrations.register({ id: 'a', schemaId: 's', from: 1, approval: { by: '', reference: '' }, apply: (s: unknown) => s } as RpcMigrationStep), {
        message: /carries no approval/
    })
})

test('state that cannot leave this language is refused, which is the rule the design rests on', async (t) => {
    const schemas = new RpcStateSchemas()
    for (const version of [1, 2]) await schemas.register({ schemaId: 'fn', version, schema: { kind: 'object', fields: { a: { type: { kind: 'any' } } } } })
    const migrations = new RpcMigrations().register({ id: 'fn/1-2', schemaId: 'fn', from: 1, approval: { by: 'x', reference: 'y' }, apply: (s: unknown) => s } as RpcMigrationStep)
    const snapshot = await sealSnapshot({
        captureKind: 'held-state-only',
        componentType: 'x',
        componentId: 'x1',
        sourceRevision: 'r',
        stateSchemaId: 'fn',
        stateVersion: 1,
        stateSchemaHash: schemas.hashAt('fn', 1)!,
        // A closure in the state is the shape of everything that cannot survive the process holding
        // it - which is what the design says state must never be.
        heldState: { a: () => 1 },
        provenance: [],
        capturedAt: '2026-03-14T09:15:00.000Z'
    })
    await t.throwsAsync(migrate(snapshot, { schemas, migrations }), { message: /cannot be structured-cloned/ })
})
