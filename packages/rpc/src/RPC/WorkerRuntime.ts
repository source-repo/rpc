import { parentPort, workerData } from 'node:worker_threads'
import { declaredAuthority, declaredConflation, declaredEffect, declaredSemantics, declaredSets, markedMethods, type RpcMethodOptions } from './Expose.js'
import { RpcPauseGate, type RpcFrameEvent, type RpcGateOutcome } from './PauseGate.js'

/**
 * The other side of a worker-hosted instance: what runs where the logic is.
 *
 * A module hands `serveInWorker` an instance and stops thinking about threads. What it gets in
 * return is the two things that only exist on this side - **the queue** the instance's calls run on,
 * and **the gate** they can be parked at - and both are here rather than on the host's thread
 * because both are properties of the thread the code actually runs on.
 *
 * ```ts
 * // oven.worker.ts
 * import { serveInWorker } from '@source-repo/rpc'
 * serveInWorker(new Oven())
 * ```
 *
 * **Serial by default**, matching what a component gets from the server: one call at a time, in
 * arrival order. A worker that ran calls concurrently would be a component whose state two handlers
 * could interleave on, and it would be so only because it had been moved to a thread - a change of
 * hosting is not a change of execution semantics.
 */

/** What a hosted instance can reach: the gate it parks at, and what a pause did when it arrived. */
export interface RpcWorkerContext {
    /**
     * Arrive at a gate. Runs through when nobody has asked for a pause, parks when somebody has.
     *
     * Called from wherever the instance wants to be stoppable. Between calls it is automatic - the
     * runtime gates before every method - and *inside* a handler it is what an instrumented build's
     * probes call, which is how an exact breakpoint stops on a line rather than between calls.
     */
    gate(maxPauseMs?: number): RpcGateOutcome
    /**
     * Arrive at a gate that is part of a frame: an entry, an exit, or a statement inside one.
     *
     * What makes stepping possible, and it is only bookkeeping: the entries and exits maintain a
     * depth, and a step is a predicate over that depth. `probeId` is matched against the registry
     * this worker declared, so *run to cursor* lands on the probe it named rather than on one whose
     * name happened to hash the same way.
     */
    at(frame: RpcFrameEvent, probeId?: string, maxPauseMs?: number): RpcGateOutcome
    /** Whether a pause has been asked for and not yet reached. For a handler that wants to hurry to one. */
    readonly pauseRequested: boolean
    /** The logical frame depth right now, for a handler that wants to report where it is. */
    readonly depth: number
}

export interface RpcServeInWorkerOptions {
    /**
     * How long a park may last before the thread lets itself go.
     *
     * Enforced by the parked thread rather than by the supervisor, because the case that matters is
     * the supervisor being gone: a debugger that disconnected must not leave a plant stopped, and
     * nothing on the other side of a dead connection can apply a policy.
     */
    readonly maxPauseMs?: number
    /** What the instance may reach, if it wants the gate. Filled in by the runtime. */
    readonly context?: (context: RpcWorkerContext) => void
    /**
     * Every probe id this build carries, in the order the plan lists them.
     *
     * The registry that makes *run to cursor* exact. A step command reaches a **parked** thread, so
     * it travels through shared memory and shared memory holds integers - which means the two sides
     * need an agreed integer for each probe, and an agreed list is the only way to have one that
     * cannot collide. A build with no probes needs none of this.
     */
    readonly probeIds?: readonly string[]
}

const DEFAULT_MAX_PAUSE_MS = 60_000

/**
 * Every method the instance serves, by the same rule the server's own exposure uses.
 *
 * **Marked methods are an allow-list**, exactly as they are in `exposeClassInstance`: a class that
 * marks any `@rpc` method serves those and no others. Without that rule a worker-hosted instance
 * would forward more than the same class hosted in-process - TypeScript's `private` is a
 * compile-time word and a private helper is an ordinary function on the prototype - and a change of
 * hosting would have widened a component's surface. That is the same failure as losing a
 * declaration at the boundary, arrived at from the other direction.
 */
const methodsOf = (instance: object): readonly string[] => {
    const allowed = markedMethods(instance)
    const found = new Set<string>()
    for (let held = instance; held && held !== Object.prototype; held = Object.getPrototypeOf(held) as object)
        for (const name of Object.getOwnPropertyNames(held))
            if (name !== 'constructor' && typeof (instance as Record<string, unknown>)[name] === 'function' && (!allowed || allowed.has(name))) found.add(name)
    return [...found]
}

/** What the class declared about each of its methods, in the shape the host re-applies. */
const declarationsOf = (instance: object): { [method: string]: RpcMethodOptions } => {
    const semantics = declaredSemantics(instance)
    const effects = declaredEffect(instance)
    const sets = declaredSets(instance)
    const conflation = declaredConflation(instance)
    const authority = declaredAuthority(instance)
    const marked = markedMethods(instance)
    const declarations: { [method: string]: RpcMethodOptions } = {}
    for (const method of marked ?? new Set<string>()) {
        declarations[method] = {
            ...(semantics.get(method) ? { semantics: semantics.get(method) } : {}),
            ...(effects.get(method) ? { effect: effects.get(method) } : {}),
            ...(sets.get(method) ? { sets: sets.get(method) } : {}),
            ...(conflation.has(method) ? { conflate: true } : {}),
            ...(authority.has(method) ? { requiresAuthority: true } : {})
        }
    }
    return declarations
}

/**
 * Serve one instance on this worker's thread.
 *
 * The instance is the module's own, constructed by the module: what runs on this thread is the
 * component's code started by the component's own file, rather than something rebuilt here from a
 * description of it. That is what keeps a worker-hosted component an ordinary component.
 */
export const serveInWorker = (instance: object, options: RpcServeInWorkerOptions = {}): void => {
    const port = parentPort
    if (!port) throw new Error('serveInWorker runs on a worker thread, and this is not one')
    const { gate: buffer } = (workerData ?? {}) as { gate?: SharedArrayBuffer }
    const gate = buffer ? new RpcPauseGate(buffer) : undefined
    const maxPauseMs = options.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS

    const probeIds = options.probeIds ?? []
    const indexOf = new Map(probeIds.map((probeId, index) => [probeId, index]))
    gate?.knowProbes(probeIds)

    const context: RpcWorkerContext = {
        gate: (ms = maxPauseMs) => gate?.arrive(ms) ?? 'ran-through',
        at: (frame, probeId, ms = maxPauseMs) =>
            gate?.arrive(ms, { frame, ...(probeId !== undefined && indexOf.has(probeId) ? { probe: indexOf.get(probeId)! } : {}) }) ?? 'ran-through',
        get pauseRequested() {
            return gate?.requested ?? false
        },
        get depth() {
            return gate?.depth ?? 0
        }
    }
    options.context?.(context)

    // One at a time, in arrival order: the same promise-chain the server uses for a serial instance,
    // because moving a component to a thread must not change what two overlapping calls do to it.
    let queue: Promise<void> = Promise.resolve()

    port.on('message', (message: { id: number; method: string; params: readonly unknown[] }) => {
        if (typeof message?.id !== 'number') return
        queue = queue.then(async () => {
            try {
                const handler = (instance as Record<string, unknown>)[message.method]
                if (typeof handler !== 'function') throw new Error(`${message.method} is not a method this instance serves`)
                // The gate before the call, which is a safe boundary: whatever ran last has finished
                // and this has not started. An instrumented build gates again inside the handler,
                // and that is the difference between stopping between calls and stopping on a line.
                context.gate(maxPauseMs)
                const result = await (handler as (...params: unknown[]) => unknown).call(instance, ...message.params)
                try {
                    port.postMessage({ id: message.id, result })
                } catch {
                    // The handler ran and its answer cannot be copied. Reported as that, rather than
                    // as whatever the clone error happened to say: what the caller needs to know is
                    // that the method is unusable across a thread, not how the structured clone
                    // algorithm phrases its disappointment.
                    port.postMessage({ id: message.id, failure: { message: `${message.method} answered with something that does not survive a thread boundary`, name: 'RpcWorkerRefused' } })
                }
            } catch (failure) {
                // Sent as message, name and code rather than as the thrown value: a class instance is
                // not the same object across a thread boundary, and what a caller acts on is the code.
                const held = failure as { message?: string; name?: string; code?: string }
                try {
                    port.postMessage({ id: message.id, failure: { message: held?.message ?? String(failure), name: held?.name ?? 'Error', ...(held?.code ? { code: held.code } : {}) } })
                } catch {
                    port.postMessage({ id: message.id, failure: { message: `${message.method} answered with something that does not survive a thread boundary`, name: 'RpcWorkerRefused' } })
                }
            }
        })
    })

    // The declarations travel with the names. A class's `@rpc` marks live on the thread where the
    // class is, and the forwarding object on the host's side was built at runtime and never saw a
    // decorator - so without this a non-repeatable command would be exposed as an undeclared method
    // and lose its idempotency protection by having been moved to a thread.
    port.postMessage({ ready: methodsOf(instance), declarations: declarationsOf(instance), probeIds })
}
