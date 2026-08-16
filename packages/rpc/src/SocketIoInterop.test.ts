import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { rpc, rpcNamespace, RpcServer } from './index.js'
import type { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'

/**
 * A TypeScript socket.io server and a C# peer that dials into it.
 *
 * The roles are the other way round from every other interop suite here, and that is the point: on
 * socket.io the .NET side can only be a client, because socket.io's server is a Node library with
 * no maintained .NET equivalent. So this is the pairing the C# binding exists for - an engineering
 * tool, a Visual Studio automation host, a console utility - joining a network that is already
 * running rather than standing one up.
 *
 * What is under test is not socket.io. It is that the *same* C# dispatcher, responder, ownership
 * and idempotency store that serve MQTT and SignalR serve this too, with one constructor changed,
 * and that every semantic still means what it meant: a fence still refuses, an idempotency key is
 * still answered from the record, a deferred method still answers twice.
 *
 * Needs the C# peer running against a server this suite starts:
 *
 * ```
 * RPC_PEER_NAME=csharp-socketio \
 *   dotnet run --project packages/csharp/TestHost -c Release -- socketio http://127.0.0.1:3970
 *
 * SOURCE_RPC_TEST_CSHARP_SOCKETIO=csharp-socketio npm test --workspace=@source-repo/rpc
 * ```
 *
 * Skips loudly without it, and `SOURCE_RPC_REQUIRE_CSHARP_SOCKETIO` turns the skip into a failure -
 * the same bargain the broker and SignalR suites make, for the same reason.
 */

const CSHARP_PEER = process.env.SOURCE_RPC_TEST_CSHARP_SOCKETIO
const PORT = Number(process.env.SOURCE_RPC_TEST_CSHARP_SOCKETIO_PORT ?? 3970)
const run = randomUUID().slice(0, 8)
const HOST = `ts-host-${run}`

interface Context {
    skipped: boolean
    server?: RpcServer
}
const test = anyTest as TestFn<Context>

/** Something on the TypeScript side for the C# peer to call, so both directions are under test. */
@rpcNamespace('echo')
class Echo {
    @rpc({ semantics: 'query' })
    async say(tag: string) {
        return `echo:${tag}`
    }
}

const until = async (condition: () => boolean, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('until timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

test.before(async (t) => {
    if (!CSHARP_PEER) {
        if (process.env.SOURCE_RPC_REQUIRE_CSHARP_SOCKETIO)
            throw new Error('SOURCE_RPC_REQUIRE_CSHARP_SOCKETIO is set, but no SOURCE_RPC_TEST_CSHARP_SOCKETIO peer is named - these tests must not be skipped here')
        t.context = { skipped: true }
        return
    }

    // The server the C# peer is already dialling, with one responder on it so the C# side has
    // something to call back: a client transport that can only answer is half a binding.
    const server = new RpcServer({ name: HOST, transports: [{ port: PORT, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Echo(), 'echo')
    await server.ready()

    // The C# peer retries on a backoff that reaches thirty seconds, and it is usually started
    // before this server exists - so the wait has to cover a whole backoff step rather than a
    // guess. Waiting too briefly here fails the suite for a peer that was about to arrive.
    const listener = server.transports[0] as unknown as SocketIoServerTransport
    try {
        await until(() => listener.reachablePeers().includes(CSHARP_PEER), 45_000)
    } catch {
        await server.close()
        throw new Error(`the C# peer '${CSHARP_PEER}' never announced itself on port ${PORT} - is it running?`)
    }
    t.context = { skipped: false, server }
})

test.after.always(async (t) => {
    await t.context?.server?.close()
})

const skipWithoutPeer = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass('no C# socket.io peer named - skipped')
    return t.context.skipped
}

test.serial('a TypeScript server calls a C# peer that dialled into it', async (t) => {
    if (skipWithoutPeer(t)) return
    const meter = await t.context.server!.proxy<{ read(tag: string): Promise<string> }>('meter', CSHARP_PEER)

    // One call, out through a link the C# side opened.
    t.is(await meter.read('flow'), 'flow=42')
})

test.serial('the C# peer calls back the other way, over the link it opened', async (t) => {
    if (skipWithoutPeer(t)) return
    const meter = await t.context.server!.proxy<{ relay(target: string, tag: string): Promise<string> }>('meter', CSHARP_PEER)

    // Two calls in opposite directions on one socket: this one out to the C# peer, and the C# peer's
    // own call back to this server, which is the direction an engineering tool actually wants. A
    // binding that only answers would pass every other test in this file.
    t.is(await meter.relay(HOST, 'ping'), 'echo:ping')
})

test.serial('an error from C# arrives with the code the caller acts on', async (t) => {
    if (skipWithoutPeer(t)) return
    const meter = await t.context.server!.proxy<{ refuse(): Promise<void>; nonesuch(): Promise<void> }>('meter', CSHARP_PEER)

    const refused = await t.throwsAsync(meter.refuse())
    t.regex(String(refused?.message), /does not take orders/)

    // And a method nobody exposed is named rather than met with silence.
    t.truthy(await t.throwsAsync(meter.nonesuch()))
})

test.serial('an owner fence is enforced over socket.io', async (t) => {
    if (skipWithoutPeer(t)) return
    type Fenceable = { $with(o: { ownerEpoch: string }): { read(tag: string): Promise<string> } }
    const meter = await t.context.server!.proxy<Fenceable>('meter', CSHARP_PEER)

    t.is(await meter.$with({ ownerEpoch: 'e-owner' }).read('flow'), 'flow=42', 'the generation the peer records is the one that rules')

    // The fence has to survive the whole journey for this to refuse. Losing it would not weaken the
    // check, it would remove it - and the caller could not tell that from success.
    const stale = await t.throwsAsync(meter.$with({ ownerEpoch: 'e-stale' }).read('flow'))
    t.regex(String(stale?.message), /OwnershipChanged|owner generation/)
})

test.serial('an idempotency key is answered from the C# record rather than run again', async (t) => {
    if (skipWithoutPeer(t)) return
    type Counted = { $with(o: { idempotencyKey: string }): { count(): Promise<number> } }
    const meter = await t.context.server!.proxy<Counted>('meter', CSHARP_PEER)

    const key = `socketio-once-${run}`
    const first = await meter.$with({ idempotencyKey: key }).count()
    const again = await meter.$with({ idempotencyKey: key }).count()
    t.is(again, first, 'the retry was answered from the record')
})

test.serial('a subscription over socket.io delivers C# events', async (t) => {
    if (skipWithoutPeer(t)) return
    const meter = await t.context.server!.proxy<{
        on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
        pulse(reading: number): Promise<number>
    }>('meter', CSHARP_PEER)

    const seen: unknown[][] = []
    t.is(await meter.on('tick', (...args) => seen.push(args)), 'ok')

    await meter.pulse(9)
    await until(() => seen.length > 0)
    t.deepEqual(seen[0], [9, 'bar'], 'the emit arguments arrived as the handler heard them')
})

test.serial('a deferred C# method answers twice over socket.io', async (t) => {
    if (skipWithoutPeer(t)) return
    const meter = await t.context.server!.proxy<{ slow(tag: string): Promise<{ id: string; result: Promise<string> }> }>('meter', CSHARP_PEER)

    // A receipt now and the answer later, on one correlation - the part of the protocol a transport
    // is most likely to get almost right, by releasing the caller on the receipt.
    const ticket = (await meter.slow('over-socketio')) as unknown as { id: string; result: Promise<string> }
    t.is(typeof ticket.id, 'string')
    t.is(await ticket.result, 'finished over-socketio')
})
