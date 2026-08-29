import { rpc } from '../Expose.js'
import { serveInWorker, type RpcWorkerContext } from '../WorkerRuntime.js'

/**
 * A component hosted on its own thread, shaped like one that has been instrumented.
 *
 * The gates inside `bake` stand in for what a diagnostic variant's probes call: a real instrumented
 * build gets them from the transformer, and this has them written by hand so the pause can be tested
 * without a build service. What matters is where they are - *between statements, inside a handler* -
 * because stopping there is the whole difference between an exact pause and a safe-boundary one.
 */

interface OvenState {
    setpoint: number
    batches: number
}

let held: RpcWorkerContext

class Oven {
    private readonly state: OvenState = { setpoint: 0, batches: 0 }

    /** Three statements and a gate between each, so a pause can land in the middle of the work. */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    bake(target: number): OvenState {
        held.gate()
        const clamped = target > 300 ? 300 : target
        held.gate()
        this.state.setpoint = clamped
        held.gate()
        this.state.batches = this.state.batches + 1
        return { ...this.state }
    }

    /**
     * Gates repeatedly over a span, so a pause request arriving at any moment meets one.
     *
     * `bake` gates three times in a row with nothing in between, which makes a test that asks for a
     * pause *after* issuing the call a race against the scheduler - two real threads, and the worker
     * may finish before the request lands. That is not a flaw in the mechanism but a fact about it:
     * a request only affects gates reached after it. This is the handler for testing what happens
     * when one is reached, and it is what a handler doing actual work between probes looks like.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    soak(ms: number): number {
        const until = Date.now() + ms
        let passes = 0
        while (Date.now() < until) {
            held.gate()
            passes++
        }
        return passes
    }

    /** No gates: a handler that reaches none cannot be paused, which is a limit worth testing. */
    @rpc({ semantics: 'query', effect: 'observe' })
    ungated(): number {
        return this.state.batches
    }

    /**
     * Throws with a code a handler is allowed to choose, so its crossing can be checked.
     *
     * `UnknownOutcome` rather than something like `NotInControl`: the server's allow-list decides
     * which codes a *handler* may select, and the ones it produces itself for authority and
     * ownership are not among them. A worker-hosted handler is a handler, so the same list applies -
     * moving to a thread neither widens nor narrows what it may claim.
     */
    @rpc({ semantics: 'idempotent-command' })
    refuse(): never {
        const failure = new Error('the downstream valve did not answer')
        ;(failure as { code?: string }).code = 'UnknownOutcome'
        throw failure
    }

    /** Returns something that cannot be cloned, which has to fail as itself. */
    @rpc({ semantics: 'query' })
    unclonable(): unknown {
        return () => 1
    }
}

serveInWorker(new Oven(), { maxPauseMs: 5_000, context: (context) => (held = context) })
