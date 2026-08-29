import { Worker } from 'node:worker_threads'
import { componentHost, RpcComponent, type RpcComponentData, type RpcComponentSnapshot } from './Component.js'
import { markMethodsOn, type RpcMethodOptions } from './Expose.js'
import { RpcPauseGate } from './PauseGate.js'
import { argumentsRefusal } from './Value.js'

/**
 * Running one instance's logic on a thread of its own, so that stopping it stops only it.
 *
 * The feasibility note measured a pause gate and found the gate was never the expensive part: what
 * exact pause actually costs is that a component's logic has to be somewhere the transport is not.
 * `Atomics.wait` parks a thread outright, and a component that shares a thread with the socket that
 * carries its calls cannot be parked without parking the socket - so a node that wants to stop one
 * component mid-handler needs that component's logic off the transport's thread. This is that.
 *
 * **The seam is `handler(...params)` and nothing else.** Everything the server does before it -
 * deadline, authority, ownership fence, idempotency, injection - is policy about a *call*, and calls
 * arrive on the transport's thread and are answered there. Only the body of the method is
 * component logic. So a worker-hosted instance is exposed exactly like any other: `callable()`
 * returns an object whose methods forward, `exposeClassInstance` takes it, and not one line of the
 * dispatch path knows the difference. A change that had reached into that path would have put the
 * whole policy stack behind a message boundary in order to move one function call.
 *
 * ## What it costs, stated rather than discovered
 *
 * **Arguments and results are checked against `RpcValue` before they cross.** Not against what a
 * worker happens to accept: against what *every* placement accepts, so that moving a component onto
 * a thread does not widen what may be said to it and moving it onto another host does not narrow it
 * again. A class instance is the case that motivated the check - structured clone would carry it and
 * drop its prototype, and nothing would throw.
 *
 * **An exception crosses as its message, its name and its code.** A thrown class instance is not the
 * same object on the other side, so what is preserved is what a caller acts on - and `RpcError`'s
 * code is part of that, because a caller deciding whether to retry reads the code.
 *
 * **One instance per worker.** A parked thread freezes everything on it, so two components sharing a
 * worker cannot be paused independently - which would make `componentId` on a pause state a lie.
 * The bound is here rather than in a comment somewhere.
 */

/** What the worker was told to do with a call, and what came back. Internal to this file's protocol. */
interface WorkerCall {
    readonly id: number
    readonly method: string
    readonly params: readonly unknown[]
}

interface WorkerReply {
    readonly id: number
    readonly result?: unknown
    readonly failure?: { readonly message: string; readonly name: string; readonly code?: string }
}

/** What a worker-hosted component sends back besides answers: its state, and what it announced. */
interface WorkerPublication {
    readonly snapshot?: RpcComponentSnapshot<RpcComponentData, RpcComponentData>
    readonly event?: { readonly name: string; readonly args: readonly unknown[] }
}

export interface RpcWorkerHostOptions {
    /**
     * The module that runs the instance, as a path or URL. It calls `serveInWorker` with the
     * instance it wants hosted - so what runs on that thread is the component's own code, started
     * by the component's own module, rather than something reconstructed here from a description.
     */
    readonly module: string | URL
    /** Passed to the module as `workerData.value`, for a component that needs constructing with something. */
    readonly data?: unknown
    /**
     * How long a call may wait for the worker before the host gives up on it.
     *
     * Distinct from the caller's own deadline, which the server already enforces: this is the
     * host's protection against a worker that has stopped answering entirely, and it must be longer
     * than any pause the deployment intends to take - a paused component is not a hung one, and
     * timing out its calls because somebody is looking at it would be the debugger causing the
     * failure it was brought in to investigate.
     */
    readonly callTimeoutMs?: number
}

const DEFAULT_CALL_TIMEOUT_MS = 600_000

/** Refused because something cannot cross a thread boundary, or because the worker will not answer. */
export class RpcWorkerRefused extends Error {
    constructor(
        message: string,
        readonly detail?: string
    ) {
        super(message)
        this.name = 'RpcWorkerRefused'
    }
}

/**
 * One instance, hosted on its own thread, with a gate the supervisor can park it at.
 *
 * The host is created on the transport's thread and never blocks: `pause` asks and `untilPaused`
 * waits asynchronously, because the whole point is that the thing doing the stopping stays able to
 * undo it.
 */
export class RpcWorkerHost {
    private readonly worker: Worker
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (failure: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
    private readonly callTimeoutMs: number
    private ready: Promise<{ readonly methods: readonly string[]; readonly declarations: { readonly [method: string]: RpcMethodOptions }; readonly probeIds: readonly string[] }>
    private next = 1
    private closed = false

    /** The gate this instance parks at. Shared with the worker, and read by both without messages. */
    readonly gate = RpcPauseGate.create()

    /** The probe registry the worker declared, in plan order. Empty for a build with no probes. */
    private probeIds: readonly string[] = []
    /** The last snapshot the worker published. What the facade serves, including while it is parked. */
    private latest?: RpcComponentSnapshot<RpcComponentData, RpcComponentData>
    private applySnapshot?: (snapshot: RpcComponentSnapshot<RpcComponentData, RpcComponentData>) => void
    private applyEvent?: (name: string, args: readonly unknown[]) => void

    /**
     * This probe's index, or `undefined` when this build does not carry it.
     *
     * The honest half of *run to cursor*: a probe the artifact does not have is a cursor nothing can
     * run to, and saying so is better than running to whatever happens to match.
     */
    indexOfProbe(probeId: string): number | undefined {
        const index = this.probeIds.indexOf(probeId)
        return index < 0 ? undefined : index
    }

    constructor(private readonly options: RpcWorkerHostOptions) {
        this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
        this.worker = new Worker(options.module, { workerData: { gate: this.gate.buffer, value: options.data } })
        this.ready = new Promise((resolve, reject) => {
            const started = (message: unknown) => {
                const announced = message as { ready?: readonly string[]; declarations?: { [method: string]: RpcMethodOptions }; probeIds?: readonly string[] }
                if (!announced?.ready) return
                this.worker.off('message', started)
                this.probeIds = announced.probeIds ?? []
                // Both sides hold the same list, so an index means the same thing to each.
                this.gate.knowProbes(this.probeIds)
                resolve({ methods: announced.ready, declarations: announced.declarations ?? {}, probeIds: this.probeIds })
            }
            this.worker.on('message', started)
            this.worker.once('error', reject)
        })
        this.worker.on('message', (message: WorkerReply) => this.answered(message))
        // A worker that dies takes every call waiting on it with it, told as a failure rather than
        // left to a timeout: the caller learns now, and learns why, instead of in ten minutes.
        this.worker.on('error', (failure: Error) => this.abandonAll(`the worker hosting this instance failed: ${failure.message}`))
        this.worker.on('exit', (code: number) => this.abandonAll(`the worker hosting this instance exited with code ${code}`))
    }

    private published(message: WorkerPublication): boolean {
        if (message?.snapshot) {
            this.latest = message.snapshot
            this.applySnapshot?.(message.snapshot)
            return true
        }
        if (message?.event) {
            this.applyEvent?.(message.event.name, message.event.args)
            return true
        }
        return false
    }

    private answered(message: WorkerReply): void {
        if (this.published(message as WorkerPublication)) return
        if (typeof message?.id !== 'number') return
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        clearTimeout(waiting.timer)
        if (message.failure) {
            const failure = new Error(message.failure.message)
            failure.name = message.failure.name
            if (message.failure.code) (failure as { code?: string }).code = message.failure.code
            waiting.reject(failure)
        } else waiting.resolve(message.result)
    }

    private abandonAll(why: string): void {
        if (this.closed) return
        this.closed = true
        for (const [, waiting] of this.pending) {
            clearTimeout(waiting.timer)
            waiting.reject(new RpcWorkerRefused(why))
        }
        this.pending.clear()
    }

    /** The method names the worker is serving, once it has said so. */
    async methods(): Promise<readonly string[]> {
        return (await this.ready).methods
    }

    /**
     * An object whose methods run on the worker's thread.
     *
     * Handed to `exposeClassInstance` like any other instance. The names come from the worker rather
     * than from a list here, so what is exposed is what the hosted instance actually serves - a list
     * written on this side would drift the first time somebody added a method.
     */
    async callable<T extends object>(): Promise<T> {
        const { methods, declarations } = await this.ready
        // Built on a **prototype**, not as own properties, because that is where every consumer
        // looks: `exposeClassInstance` walks `instance.constructor.prototype`, and an object whose
        // methods are its own properties is invisible to it. A forwarder has to present itself the
        // way the thing it stands in for would.
        const hosted = function RpcWorkerHosted() {} as unknown as { new (): T; prototype: Record<string, unknown> }
        for (const method of methods) hosted.prototype[method] = (...params: unknown[]) => this.call(method, params)
        hosted.prototype.constructor = hosted
        // And the declarations the hosted class made, re-applied here: a change of hosting must not
        // be what turns a declared command into an undeclared one.
        markMethodsOn(hosted, declarations)
        return Object.create(hosted.prototype) as T
    }

    /** Call one method on the worker's thread and wait for its answer. */
    call(method: string, params: readonly unknown[]): Promise<unknown> {
        if (this.closed) return Promise.reject(new RpcWorkerRefused('the worker hosting this instance is gone'))
        // Checked before it is sent rather than relying on `postMessage` to throw, which catches a
        // function and says nothing at all about a class instance - the case that arrives looking
        // right and having no methods.
        const refused = argumentsRefusal(method, params)
        if (refused) return Promise.reject(new RpcWorkerRefused(refused.why, refused.path))
        const id = this.next++
        const message: WorkerCall = { id, method, params }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new RpcWorkerRefused(`${method} did not answer within ${this.callTimeoutMs} ms`))
            }, this.callTimeoutMs)
            timer.unref?.()
            this.pending.set(id, { resolve, reject, timer })
            try {
                this.worker.postMessage(message)
            } catch (failure) {
                // A clone the check above did not predict. Kept as a backstop rather than removed:
                // the check knows the rules this library has written down, and the runtime knows
                // the ones it has not.
                this.pending.delete(id)
                clearTimeout(timer)
                reject(new RpcWorkerRefused(`${method} cannot be called on a worker-hosted instance: its arguments do not survive a thread boundary`, failure instanceof Error ? failure.message : String(failure)))
            }
        })
    }

    /**
     * Ask the hosted logic to park at its next gate. Returns immediately; it parks when it arrives.
     *
     * Not *now*, and the distinction is the honest one: there is no way to stop a thread between two
     * statements it has already begun. A handler that reaches no further gate does not park, which
     * is why `untilPaused` takes a deadline rather than waiting forever.
     */
    pause(): void {
        this.gate.request()
    }

    /** Let it go. The statement after the gate is next; nothing is re-executed. */
    resume(): void {
        this.gate.release()
    }

    get paused(): boolean {
        return this.gate.paused
    }

    untilPaused(timeoutMs: number): Promise<boolean> {
        return this.gate.untilPaused(timeoutMs)
    }

    /**
     * The component this worker hosts, as an `RpcComponent` the server can expose like any other.
     *
     * The facade the review of this seam asked for. `callable()` returns a forwarder, which is
     * enough for a class and not enough for a *component*: the server installs snapshot publication,
     * and accepts `sets` and `requiresAuthority`, only for a real `RpcComponent`. So this is one -
     * a component on this side whose values are the worker's, republished as they commit.
     *
     * **The division is the point.** The worker owns the logic and the private mutable state; this
     * side owns identity, security, authority and the last published snapshot. A consequence worth
     * having falls out of that: while the worker is **parked at a breakpoint**, this side still
     * answers, and a console still reads the last snapshot the component published - a debugger that
     * blanked every screen the moment it stopped a component would be one nobody left attached.
     *
     * Awaits the worker's first snapshot, because a facade has to start from what the component *is*
     * rather than from a shape supplied here, which would be a second answer to the same question.
     */
    async component<P extends RpcComponentData, S extends RpcComponentData>(): Promise<RpcComponent<P, S>> {
        const { methods, declarations } = await this.ready
        const first = await this.firstSnapshot()

        let apply!: (snapshot: RpcComponentSnapshot<RpcComponentData, RpcComponentData>) => void
        const hosted = class extends RpcComponent<P, S> {
            constructor() {
                super(first.props as P, first.state as S)
                // `replaceProps` is public and `replaceState` is protected, which is why this closure
                // is minted in here: applying the worker's values is the facade's own business and
                // nobody else's.
                apply = (snapshot) => {
                    componentHost(this).replaceProps(snapshot.props as P)
                    this.replaceState(snapshot.state as S)
                }
            }
        }
        // Skipping what a component already answers to: `props` and `state` are accessors on the
        // base, and the EventEmitter methods are how a subscriber reaches it. A forwarder named
        // after one of those would put a message round trip where a local read belongs - and the
        // worker's own state is republished here anyway, so there is nothing to forward *for*.
        const prototype = hosted.prototype as unknown as Record<string, unknown>
        for (const method of methods) if (!(method in hosted.prototype)) prototype[method] = (...params: unknown[]) => this.call(method, params)
        markMethodsOn(hosted, declarations)

        const facade = new hosted()
        let seen = first.revision
        this.applySnapshot = (snapshot) => {
            // In order, and never backwards. One port cannot reorder, so a lower revision means a
            // worker that restarted - which is a new activation rather than an older truth, and is
            // the deployment's to notice through the epoch rather than this facade's to smooth over.
            if (snapshot.epoch === first.epoch && snapshot.revision <= seen) return
            seen = snapshot.revision
            apply(snapshot)
        }
        this.applyEvent = (name, args) => void facade.emit(name, ...args)
        apply(first)
        return facade
    }

    /** The worker's first snapshot, which a component always sends before anything else. */
    private firstSnapshot(): Promise<RpcComponentSnapshot<RpcComponentData, RpcComponentData>> {
        if (this.latest) return Promise.resolve(this.latest)
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new RpcWorkerRefused('the worker published no component snapshot: serveComponentInWorker sends one before anything else, so this worker is serving a plain instance rather than a component')), this.callTimeoutMs)
            timer.unref?.()
            const waiting = setInterval(() => {
                if (!this.latest) return
                clearInterval(waiting)
                clearTimeout(timer)
                resolve(this.latest)
            }, 2)
            waiting.unref?.()
        })
    }

    /** Stop hosting. Every call still waiting is failed rather than left to a deadline. */
    async close(): Promise<void> {
        this.abandonAll('the worker hosting this instance was closed')
        // Released first: a worker parked at a gate cannot process a terminate message, and would
        // sit there until the runtime tore the thread down under it.
        this.gate.release()
        await this.worker.terminate()
    }
}
