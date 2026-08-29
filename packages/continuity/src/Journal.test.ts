import test from 'ava'
import {
    RpcMemoryJournal,
    recoverForward,
    replay,
    replayableFrom,
    sealSnapshot,
    stateSchemaHash,
    verifyJournal,
    type RpcHandoffRecord,
    type RpcJournalEntry,
    type RpcSnapshotEnvelope
} from './index.js'

/**
 * What a component did between the instants a snapshot describes, and what that is good for.
 *
 * Most of these are refusals, and deliberately: a journal's value is entirely in what it will not
 * let somebody do. Replaying across a gap produces the state of a component that received one fewer
 * input than it did, which looks exactly like a recovery and is a fabrication - so the tests that
 * matter are the ones where it says no.
 */

interface OvenState extends Record<string, unknown> {
    setpoint: number
    batches: number
}

const schema = () =>
    stateSchemaHash({
        schemaId: 'oven.state',
        version: 1,
        schema: { kind: 'object', fields: { setpoint: { type: { kind: 'number' } }, batches: { type: { kind: 'number' } } } }
    })

const snapshotAt = async (lastAppliedInputSequence: bigint, state: OvenState = { setpoint: 210, batches: 19 }) =>
    (await sealSnapshot<OvenState>({
        captureKind: 'quiescent-handoff',
        componentType: 'oven',
        componentId: 'oven3',
        sourceRevision: 'rev-1',
        stateSchemaId: 'oven.state',
        stateVersion: 1,
        stateSchemaHash: await schema(),
        activationEpoch: 3n,
        logicalTime: 5_000n,
        lastAppliedInputSequence,
        lastCommittedOutputSequence: lastAppliedInputSequence - 1n,
        heldState: state,
        obligations: {
            timers: [],
            outboundCalls: [],
            inboundWork: [],
            subscriptions: [],
            pendingPublications: [],
            leases: [],
            sequences: [],
            watchdogs: []
        },
        provenance: [],
        capturedAt: '2026-03-14T03:14:00.000Z'
    })) as RpcSnapshotEnvelope

const journalWith = async (inputs: readonly bigint[]) => {
    const journal = new RpcMemoryJournal()
    for (const inputSequence of inputs)
        await journal.append({
            componentId: 'oven3',
            kind: 'input',
            epoch: 3n,
            at: `2026-03-14T03:1${inputSequence % 10n}:00.000Z`,
            inputSequence,
            payload: { method: 'setSetpoint', target: Number(200n + inputSequence) }
        })
    return journal
}

test('a journal chains, so an entry that was altered is detectable rather than merely absent', async (t) => {
    const journal = await journalWith([41n, 42n, 43n])
    const entries = await journal.read('oven3')

    t.is(await verifyJournal(entries), undefined)

    const tampered = entries.map((entry, index) => (index === 1 ? ({ ...entry, payload: { method: 'setSetpoint', target: 900 } } as RpcJournalEntry) : entry))
    t.regex((await verifyJournal(tampered)) ?? '', /its content changed after it was written/)
})

test('an entry removed from the middle breaks the chain, not just the count', async (t) => {
    const journal = await journalWith([41n, 42n, 43n])
    const entries = await journal.read('oven3')
    const without = [entries[0]!, entries[2]!]

    t.regex((await verifyJournal(without)) ?? '', /entries are missing/)
})

test('a snapshot and a journal join at the input position, and replay begins after it', async (t) => {
    const snapshot = await snapshotAt(40n)
    const entries = await (await journalWith([41n, 42n, 43n])).read('oven3')

    const outcome = await replayableFrom(snapshot, entries, 'suppress-effects')
    t.true('plan' in outcome)
    if (!('plan' in outcome)) return
    t.is(outcome.plan.fromInputSequence, 40n)
    t.is(outcome.plan.toInputSequence, 43n)
    t.deepEqual(
        outcome.plan.inputs.map((entry) => entry.inputSequence),
        [41n, 42n, 43n]
    )
    t.regex(outcome.plan.why, /without repeating what it did/)
})

test('inputs the snapshot already contains are not replayed onto it', async (t) => {
    const snapshot = await snapshotAt(42n)
    const entries = await (await journalWith([41n, 42n, 43n])).read('oven3')

    const outcome = await replayableFrom(snapshot, entries, 'suppress-effects')
    t.true('plan' in outcome)
    if ('plan' in outcome)
        t.deepEqual(
            outcome.plan.inputs.map((entry) => entry.inputSequence),
            [43n],
            'a snapshot that already saw 41 and 42 is not given them again'
        )
})

test('a gap refuses, because the state on the other side of it never existed', async (t) => {
    const snapshot = await snapshotAt(40n)
    const journal = new RpcMemoryJournal()
    for (const inputSequence of [41n, 43n]) await journal.append({ componentId: 'oven3', kind: 'input', epoch: 3n, at: '2026-03-14T03:14:00.000Z', inputSequence, payload: { n: Number(inputSequence) } })

    const outcome = await replayableFrom(snapshot, await journal.read('oven3'), 'suppress-effects')
    t.true('refused' in outcome)
    if ('refused' in outcome) t.regex(outcome.refused, /a fabrication rather than a recovery/)
})

test('a held-state-only snapshot has no position to replay onto, and says so', async (t) => {
    const held = (await sealSnapshot<OvenState>({
        captureKind: 'held-state-only',
        componentType: 'oven',
        componentId: 'oven3',
        sourceRevision: 'rev-1',
        stateSchemaId: 'oven.state',
        stateVersion: 1,
        stateSchemaHash: await schema(),
        heldState: { setpoint: 210, batches: 19 },
        provenance: [],
        capturedAt: '2026-03-14T03:14:00.000Z'
    })) as RpcSnapshotEnvelope

    const outcome = await replayableFrom(held, await (await journalWith([41n])).read('oven3'), 'suppress-effects')
    t.true('refused' in outcome)
    if ('refused' in outcome) t.regex(outcome.refused, /says what the values were and not where in the input they were/)
})

test('two components’ inputs are never replayed together', async (t) => {
    const snapshot = await snapshotAt(40n)
    const journal = await journalWith([41n])
    const mixed = [...(await journal.read('oven3')), { ...(await journal.read('oven3'))[0]!, componentId: 'mixer1' }]

    const outcome = await replayableFrom(snapshot, mixed, 'suppress-effects')
    t.true('refused' in outcome)
    if ('refused' in outcome) t.regex(outcome.refused, /a state neither of them was ever in/)
})

test('effects are declared, and the plan says out loud what it is about to do to the plant', async (t) => {
    const snapshot = await snapshotAt(40n)
    const entries = await (await journalWith([41n])).read('oven3')

    const shadow = await replayableFrom(snapshot, entries, 'suppress-effects')
    const real = await replayableFrom(snapshot, entries, 'honour-idempotency')
    t.true('plan' in shadow && 'plan' in real)
    if (!('plan' in shadow) || !('plan' in real)) return
    t.regex(shadow.plan.why, /outputs fenced/)
    t.regex(real.plan.why, /safe only where the sinks actually deduplicate/)
})

test('a replay applies in order and stops at the first input the successor cannot take', async (t) => {
    const snapshot = await snapshotAt(40n)
    const outcome = await replayableFrom(snapshot, await (await journalWith([41n, 42n, 43n])).read('oven3'), 'suppress-effects')
    if (!('plan' in outcome)) return t.fail('the plan should have been admissible')

    const seen: bigint[] = []
    const result = await replay(outcome.plan, (entry) => {
        if (entry.inputSequence === 43n) throw new Error('this revision does not know setSetpoint')
        seen.push(entry.inputSequence!)
    })

    t.deepEqual(seen, [41n, 42n])
    t.is(result.applied, 2)
    t.is(result.reachedInputSequence, 42n, 'and it says how far it got rather than how much it skipped')
    t.is(result.failedAt?.inputSequence, 43n)
})

test('a complete replay reports where it arrived', async (t) => {
    const snapshot = await snapshotAt(40n)
    const outcome = await replayableFrom(snapshot, await (await journalWith([41n, 42n])).read('oven3'), 'suppress-effects')
    if (!('plan' in outcome)) return t.fail('the plan should have been admissible')

    const result = await replay(outcome.plan, () => undefined)
    t.is(result.applied, 2)
    t.is(result.reachedInputSequence, 42n)
    t.is(result.failedAt, undefined)
})

test('compaction keeps what reaches from the snapshot to now, and drops what came before', async (t) => {
    const journal = await journalWith([38n, 39n, 40n, 41n, 42n])
    const dropped = await journal.compactTo(await snapshotAt(40n))

    t.is(dropped, 3, 'everything the snapshot already contains')
    t.deepEqual((await journal.read('oven3')).map((entry) => entry.inputSequence), [41n, 42n])
})

test('compaction refuses where it would leave a journal that cannot carry its own snapshot', async (t) => {
    const journal = await journalWith([50n, 51n])
    await t.throwsAsync(journal.compactTo(await snapshotAt(40n)), { message: /a journal that cannot carry the snapshot it was kept for/ })
    t.is((await journal.read('oven3')).length, 2, 'and nothing was discarded on the way to refusing')
})

test('a memory journal says it is not durable, because that is the question somebody is asking', (t) => {
    const journal = new RpcMemoryJournal()
    t.false(journal.capabilities.durable)
    t.true(journal.capabilities.appendOnly)
    t.true(journal.capabilities.tamperEvident)
})

const failedAfterCommit = (overrides: Partial<RpcHandoffRecord> = {}): RpcHandoffRecord => ({
    componentId: 'oven3',
    from: { componentId: 'oven3', activationId: 'a', revisionId: 'rev-1', epoch: 3n },
    to: { activationId: 'b', revisionId: 'rev-2' },
    reachedStage: 'release',
    classification: 'failed-after-commit',
    dispositions: [],
    committedEpoch: 4n,
    why: 'its buffered inputs were not delivered',
    ...overrides
})

test('forward recovery is a procedure now, and it names what it is recovering from', async (t) => {
    const snapshot = await snapshotAt(40n)
    const entries = await (await journalWith([41n, 42n])).read('oven3')

    const outcome = await recoverForward(failedAfterCommit(), snapshot, entries, 'suppress-effects')
    t.true('plan' in outcome)
    if (!('plan' in outcome)) return
    t.is(outcome.plan.toInputSequence, 42n)
    t.regex(outcome.plan.why, /failed after the commit point/)
    t.regex(outcome.plan.why, /not a rollback/)
})

test('forward recovery is refused for a handoff that never crossed the commit point', async (t) => {
    const snapshot = await snapshotAt(40n)
    const entries = await (await journalWith([41n])).read('oven3')

    const outcome = await recoverForward(failedAfterCommit({ classification: 'refused', committedEpoch: undefined }), snapshot, entries, 'suppress-effects')
    t.true('refused' in outcome)
    if ('refused' in outcome) t.regex(outcome.refused, /the incumbent never stopped being the owner/)
})

test('a journal that cannot support the recovery says so before anything is replayed', async (t) => {
    const snapshot = await snapshotAt(40n)
    const journal = new RpcMemoryJournal()
    for (const inputSequence of [41n, 44n]) await journal.append({ componentId: 'oven3', kind: 'input', epoch: 4n, at: '2026-03-14T03:14:00.000Z', inputSequence, payload: {} })

    const outcome = await recoverForward(failedAfterCommit(), snapshot, await journal.read('oven3'), 'suppress-effects')
    t.true('refused' in outcome)
    if ('refused' in outcome)
        t.regex(outcome.refused, /a fabrication rather than a recovery/, 'the deployment learns it is in the case the design warns about, rather than halfway through a replay')
})

test('the other kinds are history rather than replay, and survive a compaction that keeps them', async (t) => {
    const journal = new RpcMemoryJournal()
    await journal.append({ componentId: 'oven3', kind: 'input', epoch: 3n, at: '2026-03-14T03:10:00.000Z', inputSequence: 40n, payload: {} })
    await journal.append({ componentId: 'oven3', kind: 'obligation', epoch: 3n, at: '2026-03-14T03:12:00.000Z', payload: { registered: 'bake-dwell' } })
    await journal.append({ componentId: 'oven3', kind: 'activation', epoch: 4n, at: '2026-03-14T03:13:00.000Z', payload: { classification: 'activated', epoch: '4' } })
    await journal.append({ componentId: 'oven3', kind: 'input', epoch: 4n, at: '2026-03-14T03:14:00.000Z', inputSequence: 41n, payload: {} })

    await journal.compactTo(await snapshotAt(40n))
    const kept = await journal.read('oven3')
    t.deepEqual(
        kept.map((entry) => entry.kind),
        ['obligation', 'activation', 'input'],
        'what the component owed and when its ownership moved is part of the history a replay walks through'
    )
})
