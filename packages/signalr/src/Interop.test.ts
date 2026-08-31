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

/**
 * The hub is there *now*, not merely named - and it was there when the workflow started it.
 *
 * Those are different claims and the gap between them is minutes. CI builds the hub, waits for its
 * port, and then runs the whole workspace suite; this file is near the end of it, so by the time
 * these tests run the port check is four minutes stale. When the hub is gone by then, every test
 * below hangs in `ready()` until ava gives up, and the run reports `19 tests remained pending after
 * a timeout` - which names neither the hub nor the reason, and reads like a suite that is simply
 * slow. It cost a green run being read as a red one and a re-run to tell them apart.
 *
 * So the hub is reached once, here, and a failure says so in the words somebody debugging needs:
 * which hub, how many attempts, and what came back.
 *
 * Attempts rather than one, for the reason the MQTT suites already carry: a runner that has just
 * built five .NET projects and run eleven packages' tests is not a quiet machine, and a first probe
 * meeting a busy hub is not the same fact as a hub that is gone. Three of them over a few seconds
 * separates the two without waiting long enough to matter.
 */
const HUB_PROBES = 3
const PROBE_PAUSE_MS = 1000
/**
 * Each probe is bounded, and that is the part that makes this work at all.
 *
 * The transport retries its first connection on purpose - *"a peer may come up before its hub
 * does"* - so `ready()` against a hub that is gone does not fail, it keeps trying. An unbounded
 * probe therefore reproduces the exact failure it was written to replace: the hook hangs, ava times
 * out, and the report says nothing about a hub. Racing each attempt against a deadline is what turns
 * "it never came back" into an answer.
 */
const PROBE_DEADLINE_MS = 4000

const hubAnswers = async (): Promise<string | undefined> => {
    let last = 'no attempt was made'
    for (let attempt = 1; attempt <= HUB_PROBES; attempt++) {
        const client = clientOn(`probe${attempt}`, false)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const reached = (async () => {
                await client.ready()
                // Connected is not answering: a client reports itself ready once negotiation
                // succeeds, and a hub whose process is wedged can still complete one. So the probe
                // makes an actual call, which is what every test below depends on.
                const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')
                await meter.read('temp')
            })()
            await Promise.race([
                reached,
                new Promise((_, fail) => {
                    timer = setTimeout(() => fail(new Error(`no answer within ${PROBE_DEADLINE_MS} ms`)), PROBE_DEADLINE_MS)
                })
            ])
            return undefined
        } catch (e) {
            last = (e as { message?: string }).message ?? String(e)
        } finally {
            if (timer) clearTimeout(timer)
            await client.close().catch(() => undefined)
        }
        if (attempt < HUB_PROBES) await new Promise((wait) => setTimeout(wait, PROBE_PAUSE_MS))
    }
    return last
}

test.before(async () => {
    // The same guard the broker suites use, and for the same reason: skipping is right on a laptop
    // with no .NET and wrong anywhere it matters.
    if (!HUB_URL) {
        if (process.env.SOURCE_RPC_REQUIRE_SIGNALR)
            throw new Error('SOURCE_RPC_REQUIRE_SIGNALR is set, but SOURCE_RPC_TEST_SIGNALR_HUB names no hub - these tests must not be skipped here')
        return
    }
    const refused = await hubAnswers()
    if (refused)
        throw new Error(
            `the SignalR hub at ${HUB_URL} did not answer after ${HUB_PROBES} attempts: ${refused}. ` +
                'It was reachable when the workflow started it, so it has gone or stopped answering since - check signalr-hub.err rather than these tests.'
        )
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

    test.serial(`a deferred C# method answers twice, and the ticket carries the answer [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi7', useMsgPack)
        await client.ready()
        const meter = await client.proxy<{ slow(tag: string): Promise<{ id: string; expiresAt: number }> }>('meter')

        // The call answers at once with a receipt rather than the answer - `deferred: true` on the
        // wire - and the TypeScript client turns that into a ticket the caller waits on.
        const ticket = (await meter.slow('the-job')) as unknown as { id: string; expiresAt: number; result: Promise<string>; on(e: string, h: (v: unknown) => void): unknown }
        t.is(typeof ticket.id, 'string', 'the receipt names the call it belongs to')
        t.true(ticket.expiresAt > Date.now(), 'and says how long an answer is still expected')

        t.is(await ticket.result, 'finished the-job', 'and the answer arrives on the ticket')

        await client.close()
    })

    test.serial(`an owner fence is enforced by the C# hub [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi8', useMsgPack)
        await client.ready()
        type Fenceable = { read(tag: string): Promise<string>; $with(o: { ownerEpoch: string }): { read(tag: string): Promise<string> } }
        const meter = await client.proxy<Fenceable>('meter')

        // The generation the hub records is the one that rules, so this goes through.
        t.is(await meter.$with({ ownerEpoch: 'e-owner' }).read('flow'), 'flow=42')

        // A caller fencing on a generation that is no longer current is refused rather than run.
        // Losing the fence would not weaken this check, it would remove it - and the caller could
        // not tell the difference from a command that succeeded.
        const stale = await t.throwsAsync(meter.$with({ ownerEpoch: 'e-stale' }).read('flow'))
        t.regex(String(stale?.message), /OwnershipChanged|owner generation/)

        await client.close()
    })

    test.serial(`an idempotency key is answered from the record rather than run again [${protocol}]`, async (t) => {
        if (skipWithoutHub(t)) return
        const client = clientOn('hmi9', useMsgPack)
        await client.ready()
        type Counted = { count(): Promise<number>; $with(o: { idempotencyKey: string }): { count(): Promise<number> } }
        const meter = await client.proxy<Counted>('meter')

        // `count` increments only when it actually runs, so the same answer twice is the record
        // answering rather than the method running a second time.
        const key = `once-${protocol}-${run}`
        const first = await meter.$with({ idempotencyKey: key }).count()
        const again = await meter.$with({ idempotencyKey: key }).count()
        t.is(again, first, 'the retry was answered from the record')

        // A different key is a different command, and does run.
        const other = await meter.$with({ idempotencyKey: `${key}-other` }).count()
        t.is(other, first + 1, 'and a command that is not a repeat still runs')

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
