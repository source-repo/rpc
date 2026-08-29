import { parentPort, workerData } from 'node:worker_threads'
import { RpcPauseGate } from '@source-repo/rpc'

/**
 * A stand-in for component logic running where it can be stopped.
 *
 * Deliberately shaped like an instrumented handler rather than like a loop: a function with several
 * statements, a gate between each of them, and a running record of what it actually executed. That
 * record is what proves the property the design's second acceptance criterion asks for - that a
 * resume continues the same stack rather than re-entering, so nothing before the gate runs twice.
 *
 * A test fixture, not part of the package's surface. What a real host would put in a worker is a
 * component; what this puts in one is the smallest thing that can demonstrate the mechanism.
 */

const { buffer, maxPauseMs } = workerData as { buffer: SharedArrayBuffer; maxPauseMs: number }
const gate = new RpcPauseGate(buffer)

/** Every statement this ran, in order, with what the gate did at each. Sent back on completion. */
const executed: string[] = []

const handler = (target: number) => {
    executed.push(`entry:${gate.arrive(maxPauseMs)}`)
    const clamped = target > 300 ? 300 : target
    executed.push(`clamped=${clamped}:${gate.arrive(maxPauseMs)}`)
    const doubled = clamped * 2
    executed.push(`doubled=${doubled}:${gate.arrive(maxPauseMs)}`)
    return doubled
}

parentPort?.on('message', (message: { readonly run?: number; readonly ping?: number }) => {
    // A message that arrives while the thread is parked is not seen until it resumes - which is the
    // design's "buffer bounded new inputs while paused" falling out of the mechanism rather than
    // being implemented on top of it. The queue is the worker's own, and it is not unbounded.
    if (message.ping !== undefined) return void parentPort?.postMessage({ pong: message.ping })
    if (message.run === undefined) return
    const answer = handler(message.run)
    parentPort?.postMessage({ answer, executed: [...executed] })
    executed.length = 0
})

parentPort?.postMessage({ ready: true })
