import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync } from 'mqtt'
import { MqttTransport, RpcClient } from './index.js'

/**
 * A TypeScript peer and a C# peer on one broker.
 *
 * This is the pairing the MQTT binding exists for, and the only test that can prove it: the C# side
 * speaks the `mr-` property layout, which shares no bytes with the flat frame the connection
 * transports use, so agreement here is agreement about the *protocol* rather than about a shared
 * serializer. What both sides do share is the neutral frame - `RpcFrame` and `RPC/Frame.ts` - and
 * that is exactly the claim under test.
 *
 * Needs a broker and the C# peer running against it:
 *
 * ```
 * dotnet run --project packages/csharp/TestHost -c Release -- mqtt mqtt://127.0.0.1:1883 msgrpc/v2
 *
 * SOURCE_RPC_TEST_CSHARP_MQTT=csharp-mqtt npm test --workspace=@source-repo/rpc
 * ```
 *
 * Skips loudly without them, and `SOURCE_RPC_REQUIRE_CSHARP_MQTT` turns the skip into a failure -
 * the same bargain the broker and SignalR suites make, for the same reason.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
const CSHARP_PEER = process.env.SOURCE_RPC_TEST_CSHARP_MQTT
const PREFIX = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_PREFIX ?? 'msgrpc/v2'
const run = randomUUID().slice(0, 8)

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

test.before(async (t) => {
    const broker = await brokerAvailable()
    const skipped = !broker || !CSHARP_PEER
    if (skipped && process.env.SOURCE_RPC_REQUIRE_CSHARP_MQTT)
        throw new Error('SOURCE_RPC_REQUIRE_CSHARP_MQTT is set, but there is no broker or no SOURCE_RPC_TEST_CSHARP_MQTT peer named - these tests must not be skipped here')
    t.context = { skipped }
})

const skipWithoutPeer = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass('no broker or no C# peer named - skipped')
    return t.context.skipped
}

const clientFor = (name: string) =>
    new RpcClient(undefined, {
        name: `${name}-${run}`,
        defaultTarget: CSHARP_PEER!,
        transport: new MqttTransport(`${name}-${run}`, BROKER_URL, { prefix: PREFIX, sessionExpirySeconds: 10 })
    })

const until = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('until timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

test.serial('a TypeScript peer calls a C# peer over the broker', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-caller')
    await client.ready()
    const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')

    // One call, over a wire format neither side shares any code for.
    t.is(await meter.read('flow'), 'flow=42')

    await client.close()
})

test.serial('an error from C# arrives with the code the caller acts on', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-err')
    await client.ready()
    const meter = await client.proxy<{ refuse(): Promise<void>; nonesuch(): Promise<void> }>('meter')

    // Deliberate, so the message travels: it was written to be read.
    const refused = await t.throwsAsync(meter.refuse())
    t.regex(String(refused?.message), /does not take orders/)

    // And a method nobody exposed is named rather than met with silence.
    const missing = await t.throwsAsync(meter.nonesuch())
    t.truthy(missing)

    await client.close()
})

test.serial('an owner fence is enforced across the broker', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-fence')
    await client.ready()
    type Fenceable = { read(tag: string): Promise<string>; $with(o: { ownerEpoch: string }): { read(tag: string): Promise<string> } }
    const meter = await client.proxy<Fenceable>('meter')

    t.is(await meter.$with({ ownerEpoch: 'e-owner' }).read('flow'), 'flow=42', 'the generation the peer records is the one that rules')

    // `mr-fence` had to survive the whole journey for this to refuse. Losing it would not weaken
    // the check, it would remove it - and the caller could not tell that from success.
    const stale = await t.throwsAsync(meter.$with({ ownerEpoch: 'e-stale' }).read('flow'))
    t.regex(String(stale?.message), /OwnershipChanged|owner generation/)

    await client.close()
})

test.serial('an idempotency key is answered from the C# record rather than run again', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-idem')
    await client.ready()
    type Counted = { count(): Promise<number>; $with(o: { idempotencyKey: string }): { count(): Promise<number> } }
    const meter = await client.proxy<Counted>('meter')

    const key = `mqtt-once-${run}`
    const first = await meter.$with({ idempotencyKey: key }).count()
    const again = await meter.$with({ idempotencyKey: key }).count()
    t.is(again, first, 'the retry was answered from the record')

    await client.close()
})

test.serial('a subscription taken over the broker delivers C# events, stamped', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-watch')
    await client.ready()
    const meter = await client.proxy<{
        on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
        pulse(reading: number): Promise<number>
    }>('meter')

    const seen: unknown[][] = []
    const stamps: (number | undefined)[] = []
    t.is(
        await meter.on('tick', (...args) => {
            seen.push(args)
            stamps.push(client.rpcClient?.lastDeliveredStamp?.seq)
        }),
        'ok'
    )

    await meter.pulse(9)
    await until(() => seen.length > 0)
    t.deepEqual(seen[0], [9, 'bar'], 'the emit arguments arrived as the handler heard them')
    t.is(typeof stamps[0], 'number', 'and the emission was counted, so a watcher can claim it missed nothing')

    await client.close()
})

test.serial('a deferred C# method answers twice over the broker', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = clientFor('ts-defer')
    await client.ready()
    const meter = await client.proxy<{ slow(tag: string): Promise<{ id: string; result: Promise<string> }> }>('meter')

    // The receipt carries `mr-deferred`, and the answer is a `ticket` frame on the same correlation
    // - the two additions that made the MQTT layout able to express the whole protocol.
    const ticket = (await meter.slow('over-mqtt')) as unknown as { id: string; result: Promise<string> }
    t.is(typeof ticket.id, 'string')
    t.is(await ticket.result, 'finished over-mqtt')

    await client.close()
})
