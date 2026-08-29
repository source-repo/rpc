/**
 * Stopping a component's logic dead, while the thing that stopped it stays answering.
 *
 * This is the mechanism an exact breakpoint would be built on, built and measured on its own before
 * anything is built on top of it - the design's Phase 3 asks for an *isolated pausable logic worker*
 * and a *supported runtime pause gate*, and whether this runtime can honestly provide either is a
 * question to answer with a working gate rather than with a plan.
 *
 * **It is the mechanism and not the feature.** There is no breakpoint here, no supervisor protocol,
 * no controller lease and no stepping, so `exactPause` and `stepping` stay advertised `false`. What
 * is here is the one primitive those would need, with its limits established rather than assumed -
 * and the limits are in `notes/exact-pause-feasibility.md`, because several of them decide what the
 * feature can be.
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

const REQUEST = 0
const PARKED = 1
const RELEASES = 2

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

    constructor(readonly buffer: SharedArrayBuffer) {
        this.view = new Int32Array(buffer)
    }

    /** A fresh gate. Hand `buffer` to the worker; keep this side for the supervisor. */
    static create(): RpcPauseGate {
        return new RpcPauseGate(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT))
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
    arrive(maxPauseMs: number): RpcGateOutcome {
        // The hot path, and the whole reason a gate can sit on every statement.
        if (Atomics.load(this.view, REQUEST) !== 1) return 'ran-through'

        // Read the release counter *before* announcing the park. If a release lands in the gap, the
        // wait below sees a value that is not the one it was told to expect and returns immediately
        // - which is the race handled by construction rather than by a lock.
        const seen = Atomics.load(this.view, RELEASES)
        Atomics.store(this.view, PARKED, 1)
        Atomics.notify(this.view, PARKED)
        const woke = Atomics.wait(this.view, RELEASES, seen, Math.max(0, maxPauseMs))
        Atomics.store(this.view, PARKED, 0)
        Atomics.notify(this.view, PARKED)
        return woke === 'timed-out' ? 'expired' : 'released'
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
        Atomics.store(this.view, REQUEST, 1)
    }

    /** Let it go, and clear the request so the next gate runs through. */
    release(): void {
        Atomics.store(this.view, REQUEST, 0)
        Atomics.add(this.view, RELEASES, 1)
        Atomics.notify(this.view, RELEASES)
    }

    get requested(): boolean {
        return Atomics.load(this.view, REQUEST) === 1
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
