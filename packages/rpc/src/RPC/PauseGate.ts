/**
 * Stopping a component's logic dead, while the thing that stopped it stays answering.
 *
 * **In this package because this package owns execution.** It began in `@source-repo/diagnostics`,
 * measured on its own before anything was built on it, and moved here the moment something needed
 * to stop a component rather than describe stopping one: the queue a call runs on is here, the
 * worker that holds a component's logic is here, and a primitive that parks the second while the
 * first keeps answering belongs beside both. Diagnostics still re-exports it, because a debugger is
 * the thing that will ask.
 *
 * **It is a mechanism and not a feature.** There is no breakpoint here, no supervisor protocol, no
 * controller lease and no stepping. What is here is the primitive those need, with its limits
 * established rather than assumed - and the limits are in `notes/exact-pause-feasibility.md`,
 * because several of them decide what can be built on it.
 *
 * ## How it stops something
 *
 * `Atomics.wait` blocks a worker's JavaScript thread outright: not a promise that resolves later, but
 * the thread parked in the kernel. Nothing else on that thread runs - not its microtasks, not its
 * timers, not its socket callbacks - which is exactly what "the component logic execution context is
 * blocked" has to mean, and exactly why the supervisor cannot live on the same thread.
 *
 * The supervisor side never calls `Atomics.wait`. It uses `Atomics.waitAsync`, which returns a
 * promise instead of parking, so the process that is holding a component still answers everything
 * else while the component is stopped. A supervisor that blocked to wait for a pause would have
 * suspended the only thing capable of ending it.
 *
 * ## The cost on the hot path
 *
 * One `Atomics.load` per arrival when no pause is requested, and nothing else: no allocation, no
 * call out, no branch beyond the comparison. That number matters more than it looks, because a gate
 * is reached at every probe of every instrumented statement - a mechanism that cost a promise per
 * statement would be unusable on the thing it exists to observe.
 */

/** What a worker's arrival at a gate did. Three outcomes, and they are three different facts. */
export type RpcGateOutcome =
    /** No pause was requested, and the gate cost one atomic read. */
    | 'ran-through'
    /** It parked, and a supervisor let it go. */
    | 'released'
    /**
     * It parked, and nothing let it go before the deadline, so it let itself go.
     *
     * The design requires a deterministic expiry action and says a disconnected debugger must not
     * leave a node paused indefinitely. This is the floor under that: it is enforced by the parked
     * thread's own timeout rather than by the supervisor, because the case that matters is exactly
     * the one where the supervisor is gone. Policies richer than *resume* can only be applied by
     * something still alive.
     */
    | 'expired'

/**
 * One word says whether the logic may run, and what it is running *to*.
 *
 * Packed into a single slot rather than a flag beside a mode, because the fast path reads it on
 * every gate arrival and one atomic load is the whole budget. Zero means run: a component nobody is
 * watching pays one read and a comparison against nought, which is what makes it affordable to put
 * a gate on every statement.
 */
const CONTROL = 0
const PARKED = 1
const RELEASES = 2
/** The logical frame depth, maintained by the entry and exit arrivals. Published, so a viewer can show it. */
const DEPTH = 3
/** What the current mode is running to: a frame depth, or a probe's index. Read off the fast path. */
const TARGET = 4
/**
 * Which probe the logic is parked at, by index, or -1.
 *
 * Written when it parks, so the other side can say *where* rather than only *that*. Without it a
 * step reports the position the debugger was standing at before the step, since the supervisor has
 * nothing else to name - and a debugger that draws its caret one step behind is worse than one that
 * draws no caret at all.
 */
const AT = 5
/**
 * How many times the logic has parked. The only reliable way to wait for the *next* park.
 *
 * Waiting for it to be running and then for it to be parked looks equivalent and is not: between
 * two adjacent gates the logic can park again before the supervisor observes it leaving, so the
 * first wait times out on a component that is stepping perfectly. A counter cannot be missed - the
 * supervisor reads it before stepping and waits for a different value.
 */
const PARKS = 6

/** What the logic is running to. `free` is nought, so the fast path is a comparison against nought. */
const FREE = 0
/** Park at the next gate of any kind. What a breakpoint asks for. */
const PARK_NEXT = 1
/** Park at the next statement or entry, however deep. The design's *step into*. */
const STEP_INTO = 2
/** Park at the next gate at the target depth or shallower. *Step over*: a deeper frame runs through. */
const STEP_OVER = 3
/** Park at the next gate shallower than the target. *Step out*: the current frame's exit. */
const STEP_OUT = 4
/** Park when the arriving probe's index matches. *Run to cursor*, by index rather than by name. */
const RUN_TO = 5

/**
 * What kind of point in the program a gate arrival is.
 *
 * Three, because three is what a frame stack needs: a frame opened, a frame closed, and a place
 * inside one where execution can be said to be. The generated function-entry and function-exit
 * probes maintain the depth; the statement probes are the places a step lands.
 */
export type RpcFrameEvent = 'enter' | 'exit' | 'step'

/** Where the logic is arriving, for a gate that has to decide more than *is a pause wanted*. */
export interface RpcGateArrival {
    readonly frame: RpcFrameEvent
    /**
     * This probe's index in the registry both sides share, for *run to cursor*.
     *
     * An index rather than a name, and that is forced rather than chosen: a step command is issued
     * while the logic thread is **parked**, so it cannot arrive as a message - a parked thread does
     * not read its queue. It has to arrive through shared memory, and shared memory holds integers.
     * Matching on a hash of the name instead would mean stopping at the wrong line on a collision,
     * which is precisely the thing a debugger must not do.
     */
    readonly probe?: number
}

/** What a step command asks for. The design's five, named as it names them. */
export type RpcStepMode = 'continue' | 'into' | 'over' | 'out' | 'run-to-probe'

/**
 * The two ends of one gate, over memory both threads share.
 *
 * A `SharedArrayBuffer` rather than messages, because a message cannot stop a thread: it arrives on
 * the event loop of the thread that is meant to be stopping, which will not look at its event loop
 * again until it has stopped. The only way to park a thread at a point of its own choosing is for it
 * to read a flag it can see without being scheduled, which is what shared memory is.
 */
export class RpcPauseGate {
    private readonly view: Int32Array
    private probeIds: readonly string[] = []

    constructor(readonly buffer: SharedArrayBuffer) {
        this.view = new Int32Array(buffer)
    }

    /** A fresh gate. Hand `buffer` to the worker; keep this side for the supervisor. */
    static create(): RpcPauseGate {
        return new RpcPauseGate(new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT))
    }

    /** The logical frame depth the logic is at, for a viewer that wants to show where it is. */
    get depth(): number {
        return Atomics.load(this.view, DEPTH)
    }

    /**
     * The registry that turns the index in shared memory back into a probe's name.
     *
     * Told to both sides rather than sent across: the index is what a parked thread can be given and
     * can report, and the name is what a person reads. Each side holds the same list, which is the
     * only way an index means the same thing to both.
     */
    knowProbes(probeIds: readonly string[]): void {
        this.probeIds = probeIds
    }

    /** How many times the logic has parked. Read before a step, waited on after one. */
    get parks(): number {
        return Atomics.load(this.view, PARKS)
    }

    /**
     * Resolve when the logic parks *again*, having parked `since` times before.
     *
     * The wait a step needs. "Wait for it to be running, then wait for it to be parked" is the
     * obvious shape and is wrong: between two adjacent gates the logic can park again before this
     * side observes it leaving, so the first wait times out while everything is working. A count
     * cannot be missed, however fast the round trip is.
     */
    async untilParkedSince(since: number, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (this.parks === since) {
            const left = deadline - Date.now()
            if (left <= 0) return false
            const waiting = Atomics.waitAsync(this.view, PARKS, since, left)
            if (waiting.async) await waiting.value
            else if (waiting.value === 'timed-out') return false
        }
        return true
    }

    /** Which probe it is parked at, by name, where the registry knows one. */
    get at(): string | undefined {
        const index = Atomics.load(this.view, AT)
        return index >= 0 ? this.probeIds[index] : undefined
    }

    // ---- The logic side. Only ever called on the worker thread. ----

    /**
     * Arrive at a gate: run through, or park here until released or until the deadline.
     *
     * **Called from the probe, so it returns into the middle of the handler it stopped.** That is
     * the property an exact breakpoint needs and the one a safe-boundary pause cannot give: when
     * this returns, the statement after the probe is next, the locals are the locals, and nothing
     * has been re-executed. It is the same stack, continued - not a re-entry.
     *
     * Synchronous and blocking, deliberately. An `await` here would let the thread run everything
     * else it had queued, which is the opposite of a pause: the component would keep accepting work
     * while claiming to be stopped.
     */
    arrive(maxPauseMs: number, at?: RpcGateArrival): RpcGateOutcome {
        // The frame stack first, and unconditionally: depth has to be right even while nobody is
        // watching, or the first step command issued would be measured from a number that had been
        // drifting since the component started.
        if (at?.frame === 'enter') Atomics.add(this.view, DEPTH, 1)
        else if (at?.frame === 'exit') Atomics.sub(this.view, DEPTH, 1)

        // The hot path, and the whole reason a gate can sit on every statement: one atomic load and
        // a comparison against nought.
        const control = Atomics.load(this.view, CONTROL)
        if (control === FREE) return 'ran-through'
        if (!this.stopsHere(control, at)) return 'ran-through'

        // A step is one step: whatever brought the logic here is spent, and what happens next is
        // decided by whoever is holding the pause. Left standing, a *step over* would fire again at
        // the next gate the moment it was released, which is a debugger stepping on its own.
        Atomics.store(this.view, CONTROL, PARK_NEXT)

        // Where it stopped, before it announces that it stopped: a supervisor woken by the second
        // and reading the first must not find the previous park's position still there.
        Atomics.store(this.view, AT, at?.probe ?? -1)

        // Read the release counter *before* announcing the park. If a release lands in the gap, the
        // wait below sees a value that is not the one it was told to expect and returns immediately
        // - which is the race handled by construction rather than by a lock.
        const seen = Atomics.load(this.view, RELEASES)
        Atomics.add(this.view, PARKS, 1)
        Atomics.store(this.view, PARKED, 1)
        Atomics.notify(this.view, PARKED)
        Atomics.notify(this.view, PARKS)
        const woke = Atomics.wait(this.view, RELEASES, seen, Math.max(0, maxPauseMs))
        Atomics.store(this.view, PARKED, 0)
        Atomics.notify(this.view, PARKED)
        return woke === 'timed-out' ? 'expired' : 'released'
    }

    /**
     * Whether this arrival is the one the current mode was running to.
     *
     * Off the fast path by construction: it is only reached once the control word says something is
     * wanted, so the extra reads cost nothing to a component nobody is watching.
     */
    private stopsHere(control: number, at?: RpcGateArrival): boolean {
        if (control === PARK_NEXT) return true
        const target = Atomics.load(this.view, TARGET)
        const depth = Atomics.load(this.view, DEPTH)
        switch (control) {
            case STEP_INTO:
                // The very next point, whatever it is - which makes *into* and a plain park-next
                // the same predicate. That is not a coincidence to be tidied away: stepping into is
                // stopping at the next place there is to stop, and what differs between them is
                // only which command asked. Excluding exits was tried and is worse: stepping into
                // at the last statement of a function would then run off the end of the program.
                return true
            case STEP_OVER:
                // Shallower than here, or the same frame and not an exit. Both halves earn their
                // place: without the first, stepping over the last statement of a function would
                // never land on its exit; without the second, stepping over a *call* would land on
                // the callee's exit - which is depth-equal once the exit has decremented, and is
                // precisely the frame the step was asked to go around.
                return depth < target || (depth === target && at?.frame !== 'exit')
            case STEP_OUT:
                // Shallower than where the step was issued: the current frame's exit is the first
                // arrival that qualifies, because depth is decremented before this is asked.
                return depth < target
            case RUN_TO:
                return at?.probe !== undefined && at.probe === target
            default:
                return true
        }
    }

    // ---- The supervisor side. Only ever called off the logic thread. ----

    /**
     * Ask the logic context to park at its next gate.
     *
     * Not *now*: at its next gate, which is a probe boundary. There is no way to stop a thread
     * between two statements it has already begun, and pretending otherwise is where a debugger
     * starts lying about where execution is.
     */
    request(): void {
        Atomics.store(this.view, CONTROL, PARK_NEXT)
    }

    /** Let it go, and clear the request so the next gate runs through. */
    release(): void {
        Atomics.store(this.view, CONTROL, FREE)
        Atomics.add(this.view, RELEASES, 1)
        Atomics.notify(this.view, RELEASES)
    }

    get requested(): boolean {
        return Atomics.load(this.view, CONTROL) !== FREE
    }

    /**
     * Let it go, and stop it again at the point the step names.
     *
     * **One call, because the two halves cannot be separated.** Setting the mode and then releasing
     * would leave a window in which the logic is running with the previous mode still in force, and
     * the window is exactly one gate wide - which for a component being stepped through is exactly
     * the gate that mattered. The mode is stored, then the release, in that order and with nothing
     * between.
     *
     * `continue` clears the mode entirely: it means *run until something else stops you*, which is
     * a breakpoint's business rather than a step's.
     */
    step(mode: RpcStepMode, target?: number): void {
        const modes: { readonly [key in RpcStepMode]: number } = { continue: FREE, into: STEP_INTO, over: STEP_OVER, out: STEP_OUT, 'run-to-probe': RUN_TO }
        // `over` and `out` are relative to where the logic is standing now, so the depth is read
        // here rather than supplied: a caller computing it would be computing it from a number it
        // read a moment ago, which is a moment in which the logic has not moved but the arithmetic
        // has become somebody else's.
        Atomics.store(this.view, TARGET, mode === 'run-to-probe' ? (target ?? -1) : Atomics.load(this.view, DEPTH))
        Atomics.store(this.view, CONTROL, modes[mode])
        Atomics.add(this.view, RELEASES, 1)
        Atomics.notify(this.view, RELEASES)
    }

    /** Whether a logic thread is parked at this gate right now. */
    get paused(): boolean {
        return Atomics.load(this.view, PARKED) === 1
    }

    /**
     * Resolve when something parks here, or when the wait runs out.
     *
     * `Atomics.waitAsync` rather than `Atomics.wait`, and the difference is the whole architecture:
     * this side must stay responsive while the other side is stopped. Node permits `Atomics.wait` on
     * a main thread and it would work here - and it would suspend the supervisor, the transport and
     * every other component in the process in order to watch one of them stop.
     */
    async untilPaused(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (!this.paused) {
            const left = deadline - Date.now()
            if (left <= 0) return false
            const waiting = Atomics.waitAsync(this.view, PARKED, 0, left)
            if (waiting.async) await waiting.value
            else if (waiting.value === 'timed-out') return false
        }
        return true
    }

    /** Resolve when whatever was parked here has gone. The mirror of the above, for a resume. */
    async untilRunning(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs
        while (this.paused) {
            const left = deadline - Date.now()
            if (left <= 0) return false
            const waiting = Atomics.waitAsync(this.view, PARKED, 1, left)
            if (waiting.async) await waiting.value
            else if (waiting.value === 'timed-out') return false
        }
        return true
    }
}
