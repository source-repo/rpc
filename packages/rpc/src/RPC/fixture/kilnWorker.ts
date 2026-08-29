import { RpcComponent } from '../Component.js'
import { rpc, rpcNamespace } from '../Expose.js'
import { serveComponentInWorker, type RpcWorkerContext } from '../WorkerRuntime.js'

/**
 * A real component, hosted on a worker thread.
 *
 * Written exactly as it would be written to run in-process: it extends `RpcComponent`, it commits
 * with `setState`, it declares what it sets and what needs authority, and it emits an event. Nothing
 * in it knows which thread it is on, which is the property the facade exists to preserve.
 */

interface KilnProps extends Record<string, unknown> {
    label: string
}

interface KilnState extends Record<string, unknown> {
    setpoint: number
    firings: number
}

let held: RpcWorkerContext

@rpcNamespace('kiln', { execution: 'serial' })
class Kiln extends RpcComponent<KilnProps, KilnState> {
    constructor() {
        super({ label: 'Kiln 1' }, { setpoint: 0, firings: 0 })
    }

    /** Commits twice, with a gate between, so a pause can be taken with the state part-way moved. */
    @rpc({ semantics: 'idempotent-command', effect: 'operate', sets: 'setpoint' })
    fire(target: number): number {
        this.setState({ setpoint: target })
        held.at('step', 'kiln:mid')
        this.setState((previous) => ({ firings: previous.firings + 1 }))
        this.emit('fired', { target })
        return this.state.firings
    }

    /** Declared as needing authority, to prove the facade is what the server gates. */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate', requiresAuthority: true })
    vent(): string {
        return 'vented'
    }

    /** Emits something that cannot cross, so the refusal lands at the line that wrote it. */
    @rpc({ semantics: 'query' })
    announceBadly(): string {
        this.emit('odd', () => 1)
        return 'unreachable'
    }
}

serveComponentInWorker(new Kiln(), { maxPauseMs: 5_000, context: (context) => (held = context), probeIds: ['kiln:mid'] })
