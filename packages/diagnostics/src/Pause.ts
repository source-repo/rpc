import type { RpcExecutionHold } from '@source-repo/rpc'

/**
 * What an exact pause is driven through: the gate a component's own logic parks at.
 *
 * `RpcPauseGate` satisfies this, and `RpcWorkerHost.gate` is where a worker-hosted component's
 * comes from. Taken structurally rather than by class so that a deployment with its own pausable
 * runtime - another language, another isolation mechanism - can drive this supervisor with it.
 */
export interface RpcExactPauseControl {
    /** Ask the logic to park at its next gate. Returns at once; it parks when it arrives. */
    request(): void
    /** Let it go. The statement after the gate is next. */
    release(): void
    readonly paused: boolean
    untilPaused(timeoutMs: number): Promise<boolean>
    /**
     * Let it go, and stop it again where the step names. Absent on a gate that cannot step.
     *
     * Optional because stepping is a strictly larger power than pausing, and a deployment with a
     * pausable runtime that keeps no frame stack can honestly offer the one without the other -
     * which is what `stepping` in the capability set is for.
     */
    step?(mode: RpcStepMode, target?: number): void
    /**
     * Resolve once whatever was parked here has gone. Needed by every step, and not optional to it.
     *
     * A step waits for the logic to stop again, and *the logic has not left yet* at the moment the
     * command is issued - so a wait that only asked "is it parked" would be answered by the park the
     * step was meant to end, and report the position the debugger was already standing at. Every
     * step would appear to go nowhere, one step behind the truth.
     */
    untilRunning?(timeoutMs: number): Promise<boolean>
    /** How many times the logic has parked, and a wait for the next one. What a step waits on. */
    readonly parks?: number
    untilParkedSince?(since: number, timeoutMs: number): Promise<boolean>
    /** The logical frame depth, for a viewer showing where in the program the logic is standing. */
    readonly depth?: number
    /** Which probe it is parked at, where the mechanism can say. What a viewer draws its caret on. */
    readonly at?: string | undefined
}

/** The design's five commands, meaning exactly what section 23 says they mean. */
export type RpcStepMode = 'continue' | 'into' | 'over' | 'out' | 'run-to-probe'

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

/**
 * Which kind of stop this is, and it is a property of the mechanism rather than a label.
 *
 * A supervisor driving a barrier can only produce `safe-boundary`, and one driving a gate can only
 * produce `exact`. That is enforced by there being one mechanism per supervisor: the design requires
 * the two to be clearly distinguished, and the surest way to distinguish them is to make claiming
 * the wrong one impossible rather than incorrect.
 */
export type RpcPauseKind = 'safe-boundary' | 'exact'

/** Where a component is stopped, published so a viewer can say so plainly. */
export interface RpcPauseState {
    readonly pauseId: string
    readonly componentId: string
    readonly semanticRevisionId: string
    readonly activationEpoch: string
    /** Which probe asked. The line it is drawn beside is where the *request* came from. */
    readonly probeId: string
    /**
     * Which stop this is, and a viewer must say which - the design requires it.
     *
     * `safe-boundary` means execution stopped **after** a handler, so a caret on the probe's line
     * would put the component where it is not. `exact` means it stopped *at* that line, with the
     * statement after the gate still to run. They are different facts about where a plant is, and a
     * screen that showed them the same way would be wrong about one of them.
     */
    readonly kind: RpcPauseKind
    readonly pausedAt: string
    readonly expiresAt: number
    readonly controllerLeaseId?: string
    /** Calls queued behind the barrier. What resuming is about to let through. */
    readonly waiting: number
    readonly incomingWork: RpcIncomingWorkPolicy
    /** How deep in its own frames the logic is standing. Present where a frame stack is kept. */
    readonly frameDepth?: number
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
     * Take the barrier, for a safe-boundary stop. `server.rpc.holdExecution` bound to the instance.
     *
     * Injected rather than reached for, like the freshness signal in `@source-repo/query`: the thing
     * that owns the execution queue is in a better position to say what holding it means, and a
     * diagnostics package that reached into a server would be deciding that on its behalf.
     *
     * Exactly one of this and `gate` - a supervisor with both would be a supervisor that could
     * claim either kind of pause while producing the other.
     */
    readonly hold?: () => RpcExecutionHold
    /**
     * The gate, for an exact stop: `RpcWorkerHost.gate` for a component hosted on its own thread.
     *
     * This is the mechanism the feasibility work measured. It parks the logic thread *between two
     * statements of a handler*, which is what an exact breakpoint means and what a barrier cannot
     * do - a barrier can only stop what has not started.
     */
    readonly gate?: RpcExactPauseControl
    /**
     * How long to wait for the component to actually stop before withdrawing the request.
     *
     * Both mechanisms can fail to stop: a barrier waits on a handler that may never return, and a
     * gate waits for logic that may reach no further gate. **The request is withdrawn on the way
     * out**, because a pause request left outstanding is worse than one that failed - the component
     * would park later, unexpectedly, with nobody watching for it.
     */
    readonly maxWaitForPauseMs?: number
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
const DEFAULT_MAX_WAIT_FOR_PAUSE_MS = 5_000

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
    private pausing?: Promise<RpcPauseState | undefined>
    private readonly maxPauseMs: number
    private readonly maxWaitForPauseMs: number
    private readonly now: () => number
    private readonly newId: (kind: string) => string
    private counter = 0

    constructor(private readonly options: RpcPauseSupervisorOptions) {
        if (options.expiryAction === 'terminate' && !options.onTerminate)
            throw new Error(
                `${options.componentId}'s pause policy is to terminate on expiry and nothing was given to terminate with: ending an activation means swapping the approved artifact back or fencing what is running, and both belong to the deployment`
            )
        if ((options.hold === undefined) === (options.gate === undefined))
            throw new Error(
                `${options.componentId}'s pause supervisor needs exactly one mechanism: a barrier for a safe-boundary stop or a gate for an exact one. With both it could claim either kind while producing the other, and with neither it cannot stop anything.`
            )
        this.maxPauseMs = Math.max(1, options.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS)
        this.maxWaitForPauseMs = Math.max(1, options.maxWaitForPauseMs ?? DEFAULT_MAX_WAIT_FOR_PAUSE_MS)
        this.now = options.now ?? Date.now
        this.newId = options.newId ?? ((kind) => `${kind}-${++this.counter}`)
    }

    get state(): RpcPauseState | undefined {
        return this.state_
    }

    /**
     * Which kind of stop this supervisor can produce, decided by which mechanism it was given.
     *
     * Read by the service to work out whether the node may advertise `exactPause`, which is the
     * point of the kind being a property of the mechanism: a node cannot advertise a stop it has no
     * way of making.
     */
    get kind(): RpcPauseKind {
        return this.options.gate ? 'exact' : 'safe-boundary'
    }

    /**
     * Whether this supervisor can step, which is a fact about its mechanism rather than about it.
     *
     * A barrier cannot: stepping is a predicate over a frame stack, and a barrier stops what has not
     * started rather than standing anywhere in a program. A gate can, when the runtime behind it
     * keeps the stack.
     */
    get canStep(): boolean {
        return typeof this.options.gate?.step === 'function'
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
    requested(probeId: string): Promise<RpcPauseState | undefined> {
        if (this.state_) return Promise.resolve(this.state_)
        if (this.pausing) return this.pausing
        this.pausing = (this.options.gate ? this.parkAtGate() : this.parkAtBarrier()).then((waiting) => {
            this.pausing = undefined
            // It never stopped: a handler that has not returned, or logic that reached no further
            // gate. The request is withdrawn rather than left standing, because a component that
            // parked ten minutes later with nobody watching would be worse than one that did not
            // park at all.
            if (waiting === undefined) {
                this.let_go()
                return undefined
            }
            const pausedAt = this.now()
            this.state_ = {
                pauseId: this.newId('pause'),
                componentId: this.options.componentId,
                semanticRevisionId: this.options.semanticRevisionId,
                activationEpoch: this.options.activationEpoch,
                // The probe that asked, unless the mechanism can say where it actually stopped: a
                // request parks at the *next* gate, which is not always the one that asked.
                probeId: this.options.gate?.at ?? probeId,
                kind: this.kind,
                pausedAt: new Date(pausedAt).toISOString(),
                expiresAt: pausedAt + this.maxPauseMs,
                ...(this.lease_ ? { controllerLeaseId: this.lease_.leaseId } : {}),
                waiting,
                incomingWork: 'buffer-bounded'
            }
            return this.state_
        })
        return this.pausing
    }

    /**
     * The barrier: what was running finishes, and the component stops before the next unit of work.
     *
     * The deadline is on reaching quiescence, not on the pause: a handler that never returns is a
     * component that cannot be stopped this way, and waiting for it forever would leave a barrier in
     * the queue holding back every call behind it.
     */
    private async parkAtBarrier(): Promise<number | undefined> {
        const hold = this.options.hold!()
        this.held = hold
        let expiry: ReturnType<typeof setTimeout> | undefined
        const quiescent = await Promise.race([
            hold.quiescent.then(() => true as const),
            new Promise<false>((resolve) => {
                expiry = setTimeout(() => resolve(false), this.maxWaitForPauseMs)
                expiry.unref?.()
            })
        ]).finally(() => clearTimeout(expiry))
        return quiescent ? hold.waiting() : undefined
    }

    /**
     * The gate: the logic thread parks *between two statements of a handler*.
     *
     * Nothing here blocks. The supervisor asks and waits asynchronously, because the whole point of
     * putting the logic on another thread was that the thing capable of releasing it stays running -
     * a supervisor that blocked to watch a component stop would have stopped itself as well.
     *
     * Zero waiting calls, and that is not a placeholder: with the logic on its own thread, what
     * queues behind a pause queues on the server's side and is counted there. A number invented here
     * would be a different queue's depth reported as this one's.
     */
    private async parkAtGate(): Promise<number | undefined> {
        const gate = this.options.gate!
        gate.request()
        return (await gate.untilPaused(this.maxWaitForPauseMs)) ? 0 : undefined
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
     * Resume, and stop again where the step names. The design's five commands, on the lease.
     *
     * **The same authority as a resume, because it is one.** Every step lets the component run - the
     * question a step answers is only *how far* - so it is the lease holder's to issue, and a step
     * command is no more repeatable than a continue: a retry arriving after one completed would step
     * a second time, from somewhere the caller has not seen.
     *
     * `run-to-probe` needs a probe the artifact actually carries. A cursor the build does not have
     * is refused rather than resolved to the nearest thing, which is the same rule the plan and the
     * artifact are already held to.
     */
    async step(leaseId: string, mode: RpcStepMode, targetProbe?: number): Promise<RpcPauseState | undefined | RpcPauseRefusal> {
        if (!this.state_) return { why: `${this.options.componentId} is not paused, so there is nowhere to step from` }
        if (!this.lease_ || this.lease_.leaseId !== leaseId)
            return { why: `${this.options.componentId} is paused and this caller does not hold its debugger control: stepping resumes a component, and resuming one is an act somebody has to be named for` }
        const gate = this.options.gate
        if (!gate?.step)
            return { why: `${this.options.componentId} is stopped at a barrier rather than at a gate, so there is no frame stack to step over: a barrier stops what has not started, and a step is a question about where in a program the logic is standing` }
        if (mode === 'run-to-probe' && targetProbe === undefined)
            return { why: `running to a cursor needs a probe this artifact carries, and none was named - a cursor the build does not have is one nothing can run to` }

        const probeId = this.state_.probeId
        this.state_ = undefined
        // Read before the step, waited on after it: a step ends at the *next* park, and asking
        // "is it parked" would be answered by the one this step is ending.
        const since = gate.parks ?? 0
        gate.step(mode, targetProbe)
        // `continue` is not a step: it means run until something else stops you, so there is nothing
        // to wait for. The next pause will arrive through whatever asks for it.
        if (mode === 'continue') return undefined
        // Waiting for it to be *running* and then parked was tried and is wrong: between two
        // adjacent gates the logic parks again before this side observes it leaving, so the first
        // wait times out on a component that is stepping perfectly - two seconds a step, and the
        // answer right anyway. A park count cannot be missed however fast the round trip is.
        const parked = gate.untilParkedSince ? await gate.untilParkedSince(since, this.maxWaitForPauseMs) : await gate.untilPaused(this.maxWaitForPauseMs)
        if (!parked) {
            // It stepped and never met another gate - the frame ran out, or the handler ended. The
            // component is running again and nothing is holding it, which is the honest outcome and
            // not a failure: a step off the end of a program is where a program ends.
            gate.release()
            return undefined
        }
        const pausedAt = this.now()
        this.state_ = {
            pauseId: this.newId('pause'),
            componentId: this.options.componentId,
            semanticRevisionId: this.options.semanticRevisionId,
            activationEpoch: this.options.activationEpoch,
            // Where it actually stopped, which after a step is not where it was asked to stop from.
            probeId: gate.at ?? probeId,
            kind: 'exact',
            pausedAt: new Date(pausedAt).toISOString(),
            expiresAt: pausedAt + this.maxPauseMs,
            controllerLeaseId: this.lease_.leaseId,
            waiting: 0,
            incomingWork: 'buffer-bounded',
            ...(gate.depth !== undefined ? { frameDepth: gate.depth } : {})
        }
        return this.state_
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

    /** Let the component go, by whichever mechanism holds it. One path out, so it cannot be half-taken. */
    private let_go(): void {
        this.held?.release()
        this.held = undefined
        this.options.gate?.release()
        this.state_ = undefined
    }
}
