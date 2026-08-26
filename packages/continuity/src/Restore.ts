import { admissibleForHandoff, type RpcSnapshotEnvelope } from './Envelope.js'
import { allObligations, type RpcObligation, type RpcTimerPolicy } from './Obligations.js'

/**
 * What the successor says it can do with the work the old activation was holding.
 *
 * **The manifest is an observed fact and this is a reviewed policy**, and the design keeps them
 * apart on purpose. The runtime knows that timer `mix-dwell` is active and due in forty seconds.
 * Only the revision being handed to knows what continuing, restarting or firing `mix-dwell` *means* -
 * whether that forty seconds is a dwell somebody is waiting out or a watchdog that should never have
 * been paused. A design that let the first stand in for the second would be inventing plant
 * behaviour at handoff time, which is the moment it is least able to be checked.
 */

/** How one obligation ends up. The design's five, and the difference between them matters. */
export type RpcResolution =
    /** Continuity is preserved under an explicitly supported rule. */
    | 'assumed'
    /** The resource is recreated, with declared delivery and ordering consequences. Recorded as such. */
    | 'reestablished'
    /** Quiescence finished it before the capture, so there is nothing to carry. */
    | 'completed'
    /** The existing Source RPC failure semantics are delivered to whoever is owed them. */
    | 'failed'
    /** The target cannot preserve or safely resolve it, so the handoff is refused. */
    | 'unhonourable'

/** What a revision declares it knows how to do with one obligation id. */
export interface RpcRestoreDeclaration {
    readonly id: string
    readonly resolution: Exclude<RpcResolution, 'unhonourable'>
    /**
     * Required for a timer, and there is no default - see `RpcTimerPolicy`. A timer whose
     * disposition nobody declared refuses the handoff rather than being given a sensible-looking one.
     */
    readonly timerPolicy?: RpcTimerPolicy
    /**
     * For a re-established subscription or publication: whether the transport underneath may
     * duplicate or drop on the way back up, and what is done about it.
     *
     * Required for `reestablished`, because "recreated" without it is a claim of continuity that the
     * transport has not made. A consumer that follows the logical address must not see a false state
     * reset merely because the process changed, and saying how that is achieved is the declaration.
     */
    readonly redelivery?: 'exactly-once' | 'at-least-once-deduplicated' | 'may-drop'
}

export interface RpcRestorePlanEntry {
    readonly id: string
    readonly kind: RpcObligation['kind']
    readonly resolution: RpcResolution
    /** Why, in the words somebody reviewing a handoff has to read. */
    readonly why: string
    readonly timerPolicy?: RpcTimerPolicy
    readonly redelivery?: RpcRestoreDeclaration['redelivery']
}

export type RpcRestorePlan =
    | { readonly admissible: true; readonly entries: readonly RpcRestorePlanEntry[] }
    | { readonly admissible: false; readonly why: string; readonly entries: readonly RpcRestorePlanEntry[] }

/** The clock a timer is measured against, supplied so a plan can be made deterministically. */
export interface RpcRestoreClock {
    readonly now: bigint
}

const timerWhy = (policy: RpcTimerPolicy, obligation: RpcObligation, clock: RpcRestoreClock): { resolution: RpcResolution; why: string } => {
    if (obligation.kind !== 'timer' && obligation.kind !== 'watchdog') return { resolution: 'unhonourable', why: `${obligation.id} is a ${obligation.kind}, and a timer policy says nothing about it` }
    const overdue = obligation.dueAt <= clock.now
    switch (policy) {
        case 'refuse-if-overdue':
            return overdue
                ? { resolution: 'unhonourable', why: `${obligation.id} came due at ${obligation.dueAt} during the handoff, and its declared policy is to abort rather than decide what a missed deadline meant` }
                : { resolution: 'assumed', why: `${obligation.id} is not yet due, so it carries across unchanged` }
        case 'preserve-deadline':
            return { resolution: overdue ? 'failed' : 'assumed', why: overdue ? `${obligation.id} fell due during the handoff and its deadline was preserved, so it is delivered late rather than silently dropped` : `${obligation.id} keeps the deadline it had` }
        case 'preserve-remaining':
            return { resolution: 'assumed', why: `${obligation.id} was effectively paused for the handoff and resumes with the time it had left` }
        case 'restart':
            return { resolution: 'reestablished', why: `${obligation.id} begins its declared duration again, so anything waiting on the original interval waits longer` }
        case 'fire-on-activation':
            return { resolution: 'reestablished', why: `${obligation.id} is delivered as soon as the successor is authoritative, whatever it had left` }
    }
}

/**
 * Whether this snapshot can be restored into this revision, and what happens to each thing it owed.
 *
 * Refuses on the first thing nobody can honour rather than reporting a plan with a hole in it: a
 * partial plan reads as progress, and the one thing a handoff must not do is proceed having
 * quietly not resolved something.
 *
 * **An obligation the target has not declared is `unhonourable`, not `assumed`.** Silence is not
 * consent here - a revision that has never heard of `mix-dwell` cannot be said to have preserved it,
 * and a handoff that treated an unmentioned timer as carried across would hand a plant to a program
 * that does not know it is holding a deadline.
 */
export const planRestore = (snapshot: RpcSnapshotEnvelope, declarations: readonly RpcRestoreDeclaration[], clock: RpcRestoreClock): RpcRestorePlan => {
    const inadmissible = admissibleForHandoff(snapshot)
    if (inadmissible) return { admissible: false, why: inadmissible, entries: [] }

    const declared = new Map(declarations.map((declaration) => [declaration.id, declaration]))
    const entries: RpcRestorePlanEntry[] = []
    let refusal: string | undefined

    for (const obligation of allObligations(snapshot.obligations!)) {
        const declaration = declared.get(obligation.id)
        if (!declaration) {
            const why = `${obligation.id} is a ${obligation.kind} the old activation was holding and this revision declares nothing about it; silence is not a claim to have preserved it`
            entries.push({ id: obligation.id, kind: obligation.kind, resolution: 'unhonourable', why })
            refusal ??= why
            continue
        }

        if (obligation.kind === 'timer' || obligation.kind === 'watchdog') {
            const policy = declaration.timerPolicy
            if (!policy) {
                const why = `${obligation.id} is a ${obligation.kind} and no restore policy was declared for it; there is no default, because every one of them is right for something and catastrophic for something else`
                entries.push({ id: obligation.id, kind: obligation.kind, resolution: 'unhonourable', why })
                refusal ??= why
                continue
            }
            const outcome = timerWhy(policy, obligation, clock)
            entries.push({ id: obligation.id, kind: obligation.kind, resolution: outcome.resolution, why: outcome.why, timerPolicy: policy })
            if (outcome.resolution === 'unhonourable') refusal ??= outcome.why
            continue
        }

        if (obligation.kind === 'lease' && declaration.resolution === 'assumed' && !obligation.issuerSupportsLogicalOwner) {
            const why = `${obligation.id} is a lease from ${obligation.issuer}, which does not support a logical owner; assuming it would hand the successor an authority the issuer does not believe it has`
            entries.push({ id: obligation.id, kind: obligation.kind, resolution: 'unhonourable', why })
            refusal ??= why
            continue
        }

        if (declaration.resolution === 'reestablished' && !declaration.redelivery) {
            const why = `${obligation.id} is declared re-established with no statement about redelivery; "recreated" without one is a claim of continuity the transport underneath has not made`
            entries.push({ id: obligation.id, kind: obligation.kind, resolution: 'unhonourable', why })
            refusal ??= why
            continue
        }

        entries.push({
            id: obligation.id,
            kind: obligation.kind,
            resolution: declaration.resolution,
            why: `${obligation.id} is declared ${declaration.resolution} by this revision`,
            ...(declaration.redelivery ? { redelivery: declaration.redelivery } : {})
        })
    }

    return refusal ? { admissible: false, why: refusal, entries } : { admissible: true, entries }
}

/**
 * The final check, repeated against the snapshot actually taken at the barrier.
 *
 * The design says validation happens four times and this is the last of them, and repeating it here
 * is not belt and braces. The earlier passes ran against a *representative* snapshot - a clone, a
 * dry run, whatever was current when the preparation started - and the thing about to be restored is
 * a different snapshot taken later, with whatever the component did in between. A plan proved
 * against the first says nothing about the second.
 */
export const validateAtBarrier = (
    snapshot: RpcSnapshotEnvelope,
    declarations: readonly RpcRestoreDeclaration[],
    clock: RpcRestoreClock,
    earlier: RpcRestorePlan
): { readonly agreed: true; readonly plan: RpcRestorePlan } | { readonly agreed: false; readonly why: string; readonly plan: RpcRestorePlan } => {
    const plan = planRestore(snapshot, declarations, clock)
    if (!plan.admissible) return { agreed: false, why: plan.why, plan }
    if (!earlier.admissible) return { agreed: false, why: `the earlier pass refused: ${earlier.why}`, plan }

    const before = new Map(earlier.entries.map((entry) => [entry.id, entry.resolution]))
    for (const entry of plan.entries) {
        const was = before.get(entry.id)
        if (was === undefined) return { agreed: false, why: `${entry.id} was not in the snapshot the plan was proved against; the component took on work while the handoff was being prepared`, plan }
        if (was !== entry.resolution) return { agreed: false, why: `${entry.id} was ${was} when the plan was proved and is ${entry.resolution} at the barrier`, plan }
    }
    for (const [id] of before) if (!plan.entries.some((entry) => entry.id === id)) return { agreed: false, why: `${id} was in the plan and is not in the barrier snapshot; it finished while the handoff was being prepared, which changes what the successor is owed`, plan }
    return { agreed: true, plan }
}
