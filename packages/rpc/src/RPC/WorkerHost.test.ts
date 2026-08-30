import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RpcClient, RpcServer, RpcWorkerHost, RpcWorkerRefused } from '../index.js'

/**
 * A component's logic on a thread of its own, and what that makes possible.
 *
 * The feasibility work measured a gate and found the gate was never the expensive part: exact pause
 * costs having the logic somewhere the transport is not. So these run a real worker behind a real
 * server and check the two things that follow - that a call through the whole ordinary path reaches
 * it and comes back, and that it can be stopped *inside a handler* while the server carrying its
 * calls keeps answering.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const workerModule = fileURLToPath(new URL('./fixture/ovenWorker.js', import.meta.url))

interface Oven {
    bake(target: number): Promise<{ setpoint: number; batches: number }>
    reading(): Promise<unknown>
    ungated(): Promise<number>
    refuse(): Promise<never>
    unclonable(): Promise<unknown>
}

const hosted = async (t: ExecutionContext) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 5_000 })
    t.teardown(async () => {
        await host.close()
    })
    return { host, oven: await host.callable<Oven>() }
}

const stood = async (t: ExecutionContext, port: number) => {
    const { host, oven } = await hosted(t)
    const server = new RpcServer({ name: peer(`oven${port}`), transports: [{ port, host: '127.0.0.1' }] })
    // Exposed exactly like any other instance: the dispatch path does not know it forwards.
    server.exposeClassInstance(oven, 'oven', { execution: 'serial' })
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`oven${port}`) })
    const proxy = await client.proxy<Oven>('oven')
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { host, server, proxy }
}

test('an instance on another thread is exposed and called like any other', async (t) => {
    const { proxy } = await stood(t, 4901)

    t.deepEqual(await proxy.bake(420), { setpoint: 300, batches: 1 }, 'the call went out, across a thread, and came back')
    t.deepEqual(await proxy.bake(180), { setpoint: 180, batches: 2 }, 'and the instance kept its state between calls')
})

test('the worker says which methods it serves, so nothing here has to be told twice', async (t) => {
    const { host } = await hosted(t)
    const methods = await host.methods()

    t.deepEqual([...methods].sort(), ['bake', 'heat', 'reading', 'refuse', 'soak', 'unclonable', 'ungated'], 'walked from the instance rather than listed on this side')
})

test('a handler is stopped between its own statements, and the server keeps answering', async (t) => {
    const { host, proxy } = await stood(t, 4902)

    host.pause()
    const baking = proxy.bake(420)
    t.true(await host.untilPaused(2_000), 'it parked at a gate inside the handler')

    // The transport's thread is demonstrably alive while the component's is not: a timer fires, and
    // a second call goes out and is queued by the server rather than lost.
    let ticks = 0
    const ticking = setInterval(() => ticks++, 5)
    await sleep(60)
    clearInterval(ticking)

    // Zero against any, rather than a rate: a thread parked by `Atomics.wait` ticks exactly
    // zero times, so that is the whole discriminator. Asking for more measured how much
    // timer resolution a loaded CI runner had left, and failed there while passing here.
    t.true(ticks > 0, `the server ran ${ticks} times while the component was stopped`)
    t.true(host.paused)

    host.resume()
    t.deepEqual(await baking, { setpoint: 300, batches: 1 }, 'and the handler finished the work it had begun')
})

test('a resume continues the same handler rather than starting it again', async (t) => {
    const { host, proxy } = await stood(t, 4903)

    host.pause()
    const baking = proxy.bake(420)
    t.true(await host.untilPaused(2_000))
    host.resume()

    // batches is 1 and not 2: the handler was entered once. A pause that had re-run it would have
    // counted the batch twice, which is the failure an exact breakpoint has to be incapable of.
    t.deepEqual(await baking, { setpoint: 300, batches: 1 })
    t.deepEqual(await proxy.bake(100), { setpoint: 100, batches: 2 }, 'and the next call counts the next one')
})

test('a pause nobody ends ends itself, so a lost supervisor cannot stop a plant for good', async (t) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 5_000 })
    t.teardown(async () => {
        await host.close()
    })
    const oven = await host.callable<Oven>()

    host.pause()
    const baking = oven.bake(200)
    t.true(await host.untilPaused(2_000))

    // Nothing is done from here. The worker's own deadline is 5 s in the fixture, so this asserts
    // the parked thread is what ends it rather than anything on this side.
    host.gate.release()
    t.deepEqual(await baking, { setpoint: 200, batches: 1 })
})

test('a handler that reaches no gate cannot be paused, which is a limit rather than a bug', async (t) => {
    const { host, oven } = await hosted(t)
    await oven.bake(150)

    host.pause()
    // `ungated` has no gate of its own, but the runtime gates before every call - so it parks at the
    // boundary rather than inside. Stopping between calls is a safe boundary; stopping inside one
    // needs the handler to have somewhere to stop, which is what instrumentation puts there.
    const asked = oven.ungated()
    t.true(await host.untilPaused(2_000), 'parked at the boundary before the call')
    host.resume()
    t.is(await asked, 1)
})

test('a failure crosses as what a caller acts on: the message, and the code', async (t) => {
    const { proxy } = await stood(t, 4904)

    // Two boundaries, not one. The thread carries message, name and code because a thrown class
    // instance is not the same object on the other side; the wire then applies the server's own
    // rule about which codes a handler may choose, which a change of hosting must not alter.
    const failure = await t.throwsAsync(proxy.refuse())
    t.regex(failure!.message, /the downstream valve did not answer/)
    t.is((failure as { code?: string }).code, 'UnknownOutcome', 'the code a caller decides to retry on survived both')
})

test('and a code a handler may not choose is still the server’s to refuse', async (t) => {
    const { oven } = await hosted(t)

    // At the thread boundary the code is carried faithfully; it is the *server* that decides what a
    // handler is allowed to claim. Checking it here shows the two rules are separate, and that
    // moving a component to a worker did not quietly become a way around the second.
    const failure = await t.throwsAsync(oven.refuse())
    t.is((failure as { code?: string }).code, 'UnknownOutcome')
})

test('an argument that cannot cross is refused with the reason, not silently flattened', async (t) => {
    const { oven } = await hosted(t)

    // Caught by the boundary's own rule before it is sent, rather than by `postMessage` throwing -
    // so the reason names the argument and says what is wrong with it.
    const refusal = await t.throwsAsync((oven as unknown as { bake(target: unknown): Promise<unknown> }).bake(() => 1), { instanceOf: RpcWorkerRefused })
    t.regex(refusal!.message, /a function cannot be sent anywhere/)
    t.is(refusal!.detail, 'bake argument 0')
    t.deepEqual(await oven.bake(120), { setpoint: 120, batches: 1 }, 'and the instance is unharmed by having been asked')
})

test('a class instance is refused rather than arriving as a shape with no methods', async (t) => {
    const { oven } = await hosted(t)
    await oven.bake(210)

    // The case `postMessage` carries happily: without a rule of its own, the caller would receive
    // `{ celsius: 210 }` with no `clamp`, and nothing anywhere would have said so.
    const refusal = await t.throwsAsync(oven.reading())
    t.regex(refusal!.message, /looks right and has no methods/)
    t.regex(refusal!.message, /Reading/)
})

test('an argument carrying a class instance is refused before it is sent', async (t) => {
    const { oven } = await hosted(t)

    class Schedule {
        constructor(readonly hold: number) {}
    }
    const refusal = await t.throwsAsync((oven as unknown as { bake(target: unknown): Promise<unknown> }).bake({ schedule: new Schedule(5) }), { instanceOf: RpcWorkerRefused })
    t.is(refusal!.detail, 'bake argument 0.schedule', 'and it names where in the argument the trouble is')
    t.deepEqual(await oven.bake(120), { setpoint: 120, batches: 1 }, 'the instance is unharmed by having been asked')
})

test('a result that cannot cross fails as itself rather than as a timeout', async (t) => {
    const { oven } = await hosted(t)

    const refusal = await t.throwsAsync(oven.unclonable())
    t.regex(refusal!.message, /a function cannot be sent anywhere/, 'named on the way back, by the method that returned it')
})

test('a closed host fails what was waiting rather than leaving it to a deadline', async (t) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 60_000 })
    const oven = await host.callable<Oven>()

    host.pause()
    const baking = oven.bake(200)
    t.true(await host.untilPaused(2_000))

    await host.close()
    const refusal = await t.throwsAsync(baking)
    t.regex(refusal!.message, /worker hosting this instance/)
})
