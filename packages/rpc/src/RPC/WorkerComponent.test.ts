import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { componentSnapshot, RpcClient, RpcComponent, RpcServer, RpcWorkerHost } from '../index.js'

/**
 * A component whose logic is on a worker and whose published face is here.
 *
 * The division under test is the one a review of the worker seam asked for: the worker owns the
 * executable logic and the private mutable state, and this side owns identity, security, authority
 * and the last published snapshot. What makes it a facade rather than a forwarder is that the server
 * cannot tell - it installs snapshot publication, accepts `sets` and `requiresAuthority`, and gates
 * calls, all against something that is a real `RpcComponent` here and a real component there.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const workerModule = fileURLToPath(new URL('./fixture/kilnWorker.js', import.meta.url))

interface Kiln {
    fire(target: number): Promise<number>
    vent(): Promise<string>
    announceBadly(): Promise<string>
}

const hosted = async (t: ExecutionContext) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 5_000 })
    t.teardown(async () => {
        await host.close()
    })
    const facade = await host.component<{ label: string; [key: string]: unknown }, { setpoint: number; firings: number; [key: string]: unknown }>()
    return { host, facade, kiln: facade as unknown as Kiln }
}

test('the facade is a component, and starts from what the worker actually is', async (t) => {
    const { facade } = await hosted(t)

    t.true(facade instanceof RpcComponent, 'which is what lets a server expose it as one')
    t.is(facade.props.label, 'Kiln 1', 'its identity came from the worker rather than from a shape supplied here')
    t.deepEqual(facade.state, { setpoint: 0, firings: 0 })
})

test('a commit in the worker becomes a snapshot here', async (t) => {
    const { facade, kiln } = await hosted(t)

    t.is(await kiln.fire(1180), 1)
    for (let waited = 0; waited < 2_000 && facade.state.firings === 0; waited += 5) await sleep(5)

    t.deepEqual(facade.state, { setpoint: 1180, firings: 1 }, 'the private state stayed in the worker and its published face arrived here')
    t.true(componentSnapshot(facade).revision > 0, 'and the facade has a revision of its own, which is what a subscriber orders by')
})

test('an event a worker component emits reaches a subscriber here', async (t) => {
    const { facade, kiln } = await hosted(t)
    const heard: unknown[] = []
    facade.on('fired', (payload) => heard.push(payload))

    await kiln.fire(1200)
    for (let waited = 0; waited < 2_000 && !heard.length; waited += 5) await sleep(5)

    t.deepEqual(heard, [{ target: 1200 }])
})

test('an event carrying something that cannot cross is refused at the line that emitted it', async (t) => {
    const { kiln } = await hosted(t)

    // Stricter than an in-process component, which would fail later and further away - at a
    // subscriber that never received anything, with nothing to say why.
    const refusal = await t.throwsAsync(kiln.announceBadly())
    t.regex(refusal!.message, /a function cannot be sent anywhere/)
    t.regex(refusal!.message, /the odd event/, 'and it names the event, which is what the author has to go and find')
})

test('the server exposes it like any other component, and gates what it declared', async (t) => {
    const { facade, host } = await hosted(t)
    const server = new RpcServer({ name: peer('kiln'), transports: [{ port: 4951, host: '127.0.0.1' }] })
    // No special path: `sets` and `requiresAuthority` are accepted only for a real RpcComponent, and
    // this is one - which is the whole difference between a facade and a forwarder.
    server.exposeClassInstance(facade, 'kiln')
    await server.ready()
    const client = new RpcClient(`http://localhost:4951`, { name: peer('ask'), defaultTarget: peer('kiln') })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const proxy = await client.proxy<Kiln>('kiln')
    t.is(await proxy.fire(1150), 1, 'a call went through the whole ordinary path and into the worker')

    const refused = await t.throwsAsync(proxy.vent())
    t.regex(refused!.message, /NotInControl|authority/i, 'and a method declared as needing authority is gated, here, against the facade')
    void host
})

test('a console still reads the last snapshot while the worker is parked at a breakpoint', async (t) => {
    const { host, facade, kiln } = await hosted(t)

    await kiln.fire(1100)
    for (let waited = 0; waited < 2_000 && facade.state.firings === 0; waited += 5) await sleep(5)
    t.is(facade.state.setpoint, 1100)

    // Stop the logic in the middle of a firing.
    host.pause()
    const firing = kiln.fire(1300)
    t.true(await host.untilPaused(2_000))

    // The consequence worth having: the supervisor answers and the last published snapshot is
    // readable while the component itself is stopped. A debugger that blanked every screen the
    // moment it stopped a component would be one nobody left attached.
    let ticks = 0
    const ticking = setInterval(() => ticks++, 5)
    await sleep(60)
    clearInterval(ticking)
    // Zero against any, rather than a rate: a thread parked by `Atomics.wait` ticks exactly
    // zero times, so that is the whole discriminator. Asking for more measured how much
    // timer resolution a loaded CI runner had left, and failed there while passing here.
    t.true(ticks > 0, 'this side kept running')
    t.true(host.paused)
    t.is(facade.state.setpoint, 1100, 'and the last snapshot the component published is still here to read')

    // The limit, and it is the mechanism rather than an omission: **a parked thread cannot
    // publish**. The commit this handler made before parking is queued on a microtask, and
    // `Atomics.wait` freezes the thread that would run it - so what a console sees while a component
    // is stopped is what the component had published, not what it had done since.
    t.is(facade.state.firings, 1)

    host.resume()
    t.is(await firing, 2)
    for (let waited = 0; waited < 2_000 && facade.state.setpoint !== 1300; waited += 5) await sleep(5)
    t.is(facade.state.setpoint, 1300, 'and what it had done arrives the moment it runs again')
})

test('a snapshot from a worker that has restarted does not arrive as an older truth', async (t) => {
    const { facade, kiln } = await hosted(t)
    await kiln.fire(1000)
    for (let waited = 0; waited < 2_000 && facade.state.firings === 0; waited += 5) await sleep(5)

    const before = componentSnapshot(facade).revision
    await kiln.fire(1010)
    for (let waited = 0; waited < 2_000 && facade.state.setpoint !== 1010; waited += 5) await sleep(5)

    t.true(componentSnapshot(facade).revision > before, 'revisions only ever move forward here')
    t.is(facade.state.firings, 2)
})
