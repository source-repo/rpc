import type { RpcExecutionHold } from '@source-repo/rpc'

/**
 * Stopping a component *between* units of work, which is the pause a general actor can survive.
 *
 * The design's safe-boundary mode: a probe is hit, the runtime records it and asks for a pause, the
 * current handler **completes under ordinary semantics**, and the component stops before accepting
 * its next unit of work. Nothing is suspended mid-statement and nothing is rolled back, which is
 * exactly why this is the mode appropriate to a plant - an exact pause can land after a valve has
 * already moved, and this one cannot land anywhere except between two whole pieces of work.
 *
 * **The mechanism is the barrier that already exists.** `holdExecution` puts an entry on the
 * instance's serial chain that never finishes: what was running finishes, what arrives queues.
 * That is the whole of a safe-boundary pause, and it is why this reaches five of the phase's seven
 * acceptance criteria without the worker that `RpcPauseGate` was built to measure.
 *
 * **A viewer must be told which pause this is.** The design says so and it is not cosmetic:
 * execution stopped *after* the handler, not on the line the probe is drawn beside. A screen that
 * showed a caret on that line would be telling somebody the component is between two statements when
 * it is between two calls.
 */

/** What happens when a pause outlives its lease. The design's three, and only one is free. */
export type RpcPauseExpiryAction =
    /** Let it go. The default for a simulation, and the only one a lost supervisor can still apply. */
    | 'resume'
    /** Stay stopped, but stop claiming a debugger owns it. Somebody has to come and decide. */
    | 'stopped'
    /** End the diagnostic activation and let the ordinary failure semantics carry the consequences. */
    | 'terminate'

/**
 * What happens to work that arrives while a component is paused.
 *
 * Only `buffer-bounded` is implemented, and it is not implemented so much as inherited: calls queue
 * behind the barrier in arrival order, bounded by the instance's mailbox, and a caller beyond that
 * bound is refused `Busy` by the machinery that always refuses it. The other two would need the
 * server to answer differently while paused, which is a change to the call path rather than a policy
 * on top of it - so they are named here and reported unsupported rather than silently approximated.
 */
export type RpcIncomingWorkPolicy = 'buffer-bounded' | 'refuse-as-paused' | 'supervisor-queries-only'

/** Where a component is stopped, published so a viewer can say so plainly. */
export interface RpcPauseState {
    readonly pauseId: string
    readonly componentId: string
    readonly semanticRevisionId: string
    readonly activationEpoch: string
    /** Which probe asked. The line it is drawn beside is where the *request* came from. */
    readonly probeId: string
    /**
     * Always `safe-boundary` here, and present so that a viewer never has to infer it.
     *
     * The design requires the two to be clearly distinguished, and a field that only ever holds one
     * value today is how a client written now keeps working when the other one exists.
     */
    readonly kind: 'safe-boundary'
    readonly pausedAt: string
    readonly expiresAt: number
    readonly controllerLeaseId?: string
    /** Calls queued behind the barrier. What resuming is about to let through. */
    readonly waiting: number
    readonly incomingWork: RpcIncomingWorkPolicy
}

export interface RpcDebuggerLease {
    readonly leaseId: string
    readonly sessionId: string
    readonly grantedAt: string
    readonly expiresAt: number
}

export interface RpcPauseRefusal {
    readonly why: string
}

export interface RpcPauseSupervisorOptions {
    readonly componentId: string
    readonly semanticRevisionId: string
    readonly activationEpoch: string
    /**
     * Take the barrier. `server.rpc.holdExecution` bound to the instance being watched.
     *
     * Injected rather than reached for, like the freshness signal in `@source-repo/query`: the thing
     * that owns the execution queue is in a better position to say what holding it means, and a
     * diagnostics package that reached into a server would be deciding that on its behalf.
     */
    readonly hold: () => RpcExecutionHold
    /** What to do when a pause outlives its lease. Declared up front, and visible before it matters. */
    readonly expiryAction: RpcPauseExpiryAction
    /** How long a pause may last unrenewed. A bound, because a stopped plant is a stopped plant. */
    readonly maxPauseMs?: number
    /**
     * Required when `expiryAction` is `terminate`, because this package cannot end an activation.
     *
     * Ending one means swapping the base artifact back or fencing what is running, both of which
     * belong to the deployment. A supervisor configured to terminate with nothing to terminate with
     * would discover that at the moment it was needed, so it is refused at construction instead.
     */
    readonly onTerminate?: () => void | Promise<void>
    readonly now?: () => number
    readonly newId?: (kind: string) => string
}

const DEFAULT_MAX_PAUSE_MS = 60_000

/**
 * One component's pauses, one at a time.
 *
 * At most one, because a second pause request while paused is the same pause: the component is
 * already stopped, and the probe that asked second has not run and will not until it is resumed.
 * Counting that as a new pause would tell a viewer the component stopped twice for two reasons when
 * it stopped once for the first of them.
 */
export class RpcPauseSupervisor {
    private held?: RpcExecutionHold
    private state_?: RpcPauseState
    private lease_?: RpcDebuggerLease
    private pausing?: Promise<RpcPauseState>
    private readonly maxPauseMs: number
    private readonly now: () => number
    private readonly newId: (kind: string) => string
    private counter = 0

    constructor(private readonly options: RpcPauseSupervisorOptions) {
        if (options.expiryAction === 'terminate' && !options.onTerminate)
            throw new Error(
                `${options.componentId}'s pause policy is to terminate on expiry and nothing was given to terminate with: ending an activation means swapping the approved artifact back or fencing what is running, and both belong to the deployment`
            )
        this.maxPauseMs = Math.max(1, options.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS)
        this.now = options.now ?? Date.now
        this.newId = options.newId ?? ((kind) => `${kind}-${++this.counter}`)
    }

    get state(): RpcPauseState | undefined {
        return this.state_
    }

    get lease(): RpcDebuggerLease | undefined {
        return this.lease_
    }

    /**
     * A probe asked for a pause. Take the barrier, let the running handler finish, then stop.
     *
     * **Nothing here interrupts anything.** The barrier goes into the queue and `quiescent` resolves
     * when what was already running has finished - which is what makes this pause survivable by a
     * component that was halfway through commanding something. The pause is not published until that
     * moment, because until then the component is not stopped, it is stopping.
     *
     * Safe to call from a probe: it does bounded work and returns a promise nobody has to await.
     */
    requested(probeId: string): Promise<RpcPauseState> {
        if (this.state_) return Promise.resolve(this.state_)
        if (this.pausing) return this.pausing
        const hold = this.options.hold()
        this.held = hold
        this.pausing = hold.quiescent.then(() => {
            const pausedAt = this.now()
            this.state_ = {
                pauseId: this.newId('pause'),
                componentId: this.options.componentId,
                semanticRevisionId: this.options.semanticRevisionId,
                activationEpoch: this.options.activationEpoch,
                probeId,
                kind: 'safe-boundary',
                pausedAt: new Date(pausedAt).toISOString(),
                expiresAt: pausedAt + this.maxPauseMs,
                ...(this.lease_ ? { controllerLeaseId: this.lease_.leaseId } : {}),
                waiting: hold.waiting(),
                incomingWork: 'buffer-bounded'
            }
            this.pausing = undefined
            return this.state_
        })
        return this.pausing
    }

    /**
     * Take the debugger controller lease, or be told who holds it.
     *
     * One holder, because two debuggers issuing continue at a paused plant is two people deciding
     * the same thing without knowing about each other. Everyone else authorised may still *watch*
     * the pause - reading is not controlling, and the design keeps them apart deliberately.
     */
    acquire(sessionId: string, ttlMs: number): RpcDebuggerLease | RpcPauseRefusal {
        this.sweep()
        if (this.lease_ && this.lease_.sessionId !== sessionId)
            return { why: `${this.options.componentId}'s debugger control is held by ${this.lease_.sessionId} until ${new Date(this.lease_.expiresAt).toISOString()}: control is transferred explicitly, never taken` }
        const grantedAt = this.now()
        this.lease_ = { leaseId: this.lease_?.leaseId ?? this.newId('lease'), sessionId, grantedAt: new Date(grantedAt).toISOString(), expiresAt: grantedAt + Math.max(1, Math.min(ttlMs, this.maxPauseMs)) }
        if (this.state_) this.state_ = { ...this.state_, controllerLeaseId: this.lease_.leaseId }
        return this.lease_
    }

    /**
     * Hand control to another session. Explicit, and it leaves a record - it does not simply move.
     *
     * The design asks for transfer to be audited, and the reason shows up in the only case that
     * matters: two people looking at one stopped plant, one of whom thinks they are driving.
     */
    transfer(leaseId: string, toSessionId: string): RpcDebuggerLease | RpcPauseRefusal {
        if (!this.lease_ || this.lease_.leaseId !== leaseId) return { why: 'that lease does not hold this component’s debugger control, so it cannot pass it on' }
        const from = this.lease_.sessionId
        this.lease_ = { ...this.lease_, sessionId: toSessionId, grantedAt: new Date(this.now()).toISOString() }
        this.transfers.push({ leaseId, from, to: toSessionId, at: this.lease_.grantedAt })
        return this.lease_
    }

    /** Every transfer this supervisor has seen, in order. The audit the design asks for. */
    readonly transfers: { leaseId: string; from: string; to: string; at: string }[] = []

    /** Give up control without resuming. A paused component stays paused; somebody else may drive. */
    releaseControl(leaseId: string): void {
        if (this.lease_?.leaseId === leaseId) this.lease_ = undefined
        if (this.state_) {
            const { controllerLeaseId, ...rest } = this.state_
            void controllerLeaseId
            this.state_ = rest
        }
    }

    /**
     * Let it go, on the authority of the lease that holds control.
     *
     * Refused without the lease, and that refusal is the whole point of having one: resuming a plant
     * is an act, and an act needs somebody who can be named as having taken it.
     */
    continueExecution(leaseId: string): RpcPauseState | RpcPauseRefusal {
        if (!this.state_) return { why: `${this.options.componentId} is not paused, so there is nothing to continue` }
        if (!this.lease_ || this.lease_.leaseId !== leaseId)
            return { why: `${this.options.componentId} is paused and this caller does not hold its debugger control: resuming a component is an act, and an act needs somebody who can be named as having taken it` }
        const was = this.state_
        this.let_go()
        return was
    }

    /**
     * Apply the deadline. Returns what it did, or nothing when there was nothing to do.
     *
     * Called by whoever is publishing - the same pump that moves probe samples into state - so that
     * a pause cannot outlive its lease merely because nobody asked. A lost controller is the case
     * this exists for, and it is why the expiry action is declared before it is needed rather than
     * decided when it is.
     */
    sweep(): RpcPauseExpiryAction | undefined {
        const at = this.now()
        if (this.lease_ && this.lease_.expiresAt <= at) this.lease_ = undefined
        if (!this.state_ || this.state_.expiresAt > at) return undefined

        const action = this.options.expiryAction
        if (action === 'resume') {
            this.let_go()
            return 'resume'
        }
        if (action === 'stopped') {
            // Still held, and no longer anybody's. The component stays stopped and says so, which is
            // an honest state to be in: somebody has to come and decide, and nothing here can.
            const { controllerLeaseId, ...rest } = this.state_
            void controllerLeaseId
            this.state_ = { ...rest, expiresAt: at }
            this.lease_ = undefined
            return 'stopped'
        }
        this.let_go()
        void this.options.onTerminate?.()
        return 'terminate'
    }

    /** Release the barrier and forget the pause. The one path out, so it cannot be half-taken. */
    private let_go(): void {
        this.held?.release()
        this.held = undefined
        this.state_ = undefined
    }
}
