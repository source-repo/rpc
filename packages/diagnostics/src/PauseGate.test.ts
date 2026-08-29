import test, { type ExecutionContext } from 'ava'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { RpcPauseGate } from './index.js'

/**
 * Whether this runtime can actually stop a component and stay answering. Measured, not assumed.
 *
 * Every test here runs a real worker thread, because the claims are about threads: a promise-based
 * imitation would pass all of them and prove nothing. The two that matter most are that the
 * supervisor keeps working while the logic is parked, and that a resume continues the same stack -
 * the second being the property that separates an exact breakpoint from re-running a handler and
 * hoping it takes the same path.
 */

const workerPath = fileURLToPath(new URL('./fixture/pauseWorker.js', import.meta.url))

const started = async (t: ExecutionContext, gate: RpcPauseGate, maxPauseMs = 5_000) => {
    const worker = new Worker(workerPath, { workerData: { buffer: gate.buffer, maxPauseMs } })
    t.teardown(async () => {
        await worker.terminate()
    })
    const messages: Record<string, unknown>[] = []
    worker.on('message', (message: Record<string, unknown>) => messages.push(message))
    for (let waited = 0; waited < 4_000 && !messages.some((message) => message.ready); waited += 5) await sleep(5)
    t.true(
        messages.some((message) => message.ready),
        'the logic worker should come up'
    )
    return { worker, messages, answered: () => messages.find((message) => message.answer !== undefined) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('with no pause requested a gate costs a read and nothing stops', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate)

    stood.worker.postMessage({ run: 210 })
    for (let waited = 0; waited < 2_000 && !stood.answered(); waited += 5) await sleep(5)

    t.is(stood.answered()?.answer, 420)
    t.deepEqual(stood.answered()?.executed, ['entry:ran-through', 'clamped=210:ran-through', 'doubled=420:ran-through'])
})

test('a requested pause parks the logic thread, and the supervisor keeps answering', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate)

    gate.request()
    stood.worker.postMessage({ run: 210 })
    t.true(await gate.untilPaused(2_000), 'the worker should park at its first gate')

    // The supervisor's own thread is demonstrably alive while the logic is stopped: a timer fires,
    // promises resolve, work gets done. This is what `Atomics.waitAsync` buys and what
    // `Atomics.wait` on this side would have cost.
    let ticks = 0
    const ticking = setInterval(() => ticks++, 5)
    await sleep(60)
    clearInterval(ticking)

    t.true(ticks > 3, `the supervisor ran ${ticks} times while the component was stopped`)
    t.true(gate.paused, 'and the component is still stopped')
    t.falsy(stood.answered(), 'having produced no answer, because it is not running')

    gate.release()
    for (let waited = 0; waited < 2_000 && !stood.answered(); waited += 5) await sleep(5)
    t.is(stood.answered()?.answer, 420)
})

test('a resume continues the same stack: nothing before the gate runs twice', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate)

    gate.request()
    stood.worker.postMessage({ run: 400 })
    t.true(await gate.untilPaused(2_000))
    gate.release()
    t.true(await gate.untilRunning(2_000))

    for (let waited = 0; waited < 2_000 && !stood.answered(); waited += 5) await sleep(5)
    t.deepEqual(
        stood.answered()?.executed,
        ['entry:released', 'clamped=300:ran-through', 'doubled=600:ran-through'],
        'the handler was entered once, parked once, and carried on from where it stopped'
    )
    t.is(stood.answered()?.answer, 600, 'and the value it computed is the value it would have computed')
})

test('a parked thread sees nothing, and what arrived while it was parked arrives after', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate)

    gate.request()
    stood.worker.postMessage({ run: 210 })
    t.true(await gate.untilPaused(2_000))

    stood.worker.postMessage({ ping: 1 })
    await sleep(50)
    t.falsy(
        stood.messages.find((message) => message.pong !== undefined),
        'a parked thread does not read its queue: this is what "paused" means, and what buffering inputs while paused costs'
    )

    gate.release()
    for (let waited = 0; waited < 2_000 && !stood.messages.find((message) => message.pong !== undefined); waited += 5) await sleep(5)
    t.is(stood.messages.find((message) => message.pong !== undefined)?.pong, 1, 'and it is delivered once the thread runs again')
})

test('a pause nobody ends ends itself, so a lost controller cannot park a plant', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate, 80)

    gate.request()
    stood.worker.postMessage({ run: 210 })
    t.true(await gate.untilPaused(2_000))

    // The supervisor does nothing at all from here - which is the case that matters, because the
    // failure being guarded against is the supervisor being gone.
    for (let waited = 0; waited < 3_000 && !stood.answered(); waited += 5) await sleep(5)

    t.is(stood.answered()?.answer, 420, 'the component resumed on its own deadline')
    t.is((stood.answered()?.executed as string[])[0], 'entry:expired', 'and says it expired rather than that it was released')
})

test('a release that lands before the wait does not park anything, which is the race handled', async (t) => {
    const gate = RpcPauseGate.create()
    const stood = await started(t, gate)

    // Requested and released in the same breath, before the worker reaches its gate.
    gate.request()
    gate.release()
    stood.worker.postMessage({ run: 210 })
    for (let waited = 0; waited < 2_000 && !stood.answered(); waited += 5) await sleep(5)

    t.is(stood.answered()?.answer, 420)
    t.false(gate.paused)
})

test('the supervisor side never blocks, even waiting for a pause that never comes', async (t) => {
    const gate = RpcPauseGate.create()
    let ticks = 0
    const ticking = setInterval(() => ticks++, 5)

    const paused = await gate.untilPaused(60)
    clearInterval(ticking)

    t.false(paused, 'nothing parked, and the wait ended on its own deadline')
    t.true(ticks > 3, 'and this thread was running throughout')
})
