import test from 'ava'
import {
    MemoryOwnershipStore,
    RpcActivationFence,
    RpcInputBuffer,
    RpcObligationLedger,
    sealSnapshot,
    stateSchemaHash,
    type RpcCaptureResult,
    type RpcObligations,
    type RpcSnapshotEnvelope
} from '@source-repo/continuity'
import { activateDiagnosticVariant, capabilitiesFor, deactivateDiagnosticVariant, declarationsForVariant, RpcProbeSink, sealVariantManifest, probePlanHash, type RpcApprovedRevision, type RpcDerivativeEvidence, type RpcProbeDefinition } from './index.js'

/**
 * Putting the instrumented copy in and taking it back out, over the ordinary handoff.
 *
 * The thing being tested is that instrumenting a component is *not* a special way of replacing it.
 * So these run the real coordinator against a real ownership store, with real fences and a real
 * buffer, and the diagnostic part is only what happens before the barrier - the proof that the thing
 * arriving is the same program with probes in it.
 */

interface OvenState extends Record<string, unknown> {
    setpoint: number
    batches: number
}

const REVISION = 'rev-7'

const schema = () =>
    stateSchemaHash({
        schemaId: 'oven.state',
        version: 1,
        schema: { kind: 'object', fields: { setpoint: { type: { kind: 'number' } }, batches: { type: { kind: 'number' } } } }
    })

const approved = async (): Promise<RpcApprovedRevision> => ({
    componentId: 'oven3',
    semanticRevisionId: REVISION,
    sourceBundleHash: 'sha256-bundle',
    artifactHash: 'sha256-base-artifact',
    contractHash: 'sha256-contract',
    persistentStateSchemaHash: await schema(),
    nonDiagnosticCapabilityHash: 'sha256-capabilities'
})

const plan: readonly RpcProbeDefinition[] = [
    { probeId: 'function-entry:oven.ts:4:5', semanticRevisionId: REVISION, fileId: 'oven.ts', span: { startLine: 4, startColumn: 5, endLine: 4, endColumn: 30 }, kind: 'function-entry' },
    { probeId: 'value:oven.ts:5:25', semanticRevisionId: REVISION, fileId: 'oven.ts', span: { startLine: 5, startColumn: 25, endLine: 5, endColumn: 50 }, kind: 'value' }
]

const evidence = (overrides: Partial<RpcDerivativeEvidence> = {}): RpcDerivativeEvidence => ({
    baseSemanticDigest: 'sha256-semantic',
    strippedSemanticDigest: 'sha256-semantic',
    plan,
    found: plan.map((probe) => ({ probeId: probe.probeId, kind: probe.kind })),
    addedCapabilities: ['diagnostics.telemetry'],
    ...overrides
})

const manifestFor = async (base: RpcApprovedRevision) =>
    sealVariantManifest({
        componentId: base.componentId,
        semanticRevisionId: base.semanticRevisionId,
        sourceBundleHash: base.sourceBundleHash,
        baseArtifactHash: base.artifactHash,
        artifactVariantId: 'oven3-diag-1',
        artifactVariantHash: 'sha256-variant-artifact',
        probePlanId: 'plan-1',
        probePlanHash: await probePlanHash(plan),
        contractHash: base.contractHash,
        persistentStateSchemaHash: base.persistentStateSchemaHash,
        nonDiagnosticCapabilityHash: base.nonDiagnosticCapabilityHash,
        diagnosticsAdapter: { language: 'typescript', adapterVersion: '0.1.0' }
    })

/** One dwell timer and one lease, so the declarations have something real to be about. */
const holding = (): RpcObligations => {
    const ledger = new RpcObligationLedger()
    ledger.register({ kind: 'timer', id: 'bake-dwell', clock: 'monotonic', dueAt: 9_000n, capturedAt: 1_000n, policy: 'preserve-deadline' })
    ledger.register({ kind: 'lease', id: 'hopper', issuer: 'hopper-manager', expiresAt: 30_000n, issuerSupportsLogicalOwner: true })
    return ledger.manifest()
}

/**
 * A stand-in for the plant: the incumbent's state, a barrier that is already quiescent, and a
 * successor that takes what it is handed. The coordinator is real; what surrounds it is not.
 */
const plant = async (base: RpcApprovedRevision, obligations: RpcObligations) => {
    const store = new MemoryOwnershipStore()
    await store.compareAndSwap(undefined, { componentId: base.componentId, activationId: 'a', revisionId: REVISION, epoch: 0n })
    const incumbentFence = new RpcActivationFence(base.componentId, 'a', 0n)
    incumbentFence.open()
    const successorFence = new RpcActivationFence(base.componentId, 'b', 1n)

    const held: { state: OvenState; released: number; restored?: OvenState } = { state: { setpoint: 210, batches: 19 }, released: 0 }

    const capture = async (): Promise<RpcCaptureResult<OvenState>> => ({
        captured: (await sealSnapshot<OvenState>({
            captureKind: 'quiescent-handoff',
            componentType: 'oven',
            componentId: base.componentId,
            sourceRevision: REVISION,
            stateSchemaId: 'oven.state',
            stateVersion: 1,
            stateSchemaHash: base.persistentStateSchemaHash,
            activationEpoch: 0n,
            logicalTime: 5_000n,
            lastAppliedInputSequence: 400n,
            lastCommittedOutputSequence: 399n,
            heldState: held.state,
            obligations,
            provenance: [],
            capturedAt: '2026-03-14T09:15:00.000Z'
        })) as RpcSnapshotEnvelope<OvenState>
    })

    return {
        store,
        incumbentFence,
        successorFence,
        held,
        handoff: {
            componentId: base.componentId,
            store,
            successor: { activationId: 'b', revisionId: REVISION },
            incumbentFence,
            successorFence,
            buffer: new RpcInputBuffer<unknown>(400n, 'exactly-once', 16),
            clock: { now: 5_000n },
            capture,
            releaseBarrier: () => {
                held.released++
            },
            restore: async (snapshot: RpcSnapshotEnvelope<OvenState>) => {
                held.restored = snapshot.heldState
                return undefined
            },
            deliver: () => undefined,
            returnToIncumbent: () => undefined
        }
    }
}

test('the instrumented copy takes over, keeping the state and the epoch the design says it should', async (t) => {
    const base = await approved()
    const obligations = holding()
    const stood = await plant(base, obligations)

    const outcome = await activateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations,
        timerPolicy: 'preserve-deadline',
        handoff: stood.handoff
    })

    t.true('activated' in outcome, 'refused' in outcome ? outcome.refused.why : 'abandoned' in outcome ? outcome.abandoned.why : '')
    if (!('activated' in outcome)) return

    t.is(outcome.activated.committedEpoch, 1n, 'ownership moved on by exactly one epoch')
    t.deepEqual(stood.held.restored, { setpoint: 210, batches: 19 }, 'and the state crossed unchanged: no migration, because the schema never moved')
    t.false(stood.incumbentFence.authoritative, 'the base activation is fenced')
    t.true(stood.successorFence.authoritative, 'and the instrumented one is authoritative')
    t.is((await stood.store.read('oven3'))?.activationId, 'b')
})

test('every obligation crosses as assumed, which the derivative proof is what entitles it to', async (t) => {
    const base = await approved()
    const obligations = holding()
    const stood = await plant(base, obligations)

    const outcome = await activateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations,
        timerPolicy: 'preserve-deadline',
        handoff: stood.handoff
    })

    t.true('activated' in outcome)
    if (!('activated' in outcome)) return
    t.deepEqual(
        outcome.activated.dispositions.map((entry) => `${entry.id}:${entry.resolution}`),
        ['bake-dwell:assumed', 'hopper:assumed'],
        'the same program knows every id it was holding'
    )
    t.is(outcome.activated.classification, 'activated', 'and nothing was carried across with a consequence to record')
})

test('a timer still needs a policy, because being the same program says nothing about the handoff window', (t) => {
    const declarations = declarationsForVariant(holding(), 'preserve-remaining')
    t.deepEqual(declarations, [
        { id: 'bake-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' },
        { id: 'hopper', resolution: 'assumed' }
    ])
})

test('an inadmissible variant is refused before the plant is touched at all', async (t) => {
    const base = await approved()
    const obligations = holding()
    const stood = await plant(base, obligations)

    const outcome = await activateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        // The strip did not reproduce the approved program: the transformer changed it.
        evidence: evidence({ strippedSemanticDigest: 'sha256-something-else' }),
        obligations,
        timerPolicy: 'preserve-deadline',
        handoff: stood.handoff
    })

    t.true('refused' in outcome)
    if (!('refused' in outcome)) return
    t.true(outcome.refused.beforeTheBarrier)
    t.regex(outcome.refused.why, /the transformation changed the program/)
    t.is(stood.held.released, 0, 'the barrier was never taken, so there was nothing to release')
    t.true(stood.incumbentFence.authoritative, 'and the component is still running, unaware anything was attempted')
    t.is((await stood.store.read('oven3'))?.activationId, 'a')
})

test('an obligation taken on after preparation is not covered by the declarations, and refuses at the barrier', async (t) => {
    const base = await approved()
    const prepared = holding()
    // The barrier snapshot carries a subscription nobody declared, because it started afterwards.
    const later = new RpcObligationLedger()
    for (const obligation of [...prepared.timers, ...prepared.leases]) later.register(obligation)
    later.register({ kind: 'subscription', id: 'alarms', event: 'alarm' })
    const stood = await plant(base, later.manifest())

    const outcome = await activateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations: prepared,
        timerPolicy: 'preserve-deadline',
        handoff: stood.handoff
    })

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.classification, 'refused')
    t.regex(outcome.abandoned.why, /silence is not a claim/)
    t.true(stood.incumbentFence.authoritative, 'and the base activation kept running')
})

test('a paused activation cannot be replaced, because it cannot reach a barrier', async (t) => {
    const base = await approved()
    const obligations = holding()
    const stood = await plant(base, obligations)

    const outcome = await activateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations,
        timerPolicy: 'preserve-deadline',
        paused: true,
        handoff: stood.handoff
    })

    t.true('refused' in outcome)
    if (!('refused' in outcome)) return
    t.regex(outcome.refused.why, /not quiescent/)
})

test('taking the instrumentation back out is the same protocol, and only the approved artifact may return', async (t) => {
    const base = await approved()
    const obligations = holding()
    const stood = await plant(base, obligations)

    const wrong = await deactivateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations,
        timerPolicy: 'preserve-deadline',
        returningArtifactHash: 'sha256-some-other-build',
        handoff: stood.handoff
    })
    t.true('refused' in wrong)
    if ('refused' in wrong) t.regex(wrong.refused.why, /a deployment wearing a debugger's clothes/)
    t.is(stood.held.released, 0)

    const back = await deactivateDiagnosticVariant({
        manifest: await manifestFor(base),
        approved: base,
        evidence: evidence(),
        obligations,
        timerPolicy: 'preserve-deadline',
        returningArtifactHash: base.artifactHash,
        handoff: stood.handoff
    })
    t.true('activated' in back, 'refused' in back ? back.refused.why : '')
    if ('activated' in back) t.deepEqual(stood.held.restored, { setpoint: 210, batches: 19 }, 'the state comes back the same way it went out')
})

test('a node advertises variants only when the deployment wired them, and probes only when they land somewhere', (t) => {
    const bare = capabilitiesFor({ sourceAvailable: true })
    t.false(bare.diagnosticVariants)
    t.false(bare.valueProbes)
    t.is(bare.limits.maxSessions, 0)

    const wired = capabilitiesFor({ sourceAvailable: true, variantActivation: true, probeSink: { maxProbesPerSession: 500, maxValueBytes: 512, maxTraceEvents: 2000 } })
    t.true(wired.diagnosticVariants)
    t.true(wired.valueProbes)
    t.true(wired.orderedTrace)
    t.is(wired.limits.maxSessions, 1)
    t.false(wired.tracepoints, 'a tracepoint is a probe with a condition and a message, and neither exists')
    t.false(wired.exactPause)
})

test('a probe returns what it was given, counts what it saw, and cannot throw into the component', (t) => {
    const sink = new RpcProbeSink({ maxSamples: 3, maxValueBytes: 8 })
    const probe = sink.receiver

    t.is(probe.value('value:1', 42), 42)
    t.is(probe.condition('condition:1', false), false)
    const held = { deep: 'a value longer than eight bytes' }
    t.is(probe.value('value:2', held), held, 'the object comes back by identity, not a copy of it')

    // A getter that throws is a fact about the value, not an error to inflict on the plant.
    const hostile = {
        get boom(): string {
            throw new Error('no')
        }
    }
    t.notThrows(() => probe.value('value:3', hostile))

    const samples = sink.peek()
    t.is(samples.length, 3, 'bounded: the ring dropped the oldest rather than growing')
    t.is(sink.dropped, 1)
    t.true(samples.some((sample) => sample.value?.truncated), 'a shortened value says it was shortened')
    t.true(samples.some((sample) => sample.value?.unrepresentable), 'and one that could not be rendered says that instead')
})

test('probes fired twice count twice, and the order they fired in is the order they are read in', (t) => {
    const sink = new RpcProbeSink()
    const probe = sink.receiver
    probe.entry('function-entry:1')
    probe.statement('statement:1')
    probe.statement('statement:1')

    const samples = sink.drain()
    t.deepEqual(
        samples.map((sample) => `${sample.probeId}#${sample.executionCount}`),
        ['function-entry:1#1', 'statement:1#1', 'statement:1#2']
    )
    t.deepEqual(
        samples.map((sample) => sample.sequence),
        [1n, 2n, 3n]
    )
    t.is(sink.depth, 0, 'draining hands the samples over rather than copying them')
})
