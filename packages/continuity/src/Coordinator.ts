import type { RpcCaptureResult } from './Capture.js'
import type { RpcSnapshotEnvelope } from './Envelope.js'
import { RpcActivationFence } from './Fence.js'
import type { RpcInputBuffer } from './Inbox.js'
import type { RpcActivationOwner, RpcOwnershipStore } from './Ownership.js'
import { planRestore, type RpcRestoreClock, type RpcRestoreDeclaration, type RpcRestorePlanEntry } from './Restore.js'

/**
 * The handoff itself, as a sequence of stages with a stated result at every failure point.
 *
 * The design's failure table is the specification of this file, and it is written here as control
 * flow rather than as documentation because the rows are not equally obvious. Everything before the
 * ownership swap has the same required result - A remains the owner, nothing observable changed -
 * and everything after it has a different one, which is that there is no going back.
 *
 * **The commit point is the compare-and-swap and nothing else.** Before it, abandoning is free:
 * B is discarded, the barrier is released, whatever was buffered goes back to A, and no caller can
 * tell a handoff was attempted. After it, B has been told it is authoritative and may already have
 * acted on the plant. Restoring A from the snapshot at that point would silently discard whatever B
 * did in between and might repeat effects that already happened, so this coordinator will not do it
 * - a failure after the commit point is reported as one, with the record needed to recover forward.
 */

/** Where a handoff got to. Named stages rather than a number, because the audit record is read by people. */
export type RpcHandoffStage = 'prepare' | 'quiesce' | 'capture' | 'restore' | 'activate' | 'release' | 'observe'

/**
 * The final classification, from the design's validation table.
 *
 * `temporarily-blocked` and `refused` are not degrees of the same thing. The first says *the plant
 * was busy*: a command was in flight, quiescence took too long, and the same handoff attempted again
 * in a minute may well succeed. The second says *these two revisions cannot be reconciled*, and
 * retrying is a way of not reading the message. An operator who cannot tell them apart will retry
 * both, and only one of them is worth retrying.
 */
export type RpcHandoffClassification = 'activated' | 'activated-with-recorded-consequences' | 'temporarily-blocked' | 'refused' | 'failed-after-commit'

/** What was done, kept whatever the outcome - a handoff that did not happen is evidence too. */
export interface RpcHandoffRecord {
    readonly componentId: string
    readonly from: RpcActivationOwner
    readonly to: { readonly activationId: string; readonly revisionId: string }
    readonly reachedStage: RpcHandoffStage
    readonly classification: RpcHandoffClassification
    /** Absent until the capture succeeded. */
    readonly snapshotId?: string
    readonly barrierSequence?: bigint
    /** Every obligation and what became of it, so the record answers what B was left holding. */
    readonly dispositions: readonly RpcRestorePlanEntry[]
    /** The epoch B holds, present only once the swap committed. */
    readonly committedEpoch?: bigint
    readonly bufferedInputs?: number
    readonly releasedThrough?: bigint
    /** Why it ended as it did. Always present, including on success, where it says what was agreed. */
    readonly why: string
}

export interface RpcHandoffRequest<State> {
    readonly componentId: string
    /** Read rather than assumed: a coordinator that trusted its own idea of the owner would race. */
    readonly store: RpcOwnershipStore
    readonly successor: { readonly activationId: string; readonly revisionId: string }
    /** The incumbent's fence, open. Closed by the coordinator, after the swap and not before. */
    readonly incumbentFence: RpcActivationFence
    /** The successor's fence, closed. Opened by the coordinator, after the swap and not before. */
    readonly successorFence: RpcActivationFence
    readonly buffer: RpcInputBuffer<unknown>
    readonly declarations: readonly RpcRestoreDeclaration[]
    readonly clock: RpcRestoreClock

    /** Establish the barrier and take the consistent cut. Phase 2's `captureAtBarrier`, wrapped. */
    capture(): Promise<RpcCaptureResult<State>>
    /**
     * Let the incumbent's execution queue go. Called exactly once, on every path, including the ones
     * that throw - a barrier left in place is a component that has stopped answering for good.
     */
    releaseBarrier(): void | Promise<void>
    /**
     * B takes the snapshot, honours every disposition, and reports readiness - `undefined`, or a
     * sentence saying what it could not do. Runs with B's outputs still fenced.
     */
    restore(snapshot: RpcSnapshotEnvelope<State>, dispositions: readonly RpcRestorePlanEntry[]): Promise<string | undefined>
    /** Give one buffered input to the successor. Awaited, so that order means order of application. */
    deliver(input: unknown, sequence: bigint): Promise<void> | void
    /** Give one buffered input back to the incumbent, when the handoff is abandoned. */
    returnToIncumbent(input: unknown, sequence: bigint): Promise<void> | void
}

export type RpcHandoffOutcome = { readonly activated: RpcHandoffRecord } | { readonly abandoned: RpcHandoffRecord }

/**
 * Run one handoff to completion or to a stated failure.
 *
 * There is one `await` sequence and no branch that leaves the plant in a state nobody named. The
 * shape to notice is that every early return goes through `abandon`, which releases the barrier and
 * hands the buffer back - so "the handoff did not happen" means the same thing at every stage,
 * rather than meaning six slightly different things.
 */
export const handOver = async <State>(request: RpcHandoffRequest<State>): Promise<RpcHandoffOutcome> => {
    const { componentId, store, successor } = request
    let stage: RpcHandoffStage = 'prepare'
    const dispositions: RpcRestorePlanEntry[] = []
    /** What has been established so far, gathered so that a record can be written at any stage. */
    const established: { snapshotId?: string; barrierSequence?: bigint; buffered?: number } = {}

    const incumbent = await store.read(componentId)
    if (!incumbent)
        return {
            abandoned: {
                componentId,
                from: { componentId, activationId: '(none)', revisionId: '(none)', epoch: -1n },
                to: successor,
                reachedStage: 'prepare',
                classification: 'refused',
                dispositions: [],
                why: `${componentId} has no recorded owner, so there is no activation to hand over from - a first activation is a claim, not a handoff`
            }
        }

    const record = (reachedStage: RpcHandoffStage, classification: RpcHandoffClassification, why: string): RpcHandoffRecord => ({
        componentId,
        from: incumbent,
        to: successor,
        reachedStage,
        classification,
        snapshotId: established.snapshotId,
        barrierSequence: established.barrierSequence,
        dispositions,
        bufferedInputs: established.buffered,
        why
    })

    /** Everything before the commit point ends here, and ends the same way. */
    const abandon = async (classification: 'temporarily-blocked' | 'refused', why: string): Promise<RpcHandoffOutcome> => {
        await request.releaseBarrier()
        if (request.buffer.buffering) await request.buffer.abandon(request.returnToIncumbent)
        return { abandoned: record(stage, classification, why) }
    }

    if (!request.incumbentFence.authoritative) return abandon('refused', `${componentId}'s incumbent activation is not authoritative, so it has nothing to hand over`)
    if (request.successorFence.authoritative) return abandon('refused', `${componentId}'s successor ${successor.activationId} is already authoritative before the swap, which would be two activations acting at once`)
    if (request.successorFence.epoch !== incumbent.epoch + 1n)
        return abandon('refused', `${componentId}'s successor holds a fence for epoch ${request.successorFence.epoch} and the incumbent is at ${incumbent.epoch}: a fence that does not name the epoch it will get fences nothing`)

    // 14.2 - the barrier, and the cut. The buffer starts holding before anything is captured, so
    // that no input can land in the gap between "quiescent" and "somebody is holding the door".
    stage = 'quiesce'
    request.buffer.begin()

    stage = 'capture'
    const captured = await request.capture()
    if ('refused' in captured) {
        // A capture refusal is the plant being busy, not the revisions disagreeing: work in flight,
        // an outbound command with an unknown outcome, a handler that would not finish. Every one of
        // those is different in a minute.
        return abandon('temporarily-blocked', `${componentId} could not be captured: ${captured.refused.why}`)
    }
    const snapshot = captured.captured
    established.snapshotId = snapshot.snapshotId
    established.barrierSequence = snapshot.lastAppliedInputSequence

    // 13.4 - proved again against the snapshot actually taken, never against an earlier one.
    stage = 'restore'
    const plan = planRestore(snapshot, request.declarations, request.clock)
    dispositions.push(...plan.entries)
    if (!plan.admissible) return abandon('refused', `${componentId} cannot be handed over: ${plan.why}`)

    const unready = await request.restore(snapshot, plan.entries)
    if (unready !== undefined) return abandon('refused', `${componentId}'s successor ${successor.activationId} restored but is not ready: ${unready}`)

    // 14.4 - and from here the order is load-bearing. The swap first, because it is the only
    // operation that can fail without anything having changed.
    stage = 'activate'
    const swap = await store.compareAndSwap(incumbent, { componentId, activationId: successor.activationId, revisionId: successor.revisionId, epoch: incumbent.epoch + 1n })
    if ('rejected' in swap) {
        // Neither routing nor output authority changed. Somebody else moved the component, or this
        // coordinator was working from a stale read - and in both cases the correct next act is to
        // read the owner again, which is why the rejection carries it.
        return abandon('refused', `${componentId} could not change owner: ${swap.why}`)
    }

    // ---- The commit point. Past here nothing is undone. ----

    // A is fenced before B is opened. The other order leaves a moment with two authoritative
    // activations, and that moment is long enough: it is exactly when both are running.
    request.incumbentFence.close()
    request.successorFence.open()
    await request.releaseBarrier()

    stage = 'release'
    established.buffered = request.buffer.depth
    const released = await request.buffer.release(request.deliver)
    if ('refused' in released)
        return {
            abandoned: {
                ...record('release', 'failed-after-commit', `${componentId} is owned by ${successor.activationId} at epoch ${swap.committed.epoch}, but its buffered inputs were not delivered: ${released.why}. Recover forward - restoring the incumbent's snapshot now would discard whatever the successor has already done.`),
                committedEpoch: swap.committed.epoch
            }
        }

    stage = 'observe'
    const consequential = plan.entries.some((entry) => entry.resolution !== 'assumed')
    return {
        activated: {
            ...record(
                'observe',
                consequential ? 'activated-with-recorded-consequences' : 'activated',
                consequential
                    ? `${componentId} is owned by ${successor.activationId} at epoch ${swap.committed.epoch}. ${plan.entries.filter((entry) => entry.resolution !== 'assumed').length} of ${plan.entries.length} obligations were not carried across unchanged, and the dispositions record which.`
                    : `${componentId} is owned by ${successor.activationId} at epoch ${swap.committed.epoch}, with every obligation assumed unchanged.`
            ),
            committedEpoch: swap.committed.epoch,
            releasedThrough: released.through,
            bufferedInputs: established.buffered
        }
    }
}
