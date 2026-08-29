import { Worker } from 'node:worker_threads'
import { markMethodsOn, type RpcMethodOptions } from './Expose.js'
import { RpcPauseGate } from './PauseGate.js'

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
 * **Arguments and results cross by structured clone.** A class instance arrives as a plain object, a
 * function does not arrive at all, and both are refused here with the argument named rather than
 * silently flattened. That is the price of the thread boundary and it is not negotiable: a handler
 * whose arguments cannot be copied cannot run somewhere else.
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
    private ready: Promise<{ readonly methods: readonly string[]; readonly declarations: { readonly [method: string]: RpcMethodOptions } }>
    private next = 1
    private closed = false

    /** The gate this instance parks at. Shared with the worker, and read by both without messages. */
    readonly gate = RpcPauseGate.create()

    constructor(private readonly options: RpcWorkerHostOptions) {
        this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
        this.worker = new Worker(options.module, { workerData: { gate: this.gate.buffer, value: options.data } })
        this.ready = new Promise((resolve, reject) => {
            const started = (message: unknown) => {
                const announced = message as { ready?: readonly string[]; declarations?: { [method: string]: RpcMethodOptions } }
                if (!announced?.ready) return
                this.worker.off('message', started)
                resolve({ methods: announced.ready, declarations: announced.declarations ?? {} })
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

    private answered(message: WorkerReply): void {
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
                // A structured clone that could not be made. Refused with the reason, because the
                // alternative is a caller waiting ten minutes for a message that never left.
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

    /** Stop hosting. Every call still waiting is failed rather than left to a deadline. */
    async close(): Promise<void> {
        this.abandonAll('the worker hosting this instance was closed')
        // Released first: a worker parked at a gate cannot process a terminate message, and would
        // sit there until the runtime tore the thread down under it.
        this.gate.release()
        await this.worker.terminate()
    }
}
