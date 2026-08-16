import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient } from '@source-repo/rpc'
import { SignalRClientTransport } from './SignalRClientTransport.js'

/**
 * The half that needs a hub.
 *
 * A SignalR server is ASP.NET Core, so unlike the MQTT suite - which starts a broker in Docker -
 * this cannot bring its own. What it does instead is the same thing that suite does about a missing
 * broker: skip, loudly, and let an environment variable turn the skip into a failure so a run
 * cannot report itself green having quietly asked nothing.
 *
 * To run it, start a hub built from `csharp/` and point this at it:
 *
 * ```
 * SOURCE_RPC_TEST_SIGNALR_HUB=http://localhost:5217/rpc \
 * SOURCE_RPC_TEST_SIGNALR_PEER=vs-automation \
 * SOURCE_RPC_REQUIRE_SIGNALR=1 npm test --workspace=@source-repo/signalr
 * ```
 *
 * The hub needs one instance exposed under the name `meter` with a `read(tag)` method returning
 * `"<tag>=42"`, which is what the assertions below expect - the smallest surface that proves a call
 * went out, was understood, ran, and came back.
 */

const HUB_URL = process.env.SOURCE_RPC_TEST_SIGNALR_HUB
const HUB_PEER = process.env.SOURCE_RPC_TEST_SIGNALR_PEER ?? 'vs-automation'
const run = randomUUID().slice(0, 8)

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

test('a call reaches a C# hub and its answer comes back', async (t) => {
    if (skipWithoutHub(t)) return
    const client = new RpcClient(undefined, {
        name: `hmi-${run}`,
        defaultTarget: HUB_PEER,
        // The reference hub in csharp/ is annotated for System.Text.Json, so the JSON hub protocol
        // is what it speaks. MsgPack works too and is smaller; it is the second thing to get right.
        useMsgPack: false,
        transport: new SignalRClientTransport(`hmi-${run}`, HUB_URL!)
    })
    await client.ready()
    const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')

    t.is(await meter.read('flow'), 'flow=42')

    await client.close()
})

test('an exception in a C# method reaches the caller as a rejection', async (t) => {
    if (skipWithoutHub(t)) return
    const client = new RpcClient(undefined, {
        name: `hmi2-${run}`,
        defaultTarget: HUB_PEER,
        useMsgPack: false,
        transport: new SignalRClientTransport(`hmi2-${run}`, HUB_URL!)
    })
    await client.ready()
    const meter = await client.proxy<{ nonesuch(): Promise<void> }>('meter')

    // The hub answers an unknown method with an error frame rather than silence, which is what
    // stops a caller inferring a mistake from ten seconds of nothing.
    const refused = await t.throwsAsync(meter.nonesuch())
    t.truthy(refused)

    await client.close()
})
