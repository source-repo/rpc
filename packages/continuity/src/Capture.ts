import { componentSnapshot, type RpcComponentData, type RpcExecutionHold } from '@source-repo/rpc'
import { RpcSnapshotRefused, sealSnapshot, type RpcSnapshotEnvelope } from './Envelope.js'
import { allObligations, type RpcObligationLedger, type RpcObligations } from './Obligations.js'

/**
 * One consistent cut: the values and the outstanding work, from the same instant.
 *
 * **Capturing them in succession is not a weaker version of this, it is invalid.** A manifest taken
 * a moment after the state describes a component that has moved on - a timer that fired in between
 * is in neither, a command sent in between is in both. So the barrier comes first, the component is
 * allowed to become quiescent, and then everything is read in one synchronous breath with nothing
 * able to run in the gap.
 *
 * The barrier itself is the host's: `holdExecution` on the server's own serial chain, which already
 * orders one instance's commands. This decides *when* to capture and *whether it may*; it does not
 * own the queue, for the reason the freshness signal in `@source-repo/query` is injected rather than
 * fetched - the thing that owns the work is in a better position to say what it is doing.
 */

export interface RpcCaptureRequest<Props extends RpcComponentData, State extends RpcComponentData> {
    /** The component being captured. Read synchronously once the barrier is in effect. */
    readonly component: { readonly props: Props; readonly state: State }
    /** The instance held at a barrier. See `RpcServerHandler.holdExecution`. */
    readonly hold: RpcExecutionHold
    /** What the runtime is holding on this component's behalf. */
    readonly ledger: RpcObligationLedger

    readonly componentType: string
    readonly componentId: string
    readonly sourceRevision: string
    readonly stateSchemaId: string
    readonly stateVersion: number
    readonly stateSchemaHash: string

    /**
     * The activation this capture belongs to, and the input position it was taken at.
     *
     * Supplied rather than invented: this layer does not own the routing that assigns them, and a
     * capture that made up its own position would produce a snapshot that looked handoff-ready and
     * named an instant nobody could find.
     */
    readonly activationEpoch: bigint
    readonly logicalTime: bigint
    readonly lastAppliedInputSequence: bigint
    readonly lastCommittedOutputSequence: bigint

    /**
     * How long the component may take to become quiescent.
     *
     * Exceeding it refuses the handoff and leaves the old activation running, which is the correct
     * outcome and not a fallback: a component that cannot reach a barrier is a component whose work
     * nobody can describe, and replacing it would be replacing something whose state is unknown.
     */
    readonly quiescenceDeadlineMs: number

    /**
     * How long to watch a component that has gone quiet before believing it.
     *
     * **The barrier orders work the runtime dispatched, and eligibility is a claim about everything
     * else.** A raw `setInterval`, a socket callback, a direct method call from inside the process:
     * none of them went through the queue, so the queue being empty says nothing about them. That
     * limit does not go away, but it stops being *undetectable*. Every commit to a component's props
     * or state moves its revision counter, whatever route the write took - so a component that is
     * supposed to be quiescent and whose revision moves anyway has just demonstrated that something
     * is changing it outside the runtime, and the capture refuses instead of describing an instant
     * that was already over.
     *
     * Omitted, nothing is watched and nothing is claimed: the manifest rests entirely on the
     * revision's own `serialisedHandlers` declaration, which is where it rested before. Set, it
     * costs exactly this long under the barrier on every capture - the component is held, so the
     * plant is waiting - which is why it is a number the deployment chooses rather than a default
     * somebody discovers.
     *
     * It detects mutation, which is not the same as detecting unmanaged work. An unregistered timer
     * that will fire in an hour touches nothing during the window and is not caught by this; what is
     * caught is the case that actually corrupts a snapshot.
     */
    readonly settleMs?: number

    /**
     * The reading to measure timers' remaining time from, on the same clock their deadlines use.
     *
     * Supplied, every timer in the manifest is stamped with it, and `preserve-remaining` means the
     * time the timer had left. Omitted, obligations are reported exactly as they were registered -
     * correct for a caller that keeps its own clock, and wrong for one that assumed a `capturedAt`
     * from registration time was a capture time.
     */
    readonly monotonic?: () => bigint

    /** The clock, so a test need not wait out a real one. */
    readonly now?: () => number
}

/** Why a capture refused, in the words somebody has to act on. */
export interface RpcCaptureRefusal {
    readonly reason: 'not-quiescent' | 'work-in-flight' | 'unsafe-outbound' | 'unmanaged-mutation'
    readonly why: string
    /** The obligations that stopped it, where obligations did. */
    readonly blocking: readonly string[]
}

export type RpcCaptureResult<State> = { readonly captured: RpcSnapshotEnvelope<State> } | { readonly refused: RpcCaptureRefusal }

/**
 * Wait for the barrier to take effect, then capture - or refuse and leave the old activation running.
 *
 * Three refusals, and each is a different fact about the component:
 *
 * **`not-quiescent`** - a handler was still running when the deadline passed. Nothing was captured
 * and nothing was disturbed. The first implementation deliberately never serialises a partially
 * executed handler: a stack is not a thing that can be handed to another process, still less to
 * another language, and a design that pretended otherwise would be at its least trustworthy exactly
 * where it mattered most.
 *
 * **`work-in-flight`** - inbound work that changes something was still registered. A state-mutating
 * handler that has not finished means the values and the manifest cannot describe one instant.
 *
 * **`unsafe-outbound`** - a `non-repeatable-command` this component sent has no definitive result
 * yet. There is no safe disposition for it: the successor cannot assume it ran, cannot assume it did
 * not, and must not send it again. `UnknownOutcome` is what a *caller* is told about such a thing;
 * it is not a mechanism for reconstructing a successor's workflow, and it does not authorise a
 * silent retry. So the handoff waits for a durable result or refuses.
 *
 * **`unmanaged-mutation`** - the component was quiescent and its revision moved anyway, so something
 * outside the runtime is writing to it. Only ever reported when `settleMs` asked for it to be
 * watched for; see that field for what the window does and does not catch.
 *
 * The barrier is **not** released here. A refused capture and a successful one both leave it held,
 * because what happens next - retry, abandon, hand over - belongs to whoever asked, and releasing on
 * their behalf would restart a component somebody was about to replace.
 */
export const captureAtBarrier = async <Props extends RpcComponentData, State extends RpcComponentData>(
    request: RpcCaptureRequest<Props, State>
): Promise<RpcCaptureResult<State>> => {
    const now = request.now ?? Date.now
    const began = now()

    // The barrier is already in the chain; this waits for what was running when it went in. The
    // timer is cleared on the way out rather than left to fire: a deadline generous enough to be
    // useful - thirty seconds, a minute - is a handle held open for that long after the question has
    // already been answered, and a process that will not exit is the shape that takes.
    let expiry: ReturnType<typeof setTimeout> | undefined
    const quiescent = await Promise.race([
        request.hold.quiescent.then(() => true as const),
        new Promise<false>((resolve) => {
            expiry = setTimeout(() => resolve(false), Math.max(0, request.quiescenceDeadlineMs))
        })
    ]).finally(() => clearTimeout(expiry))
    if (!quiescent)
        return {
            refused: {
                reason: 'not-quiescent',
                why: `${request.componentType}/${request.componentId} was still running a handler ${now() - began} ms after the barrier, and a partially executed handler is not a thing that can be handed to another process`,
                blocking: []
            }
        }

    // Quiescent, and now watched for as long as the deployment asked. The reading is taken from the
    // component's own revision counter rather than from a hash of its state, because the counter
    // moves on every commit - including one that writes back the value that was already there, which
    // is a component being driven from outside just as surely as one whose values changed.
    //
    // Held rather than returned, because the manifest read below can explain the movement better
    // than this can: a mutating handler that never completed is *registered* work still running, and
    // reporting it as an anonymous outside write would send somebody looking for a stray timer.
    let drift: RpcCaptureRefusal | undefined
    if (request.settleMs !== undefined) {
        const before = revisionOf(request.component, request.componentType, request.componentId)
        await new Promise((resolve) => {
            const settling = setTimeout(resolve, Math.max(0, request.settleMs ?? 0))
            settling.unref?.()
        })
        const after = revisionOf(request.component, request.componentType, request.componentId)
        if (after.epoch !== before.epoch || after.revision !== before.revision)
            drift = {
                reason: 'unmanaged-mutation',
                why: `${request.componentType}/${request.componentId} was held at a barrier and its revision still moved from ${before.revision} to ${after.revision} in ${request.settleMs} ms: something is changing it outside the runtime - a raw timer, an event handler, a direct call - and a barrier cannot order what it never dispatched`,
                blocking: []
            }
    }

    // Everything from here is synchronous. Nothing may run between reading the values and reading
    // the manifest, which is the whole of what "one consistent cut" means.
    const manifest = request.ledger.manifest(request.monotonic?.())

    const mutating = manifest.inboundWork.filter((work) => work.mutating).map((work) => work.id)
    if (mutating.length)
        return {
            refused: {
                reason: 'work-in-flight',
                why: `${mutating.length} inbound handler${mutating.length === 1 ? '' : 's'} that change something ${mutating.length === 1 ? 'is' : 'are'} still registered, so the values and the manifest cannot describe one instant`,
                blocking: mutating
            }
        }

    const unsafe = manifest.outboundCalls.filter((call) => call.semantics !== 'query' && call.semantics !== 'idempotent-command').map((call) => call.id)
    if (unsafe.length)
        return {
            refused: {
                reason: 'unsafe-outbound',
                why: `${unsafe.length} outbound command${unsafe.length === 1 ? '' : 's'} that must not be repeated ${unsafe.length === 1 ? 'has' : 'have'} no definitive result yet; the successor could neither assume it ran nor assume it did not`,
                blocking: unsafe
            }
        }

    // Nothing registered accounts for it, so it came from outside the runtime.
    if (drift) return { refused: drift }

    const captured = await sealSnapshot<State>({
        captureKind: 'quiescent-handoff',
        componentType: request.componentType,
        componentId: request.componentId,
        sourceRevision: request.sourceRevision,
        stateSchemaId: request.stateSchemaId,
        stateVersion: request.stateVersion,
        stateSchemaHash: request.stateSchemaHash,
        activationEpoch: request.activationEpoch,
        logicalTime: request.logicalTime,
        lastAppliedInputSequence: request.lastAppliedInputSequence,
        lastCommittedOutputSequence: request.lastCommittedOutputSequence,
        heldState: request.component.state as unknown as State,
        obligations: manifest,
        provenance: [],
        capturedAt: new Date(now()).toISOString()
    })
    return { captured }
}

/**
 * The revision counter, or a refusal that says why there is not one.
 *
 * The settle window is a claim to have *checked* something, so a component that cannot be checked
 * has to say so rather than pass. A plain object with `props` and `state` is a perfectly good thing
 * to capture and has no counter behind it; asking it to be watched and quietly watching nothing
 * would produce a snapshot carrying evidence it does not have.
 */
const revisionOf = (component: object, componentType: string, componentId: string): { epoch: string; revision: number } => {
    try {
        return positionOf(component)
    } catch {
        throw new RpcSnapshotRefused(
            `${componentType}/${componentId} was asked to be watched for unmanaged writes, but it is not an RpcComponent and so has no revision counter to watch - drop settleMs, or capture a component whose commits are counted`,
            'settleMs'
        )
    }
}

/**
 * The state and revision of a live component, for a caller assembling a capture request.
 *
 * A convenience with one real job: reading the component's own epoch and revision rather than
 * letting a caller pass numbers that look plausible. The revision is what a subscriber has been
 * seeing, so it is what a successor has to continue from.
 */
export const positionOf = (component: object): { epoch: string; revision: number } => {
    const snapshot = componentSnapshot(component)
    return { epoch: snapshot.epoch, revision: snapshot.revision }
}

/** How many obligations a manifest holds, for a caller reporting what a capture carried. */
export const obligationCount = (obligations: RpcObligations): number => allObligations(obligations).length
