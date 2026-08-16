import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient } from '@source-repo/rpc'
import { SignalRClientTransport } from './SignalRClientTransport.js'

/**
 * The half that needs a hub, run against a real one.
 *
 * A SignalR server is ASP.NET Core, so unlike the MQTT suite - which starts a broker in Docker -
 * this needs a .NET SDK rather than a container. When there is none it does what that suite does
 * about a missing broker: skip, loudly, with an environment variable to turn the skip into a
 * failure so a run cannot report itself green having quietly asked nothing.
 *
 * Start the hub with `npm run hub` and point this at it:
 *
 * ```
 * SOURCE_RPC_TEST_SIGNALR_HUB=http://localhost:5217/rpc \
 * SOURCE_RPC_TEST_SIGNALR_PEER=vs-automation \
 * SOURCE_RPC_REQUIRE_SIGNALR=1 npm test --workspace=@source-repo/signalr
 * ```
 *
 * `csharp/testhost` is exactly that hub, and `npm run hub` builds and starts it.
 */

/**
 * Serial, every one of them, because they share a hub.
 *
 * ava runs the tests in a file concurrently, and these do not have a fixture each: there is one
 * process on the other end of the link with one `meter` in it, so a subscriber taken out by one
 * test receives the emissions of every other. Run concurrently they fail on each other's traffic,
 * which reads as a broken hub and is nothing of the kind.
 */
const HUB_URL = process.env.SOURCE_RPC_TEST_SIGNALR_HUB
const HUB_PEER = process.env.SOURCE_RPC_TEST_SIGNALR_PEER ?? 'vs-automation'
const run = randomUUID().slice(0, 8)

type Watchable = { on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>; off(event: string, handler: (...args: unknown[]) => void): Promise<unknown> }

const until = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('until timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

/**
 * A client on one of the two hub protocols. `useMsgPack` picks it: the transport reads `codec` and
 * chooses `MessagePackHubProtocol` or SignalR's JSON, and the hub serves both, so this is the only
 * thing that differs between a JSON peer and a MessagePack one.
 */
const clientOn = (name: string, useMsgPack: boolean) => {
    // The protocol is in the peer name because both passes run against one hub, and two clients
    // announcing the same name would displace each other rather than coexist.
    const peer = `${name}-${useMsgPack ? 'mp' : 'js'}-${run}`
    return new RpcClient(undefined, {
        name: peer,
        defaultTarget: HUB_PEER,
        useMsgPack,
        transport: new SignalRClientTransport(peer, HUB_URL!)
    })
}

const skipWithoutHub = (t: { pass: (message?: string) => void }) => {
    if (!HUB_URL) t.pass('SOURCE_RPC_TEST_SIGNALR_HUB is not set - skipped')
    return !HUB_URL
}

test.before(() => {
    // The same guard the broker suites use, and for the same reason: skipping is right on a laptop
    // with no .NET and wrong anywhere it matters.
    if (!HUB_URL && process.env.SOURCE_RPC_REQUIRE_SIGNALR)
        throw new Error('SOURCE_RPC_REQUIRE_SIGNALR is set, but SOURCE_RPC_TEST_SIGNALR_HUB names no hub - these tests must not be skipped here')
})

/**
 * Every one of these runs twice, once per hub protocol.
 *
 * The hub registers both and the client picks at negotiation, so the pair differs in exactly one
 * thing - and that one thing decides how the frame is serialized, which is the half of this binding
 * most likely to be subtly wrong. Running the JSON pass only would leave the MessagePack attributes
 * unexercised and the failure would surface on somebody's first day using it.
 */
for (const useMsgPack of [false, true]) {
    const protocol = useMsgPack ? 'msgpack' : 'json'

    test.serial(`a call reaches a C# hub and its answer comes back [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi', useMsgPack)
        await client.ready()
        const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')

        t.is(await meter.read('flow'), 'flow=42')

        await client.close()
    })

    test.serial(`a subscription taken on the C# hub delivers its events, stamped [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi3', useMsgPack)
        await client.ready()
        const meter = await client.proxy<Watchable & { pulse(reading: number): Promise<number> }>('meter')

        const seen: unknown[][] = []
        const stamps: (number | undefined)[] = []
        const handler = (...args: unknown[]) => {
            seen.push(args)
            stamps.push(client.rpcClient?.lastDeliveredStamp?.seq)
        }
        // An ordinary `on`, which the transport turns into a `subscribe` frame and the hub answers.
        t.is(await meter.on('tick', handler), 'ok')

        await meter.pulse(7)
        await until(() => seen.length > 0)
        t.deepEqual(seen[0], [7, 'bar'], 'the emit arguments arrived as the handler heard them')
        t.is(typeof stamps[0], 'number', 'and the emission was counted, so a watcher can claim it missed nothing')
        t.truthy(client.rpcClient?.lastDeliveredStamp?.epoch)

        // A repeat is one subscription, because a client replaying after a reconnect must not end up
        // served twice - and being told so is how it can tell the two cases apart.
        t.is(await meter.on('tick', handler), 'ok - already exists')

        await client.close()
    })

    test.serial(`an unsubscribe on the C# hub stops the events [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi4', useMsgPack)
        await client.ready()
        const meter = await client.proxy<Watchable & { pulse(reading: number): Promise<number> }>('meter')

        const seen: unknown[][] = []
        const handler = (...args: unknown[]) => seen.push(args)
        await meter.on('tick', handler)
        await meter.pulse(1)
        await until(() => seen.length === 1)

        t.is(await meter.off('tick', handler), 'ok')
        await meter.pulse(2)
        // No frame is coming, so there is nothing to wait for - only a window in which one could have
        // arrived, and the count afterwards.
        await new Promise((resolve) => setTimeout(resolve, 300))
        t.is(seen.length, 1, 'nothing arrives once the subscription is gone')

        // Refusing this would be strange: the caller is asking to stop receiving something it has
        // already stopped receiving.
        t.is(await meter.off('tick', handler), 'ok - was not subscribed')

        await client.close()
    })

    test.serial(`the count runs whether or not anyone is subscribed, which is what a cursor is for [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi5', useMsgPack)
        await client.ready()
        const meter = await client.proxy<Watchable & { pulse(reading: number): Promise<number> }>('meter')

        // pulse() answers with the sequence the emission was given, so the count is observable from
        // here without a cursor call. Two with nobody listening at all.
        const before = await meter.pulse(1)
        const next = await meter.pulse(2)
        t.is(next, before + 1, 'an emission nobody received still counted')

        const stamps: (number | undefined)[] = []
        await meter.on('tick', () => stamps.push(client.rpcClient?.lastDeliveredStamp?.seq))
        await meter.pulse(3)
        await until(() => stamps.length === 1)

        // The delivered stamp continues the count rather than starting at one, which is how a
        // subscriber that arrives late learns that it did.
        t.is(stamps[0], next + 1)

        await client.close()
    })

    test.serial(`an exception in a C# method reaches the caller as a rejection [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi2', useMsgPack)
        await client.ready()
        const meter = await client.proxy<{ nonesuch(): Promise<void> }>('meter')

        // The hub answers an unknown method with an error frame rather than silence, which is what
        // stops a caller inferring a mistake from ten seconds of nothing.
        const refused = await t.throwsAsync(meter.nonesuch())
        t.truthy(refused)

        await client.close()
    })

    test.serial(`an argument survives the journey out as well as the answer coming back [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi6', useMsgPack)
        await client.ready()
        const meter = await client.proxy<{ echo(text: string): Promise<string> }>('meter')

        // Non-ASCII on purpose: both protocols carry UTF-8, and a string that is only ever ASCII
        // would pass even if one of them were mangling the encoding.
        t.is(await meter.echo('Grüße, 制御 🎛'), 'Grüße, 制御 🎛')

        await client.close()
    })
}

/**
 * The difference the two protocols actually make to a caller.
 *
 * Everything above passes on both, which is the point - the protocol is meant to be invisible. This
 * is the one place it is not, and it is the reason MessagePack is worth configuring at all: bytes.
 */
test.serial('MessagePack carries bytes as bytes, where JSON base64s them into a string', async (t) => {
    if (skipWithoutHub(t)) return

    const overJson = clientOn('bin', false)
    await overJson.ready()
    const jsonAnswer = await (await overJson.proxy<{ trace(): Promise<unknown> }>('meter')).trace()
    await overJson.close()

    const overMsgPack = clientOn('bin', true)
    await overMsgPack.ready()
    const msgPackAnswer = await (await overMsgPack.proxy<{ trace(): Promise<unknown> }>('meter')).trace()
    await overMsgPack.close()

    // The same six bytes from the same C# method, twice.
    const expected = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]

    // Over MessagePack they arrive as bytes, so a caller indexes them and is done.
    t.true(msgPackAnswer instanceof Uint8Array, `expected bytes, got ${typeof msgPackAnswer}`)
    t.deepEqual([...(msgPackAnswer as Uint8Array)], expected)

    // Over JSON they arrive as base64 text, because JSON has no byte string and System.Text.Json
    // encodes a byte[] that way. Nothing is lost - but the caller has to know to decode it, which
    // is exactly the tax MessagePack removes.
    t.is(typeof jsonAnswer, 'string')
    t.deepEqual([...Buffer.from(jsonAnswer as string, 'base64')], expected)
})
