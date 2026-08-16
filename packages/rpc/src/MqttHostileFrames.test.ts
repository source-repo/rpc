import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync, MqttClient } from 'mqtt'
import { MR } from './Transports/Mqtt5Frame.js'
import { createHmacSigner, createHmacVerifier, MqttTransport, RpcClient } from './index.js'

/**
 * What a peer does with frames from something that wishes it harm.
 *
 * Every other MQTT suite here sends well-formed frames and checks the answer. These send the frames
 * an attacker sends, and the thing being checked is that the peer is *still there afterwards* - a
 * broker gives anyone who can publish to a request topic a direct line to a deserializer, and no
 * signature stands between them unless the peer refuses to read the payload until it has one.
 *
 * Needs a broker and a signing C# peer, the same pair `MqttSignedInterop.test.ts` uses.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
const CSHARP_PEER = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_SIGNED
const PREFIX = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_PREFIX ?? 'msgrpc/v2'
const SECRET = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_SECRET ?? 'interop-secret'
const run = randomUUID().slice(0, 8)

interface Context {
    skipped: boolean
    mqtt?: MqttClient
    replies: Buffer[]
    replyTopic: string
}
const test = anyTest as TestFn<Context>

const me = `hostile-${run}`
const replyTopic = `${PREFIX}/rsp/${me}`

test.before(async (t) => {
    let mqtt: MqttClient | undefined
    try {
        mqtt = await connectAsync(BROKER_URL, { protocolVersion: 5, connectTimeout: 1500, reconnectPeriod: 0 })
    } catch {
        // No broker.
    }
    const skipped = !mqtt || !CSHARP_PEER
    if (skipped && process.env.SOURCE_RPC_REQUIRE_CSHARP_MQTT)
        throw new Error('SOURCE_RPC_REQUIRE_CSHARP_MQTT is set, but there is no broker or no signing C# peer - these tests must not be skipped here')

    const replies: Buffer[] = []
    if (mqtt) {
        mqtt.on('message', (_topic, payload) => replies.push(payload))
        await mqtt.subscribeAsync(replyTopic)
    }
    t.context = { skipped, mqtt, replies, replyTopic }
})

test.after.always(async (t) => {
    await t.context?.mqtt?.endAsync()
})

const skipWithoutPeer = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass('no broker or no signing C# peer named - skipped')
    return t.context.skipped
}

/** A frame with no signature at all, which is as far as an attacker with no key gets. */
const publish = async (t: { context: Context }, payload: Buffer, properties: Record<string, string> = {}) => {
    await t.context.mqtt!.publishAsync(`${PREFIX}/req/${CSHARP_PEER}`, payload, {
        properties: {
            responseTopic: t.context.replyTopic,
            correlationData: Buffer.from(randomUUID()),
            contentType: 'application/msgpack',
            userProperties: {
                [MR.version]: '3',
                [MR.source]: me,
                [MR.kind]: 'call',
                [MR.path]: 'meter',
                [MR.method]: 'read',
                ...properties
            }
        }
    })
}

/**
 * The peer is still answering.
 *
 * This is the assertion the whole file is built around, and it is deliberately made through a
 * *different* peer: a StackOverflowException cannot be caught, so a peer that died from one is not
 * a peer that returns an error - it is a process that is gone, and only something outside it can
 * notice.
 */
const stillAlive = async (t: { is: (a: unknown, b: unknown, m?: string) => void }) => {
    // Signed, because the peer under attack refuses anything else - an unsigned probe would come
    // back as a timeout and be read as "it died", which is the wrong answer for the right shape.
    const name = `probe-${randomUUID().slice(0, 6)}`
    const client = new RpcClient(undefined, {
        name,
        defaultTarget: CSHARP_PEER!,
        transport: new MqttTransport(name, BROKER_URL, {
            prefix: PREFIX,
            sessionExpirySeconds: 10,
            sign: createHmacSigner(SECRET),
            verify: createHmacVerifier(() => SECRET)
        })
    })
    await client.ready()
    try {
        const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')
        t.is(await meter.read('flow'), 'flow=42', 'the peer stopped answering - it did not survive the frames above')
    } finally {
        await client.close()
    }
}

test.serial('a deeply nested payload does not reach the deserializer unsigned', async (t) => {
    if (skipWithoutPeer(t)) return

    // 0x91 is a MessagePack fixarray of one element, so N of them is N levels of nesting. Read
    // with the standard options - which the library's own documentation describes as omitting all
    // protections - `PrimitiveObjectFormatter` recurses once per level and the process dies of a
    // StackOverflowException that no `try` can catch. This carries no signature, so the only thing
    // that saves the peer is refusing to read the payload before the frame is verified.
    const bomb = Buffer.concat([Buffer.alloc(200_000, 0x91), Buffer.from([0xc0])])
    await publish(t, bomb)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // And again as JSON, where the reader has its own depth limit but the frame is still unsigned.
    await publish(t, Buffer.from('['.repeat(50_000)), { [MR.version]: '3' })
    await new Promise((resolve) => setTimeout(resolve, 1000))

    await stillAlive(t)
})

test.serial('a crafted timestamp does not throw its way out of the receive path', async (t) => {
    if (skipWithoutPeer(t)) return

    // `Math.Abs(long.MinValue)` throws, and mr-ts is whatever the sender wrote. The freshness check
    // has to bound the value before doing arithmetic on it, or one frame puts an unhandled
    // exception where the refusal should be.
    for (const ts of ['-9223372036854775808', '9223372036854775807', String(Date.now() - 9223372036854775808), 'not-a-number', '']) {
        await publish(t, Buffer.from([0x90]), { [MR.nonce]: randomUUID(), [MR.timestamp]: ts, [MR.signature]: 'AAAA' })
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))

    await stillAlive(t)
})

test.serial('nonces from unsigned garbage do not accumulate without bound', async (t) => {
    if (skipWithoutPeer(t)) return

    // The replay guard runs before the signature check - which is the right order, because the
    // reverse would let an attacker force an HMAC per packet. The cost of that ordering is that
    // anyone can put entries in it, so it has to be bounded by *count* and not only by age:
    // everything inside the freshness window is too young to expire, so an age-only rule bounds
    // nothing and makes every later message walk the whole table.
    for (let i = 0; i < 3000; i++) {
        await publish(t, Buffer.from([0x90]), {
            [MR.nonce]: `${run}-${i}`,
            [MR.timestamp]: String(Date.now()),
            [MR.signature]: 'AAAA'
        })
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Not a memory assertion - it is that the peer is still responsive after being made to track
    // several thousand nonces it had no reason to trust.
    await stillAlive(t)
})
