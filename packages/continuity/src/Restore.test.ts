import test from 'ava'
import { planRestore, sealSnapshot, validateAtBarrier, type RpcObligation, type RpcRestoreDeclaration, type RpcSnapshotEnvelope } from './index.js'

/**
 * What the successor says it can do with what the old activation was holding.
 *
 * The manifest is an observed fact; a declaration is a reviewed policy. Everything here is about
 * keeping those apart - a runtime that let the first stand in for the second would be inventing
 * plant behaviour at the moment it is least able to be checked.
 */

const handoff = async (obligations: readonly RpcObligation[]): Promise<RpcSnapshotEnvelope> => {
    const grouped = {
        timers: obligations.filter((one): one is Extract<RpcObligation, { kind: 'timer' }> => one.kind === 'timer'),
        outboundCalls: obligations.filter((one): one is Extract<RpcObligation, { kind: 'outbound-call' }> => one.kind === 'outbound-call'),
        inboundWork: [],
        subscriptions: obligations.filter((one): one is Extract<RpcObligation, { kind: 'subscription' }> => one.kind === 'subscription'),
        pendingPublications: [],
        leases: obligations.filter((one): one is Extract<RpcObligation, { kind: 'lease' }> => one.kind === 'lease'),
        sequences: [],
        watchdogs: obligations.filter((one): one is Extract<RpcObligation, { kind: 'watchdog' }> => one.kind === 'watchdog')
    }
    return sealSnapshot({
        captureKind: 'quiescent-handoff',
        componentType: 'mixer',
        componentId: 'mixer1',
        sourceRevision: 'rev-1',
        stateSchemaId: 'mixer.state',
        stateVersion: 1,
        stateSchemaHash: 'hash',
        activationEpoch: 7n,
        logicalTime: 1200n,
        lastAppliedInputSequence: 9000n,
        lastCommittedOutputSequence: 8999n,
        heldState: { batches: 3 },
        obligations: grouped,
        provenance: [],
        capturedAt: '2026-03-14T09:15:00.000Z'
    })
}

const dwell: RpcObligation = { kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 5_000n, capturedAt: 1_000n, policy: 'preserve-remaining' }
const clock = { now: 2_000n }

test('an obligation the target says nothing about is unhonourable, not assumed', async (t) => {
    // Silence is not consent. A revision that has never heard of `mix-dwell` cannot be said to have
    // preserved it, and a handoff that treated an unmentioned timer as carried across would hand a
    // plant to a program that does not know it is holding a deadline.
    const plan = planRestore(await handoff([dwell]), [], clock)
    t.false(plan.admissible)
    if (plan.admissible) return
    t.regex(plan.why, /declares nothing about it; silence is not a claim/)
    t.is(plan.entries[0].resolution, 'unhonourable')
})

test('a timer with no declared policy refuses, because there is no default', async (t) => {
    // Every policy is right for something and catastrophic for something else: a dwell that restarts
    // has doubled a bake, and a watchdog that preserved its deadline fires the instant B comes up.
    const plan = planRestore(await handoff([dwell]), [{ id: 'mix-dwell', resolution: 'assumed' }], clock)
    t.false(plan.admissible)
    if (plan.admissible) return
    t.regex(plan.why, /no restore policy was declared|no default/)
})

test('each timer policy resolves to what it actually means', async (t) => {
    const snapshot = await handoff([dwell])
    const outcomes = new Map<string, string>()
    for (const policy of ['preserve-remaining', 'preserve-deadline', 'restart', 'fire-on-activation', 'refuse-if-overdue'] as const) {
        const plan = planRestore(snapshot, [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: policy }], clock)
        outcomes.set(policy, plan.entries[0].resolution)
    }
    t.is(outcomes.get('preserve-remaining'), 'assumed')
    t.is(outcomes.get('preserve-deadline'), 'assumed')
    // Restarting and firing on activation are not continuity: something observable changes, and the
    // provenance has to say so rather than calling it preserved.
    t.is(outcomes.get('restart'), 'reestablished')
    t.is(outcomes.get('fire-on-activation'), 'reestablished')
    t.is(outcomes.get('refuse-if-overdue'), 'assumed', 'not yet due, so nothing to refuse')
})

test('a timer that fell due during the handoff is handled by its policy rather than by luck', async (t) => {
    const overdue: RpcObligation = { ...dwell, dueAt: 1_500n }
    const snapshot = await handoff([overdue])
    const late = planRestore(snapshot, [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-deadline' }], clock)
    t.true(late.admissible)
    // Delivered late rather than silently dropped: preserving the deadline means the deadline was
    // real, and one that passed is a fact somebody is owed.
    t.is(late.entries[0].resolution, 'failed')

    const abort = planRestore(snapshot, [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'refuse-if-overdue' }], clock)
    t.false(abort.admissible)
    if (abort.admissible) return
    t.regex(abort.why, /abort rather than decide what a missed deadline meant/)
})

test('a lease is carried only where its issuer knows what a logical owner is', async (t) => {
    const lease: RpcObligation = { kind: 'lease', id: 'hopper-lock', issuer: 'hopper', expiresAt: 9_000n, capturedAt: 0n } as unknown as RpcObligation
    const naive = await handoff([{ kind: 'lease', id: 'hopper-lock', issuer: 'hopper', expiresAt: 9_000n, issuerSupportsLogicalOwner: false }])
    const plan = planRestore(naive, [{ id: 'hopper-lock', resolution: 'assumed' }], clock)
    t.false(plan.admissible)
    if (plan.admissible) return
    // Assuming it would hand the successor an authority the issuer does not believe it has.
    t.regex(plan.why, /does not support a logical owner/)
    t.truthy(lease)

    const willing = await handoff([{ kind: 'lease', id: 'hopper-lock', issuer: 'hopper', expiresAt: 9_000n, issuerSupportsLogicalOwner: true }])
    t.true(planRestore(willing, [{ id: 'hopper-lock', resolution: 'assumed' }], clock).admissible)
})

test('re-establishing a feed has to say what the transport will do to it', async (t) => {
    const feed: RpcObligation = { kind: 'subscription', id: 'alarms', event: 'alarm', lastAcknowledgedSequence: 41n }
    const silent = planRestore(await handoff([feed]), [{ id: 'alarms', resolution: 'reestablished' }], clock)
    t.false(silent.admissible)
    if (silent.admissible) return
    // "Recreated" without it is a claim of continuity the transport underneath has not made, and a
    // consumer following the logical address must not see a false reset because a process changed.
    t.regex(silent.why, /claim of continuity the transport underneath has not made/)

    const declared = planRestore(await handoff([feed]), [{ id: 'alarms', resolution: 'reestablished', redelivery: 'at-least-once-deduplicated' }], clock)
    t.true(declared.admissible)
    t.is(declared.entries[0].redelivery, 'at-least-once-deduplicated')
})

test('a plan proved against one snapshot is proved again against the one taken at the barrier', async (t) => {
    // The earlier passes ran against whatever was current when preparation started. The thing about
    // to be restored is a different snapshot taken later, with whatever happened in between.
    const declarations: readonly RpcRestoreDeclaration[] = [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' }]
    const earlier = planRestore(await handoff([dwell]), declarations, clock)
    t.true(earlier.admissible)

    const same = validateAtBarrier(await handoff([dwell]), declarations, clock, earlier)
    t.true(same.agreed)

    // The component took on work while the handoff was being prepared.
    const grew = validateAtBarrier(
        await handoff([dwell, { kind: 'outbound-call', id: 'dispense-9', target: 'hopper', method: 'dispense', semantics: 'query' }]),
        [...declarations, { id: 'dispense-9', resolution: 'assumed' }],
        clock,
        earlier
    )
    t.false(grew.agreed)
    if (grew.agreed) return
    t.regex(grew.why, /took on work while the handoff was being prepared/)

    // And something that finished in between changes what the successor is owed.
    const shrank = validateAtBarrier(await handoff([]), declarations, clock, earlier)
    t.false(shrank.agreed)
    if (shrank.agreed) return
    t.regex(shrank.why, /finished while the handoff was being prepared/)
})

test('a plan refuses on the first thing nobody can honour rather than reporting a hole', async (t) => {
    const plan = planRestore(await handoff([dwell, { kind: 'subscription', id: 'alarms', event: 'alarm' }]), [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' }], clock)
    t.false(plan.admissible)
    // A partial plan reads as progress, and the one thing a handoff must not do is proceed having
    // quietly not resolved something.
    t.is(plan.entries.filter((entry) => entry.resolution === 'unhonourable').length, 1)
})
