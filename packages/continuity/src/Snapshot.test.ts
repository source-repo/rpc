import test from 'ava'
import { admissibleForHandoff, sealSnapshot, verifySnapshot, RpcSnapshotRefused, RpcStateSchemas, stateSchemaHash } from './index.js'
import { OVEN_SCHEMA, ovenSchemas } from './Fixture.js'

/**
 * What a snapshot has to say about itself.
 *
 * A snapshot found on a disk, in a bucket or in a message has to be readable without whatever wrote
 * it being present to explain - so every question a restorer will ask is answered on the envelope,
 * and one that cannot answer them is refused where it is written rather than where it is used.
 */

const draft = async (over: Record<string, unknown> = {}) => {
    const schemas = await ovenSchemas()
    return {
        captureKind: 'held-state-only' as const,
        componentType: 'oven',
        componentId: 'oven3',
        sourceRevision: 'rev-1',
        stateSchemaId: OVEN_SCHEMA,
        stateVersion: 1,
        stateSchemaHash: schemas.hashAt(OVEN_SCHEMA, 1)!,
        heldState: { setpoint: 180, mode: 'heating' },
        provenance: [],
        capturedAt: '2026-03-14T09:15:00.000Z',
        ...over
    }
}

test('a snapshot says what it is without anything else being present', async (t) => {
    const snapshot = await sealSnapshot(await draft())
    for (const field of ['componentType', 'componentId', 'sourceRevision', 'stateSchemaId', 'stateVersion', 'stateSchemaHash', 'captureKind', 'contentHash'] as const)
        t.truthy(snapshot[field], field)
    t.is(await verifySnapshot(snapshot), undefined)
})

test('a snapshot that cannot say what it is, is refused where it is written', async (t) => {
    // Rather than where it is read, which is a restore, which is a plant.
    for (const [field, over] of [
        ['componentType', { componentType: '' }],
        ['componentId', { componentId: '' }],
        ['sourceRevision', { sourceRevision: '' }],
        ['stateSchemaId', { stateSchemaId: '' }],
        ['stateSchemaHash', { stateSchemaHash: '' }],
        ['stateVersion', { stateVersion: -1 }]
    ] as const) {
        const refusal = await t.throwsAsync(sealSnapshot(await draft(over)), { instanceOf: RpcSnapshotRefused })
        t.is(refusal!.path, field)
    }
})

test('a handoff capture is a statement about one instant, or it is refused', async (t) => {
    // The two kinds are not degrees of completeness. A partial statement about an instant is a
    // statement about nothing, so it cannot be written at all.
    const refusal = await t.throwsAsync(sealSnapshot(await draft({ captureKind: 'quiescent-handoff' })), { instanceOf: RpcSnapshotRefused })
    t.is(refusal!.path, 'activationEpoch')

    const whole = await sealSnapshot(
        await draft({ captureKind: 'quiescent-handoff', activationEpoch: 7n, logicalTime: 1200n, lastAppliedInputSequence: 9000n, lastCommittedOutputSequence: 8999n })
    )
    t.is(whole.captureKind, 'quiescent-handoff')
})

test('a handoff is admissible only once somebody has looked at what was outstanding', async (t) => {
    // The point of the function: "we have snapshots" must not be readable as "we can hand over". A
    // held-state-only capture is a statement about values and not about an instant, and a
    // quiescent-handoff one with no manifest is a component whose timers, calls in flight and
    // leases nobody enumerated - a successor told it had assumed everything when nothing was
    // recorded is the failure the whole capture path exists to prevent.
    const held = await sealSnapshot(await draft())
    t.regex(admissibleForHandoff(held)!, /says what the values were, not where the component had got to/)

    const unexamined = await sealSnapshot(
        await draft({ captureKind: 'quiescent-handoff', activationEpoch: 7n, logicalTime: 1200n, lastAppliedInputSequence: 9000n, lastCommittedOutputSequence: 8999n })
    )
    t.regex(admissibleForHandoff(unexamined)!, /carries no obligations manifest/)

    // Empty is a finding. A component that owes nothing owes nothing, and saying so is the
    // difference between an answer and a gap.
    const examined = await sealSnapshot(
        await draft({
            captureKind: 'quiescent-handoff',
            activationEpoch: 7n,
            logicalTime: 1200n,
            lastAppliedInputSequence: 9000n,
            lastCommittedOutputSequence: 8999n,
            obligations: { timers: [], outboundCalls: [], inboundWork: [], subscriptions: [], pendingPublications: [], leases: [], sequences: [], watchdogs: [] }
        })
    )
    t.is(admissibleForHandoff(examined), undefined)
})

test('the hash names the content, and notices when the content moves', async (t) => {
    const snapshot = await sealSnapshot(await draft())
    const tampered = { ...snapshot, heldState: { setpoint: 300, mode: 'heating' } }
    t.regex((await verifySnapshot(tampered))!, /hashes to/)
})

test('a derived snapshot is named by what it contains, so two runs of one migration agree', async (t) => {
    // A captured snapshot is named by whoever captured it; a derived one has nobody to name it, and
    // naming it by its content is what makes "dry run and commit produce the same output" a
    // property of the transform rather than a coincidence of when each ran.
    const named = await sealSnapshot(await draft({ snapshotId: 'chosen' }))
    t.is(named.snapshotId, 'chosen')
    const derived = await sealSnapshot(await draft())
    t.is(derived.snapshotId, derived.contentHash)
})

test('a schema version that has been published cannot be redefined in place', async (t) => {
    // Snapshots in the field carry its hash, so redefining it is how one comes to claim it was
    // validated against something it was not.
    const schemas = new RpcStateSchemas()
    await schemas.register({ schemaId: 'x', version: 1, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } } } } })
    await t.notThrowsAsync(schemas.register({ schemaId: 'x', version: 1, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } } } } }), 'the same shape again is what assembling a registry from several modules does')
    await t.throwsAsync(schemas.register({ schemaId: 'x', version: 1, schema: { kind: 'object', fields: { a: { type: { kind: 'string' } } } } }), { message: /cannot be redefined/ })
})

test('a schema hashes to the same value however its description was written', async (t) => {
    const one = await stateSchemaHash({ schemaId: 'x', version: 1, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } }, b: { type: { kind: 'string' } } } } })
    const two = await stateSchemaHash({ schemaId: 'x', version: 1, schema: { kind: 'object', fields: { b: { type: { kind: 'string' } }, a: { type: { kind: 'number' } } } } })
    t.is(one, two)
    // And a shape reused at two versions is two schemas, since most versions change one field.
    const three = await stateSchemaHash({ schemaId: 'x', version: 2, schema: { kind: 'object', fields: { a: { type: { kind: 'number' } }, b: { type: { kind: 'string' } } } } })
    t.not(one, three)
})
