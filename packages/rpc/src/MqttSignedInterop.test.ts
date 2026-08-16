import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync, MqttClient } from 'mqtt'
import { createHmacSigner, createHmacVerifier, MqttTransport, RpcClient } from './index.js'
import { canonicalSignedBytesV5 as canonicalBytes } from './RPC/Signing.js'
import { MR } from './Transports/Mqtt5Frame.js'

/**
 * A signed conversation between a TypeScript peer and a C# peer, over a broker.
 *
 * Signing matters more here than on any other carrier, and for a structural reason: MQTT peers
 * connect to a broker rather than to each other, so `mr-src` is a claim with no connection behind it
 * to check it against. Anyone the ACLs let publish to a peer's request topic can otherwise issue
 * commands as anybody. This is what replaces the connection.
 *
 * The canonical bytes are checked separately and directly in MqttSigningInterop.test.ts, which is
 * the test that says *why* two independent implementations agree. This one says that they do, on a
 * real broker, with real HMACs, in both directions - and that the checks around the signature bite:
 * unsigned is refused, wrongly signed is refused, and a captured frame cannot be sent again or
 * altered in flight.
 *
 * Needs a broker and a signing C# peer on it:
 *
 * ```
 * RPC_PEER_NAME=csharp-signed RPC_MQTT_SECRET=interop-secret \
 *   dotnet run --project packages/csharp/TestHost -c Release -- mqtt mqtt://127.0.0.1:1883 msgrpc/v2
 *
 * SOURCE_RPC_TEST_CSHARP_MQTT_SIGNED=csharp-signed npm test --workspace=@source-repo/rpc
 * ```
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
const CSHARP_PEER = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_SIGNED
const PREFIX = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_PREFIX ?? 'msgrpc/v2'
const SECRET = process.env.SOURCE_RPC_TEST_CSHARP_MQTT_SECRET ?? 'interop-secret'
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
    const skipped = !(await brokerAvailable()) || !CSHARP_PEER
    if (skipped && process.env.SOURCE_RPC_REQUIRE_CSHARP_MQTT)
        throw new Error(
            'SOURCE_RPC_REQUIRE_CSHARP_MQTT is set, but there is no broker or no SOURCE_RPC_TEST_CSHARP_MQTT_SIGNED peer named - these tests must not be skipped here'
        )
    t.context = { skipped }
})

const skipWithoutPeer = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass('no broker or no signing C# peer named - skipped')
    return t.context.skipped
}

/** A peer that signs everything it sends and refuses anything unsigned or badly signed. */
const signingClient = (name: string) =>
    new RpcClient(undefined, {
        name: `${name}-${run}`,
        defaultTarget: CSHARP_PEER!,
        transport: new MqttTransport(`${name}-${run}`, BROKER_URL, {
            prefix: PREFIX,
            sessionExpirySeconds: 10,
            sign: createHmacSigner(SECRET),
            // One secret for every peer, which is right for a test and wrong for a plant: HMAC is
            // symmetric, so a secret this broad lets any holder sign as any peer.
            verify: createHmacVerifier(() => SECRET)
        })
    })

test.serial('a signed call crosses to C# and its signed answer comes back', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = signingClient('ts-signed')
    await client.ready()
    const meter = await client.proxy<{ read(tag: string): Promise<string> }>('meter')

    // Both directions verified: this peer refuses unsigned frames, so an answer arriving at all
    // means the C# side produced a signature over bytes this library agreed with.
    t.is(await meter.read('flow'), 'flow=42')

    await client.close()
})

test.serial('the owner fence still bites when the frame is signed', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = signingClient('ts-signed-fence')
    await client.ready()
    type Fenceable = { $with(o: { ownerEpoch: string }): { read(tag: string): Promise<string> } }
    const meter = await client.proxy<Fenceable>('meter')

    t.is(await meter.$with({ ownerEpoch: 'e-owner' }).read('flow'), 'flow=42')
    // `mr-fence` is inside the signature as well as on the wire, so this proves both that it
    // travelled and that covering it did not stop it being read.
    const stale = await t.throwsAsync(meter.$with({ ownerEpoch: 'e-stale' }).read('flow'))
    t.regex(String(stale?.message), /OwnershipChanged|owner generation/)

    await client.close()
})

/**
 * A raw MQTT peer, for the frames a well-behaved library would never send.
 *
 * The whole value of signing is what happens to frames from something that is not this library, so
 * the refusals have to be tested from outside it.
 */
class RawPeer {
    private constructor(
        readonly mqtt: MqttClient,
        readonly name: string,
        readonly replyTopic: string,
        readonly replies: Buffer[]
    ) {}

    static async connect(name: string) {
        const full = `${name}-${run}`
        const replyTopic = `${PREFIX}/rsp/${full}`
        const mqtt = await connectAsync(BROKER_URL, { protocolVersion: 5, reconnectPeriod: 0 })
        const replies: Buffer[] = []
        mqtt.on('message', (_topic, payload) => replies.push(payload))
        await mqtt.subscribeAsync(replyTopic)
        return new RawPeer(mqtt, full, replyTopic, replies)
    }

    /** A `call` frame, signed with whatever secret is given - including the wrong one, or none. */
    async call(target: string, properties: Record<string, string>, body: string, secret?: string) {
        const correlation = randomUUID()
        const topic = `${PREFIX}/req/${target}`
        const payload = Buffer.from(body)
        const user: Record<string, string> = {
            [MR.version]: '3',
            [MR.source]: this.name,
            [MR.kind]: 'call',
            ...properties
        }

        if (secret) {
            const nonce = randomUUID()
            const timestamp = Date.now()
            const sign = createHmacSigner(secret)
            const canonical = canonicalFor(topic, this.replyTopic, this.name, user, correlation, timestamp, nonce, payload)
            user[MR.nonce] = nonce
            user[MR.timestamp] = String(timestamp)
            user[MR.signature] = await sign(canonical, { source: this.name })
        }

        await this.mqtt.publishAsync(topic, payload, {
            properties: {
                responseTopic: this.replyTopic,
                correlationData: Buffer.from(correlation),
                contentType: 'application/json',
                userProperties: user
            }
        })
        return user
    }

    /** Send an already-built frame again, or with one property changed. */
    async resend(target: string, user: Record<string, string>, body: string, correlation: string) {
        await this.mqtt.publishAsync(`${PREFIX}/req/${target}`, Buffer.from(body), {
            properties: {
                responseTopic: this.replyTopic,
                correlationData: Buffer.from(correlation),
                contentType: 'application/json',
                userProperties: user
            }
        })
    }

    /** Nothing came back within the window - which is what a refusal looks like from outside. */
    async silentFor(ms = 1500) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return this.replies.length === 0
    }

    async close() {
        await this.mqtt.endAsync()
    }
}

const canonicalFor = (
    topic: string,
    responseTopic: string,
    source: string,
    user: Record<string, string>,
    correlation: string,
    timestamp: number,
    nonce: string,
    payload: Buffer
) => {
    // Rebuilt from the properties actually being sent, so a test that alters one alters what is
    // signed too - and has to alter it deliberately to break the signature.
    const at = (name: string) => user[name] ?? ''
    return canonicalBytes({
        version: at(MR.version),
        topic,
        responseTopic,
        source,
        kind: at(MR.kind),
        path: at(MR.path),
        methodOrEvent: at(MR.method) || at(MR.event),
        correlation,
        contentType: 'application/json',
        code: at(MR.code),
        contractVersion: at(MR.contractVersion),
        ttl: at(MR.ttl),
        idempotencyKey: at(MR.idempotencyKey),
        fence: at(MR.fence),
        deferred: at(MR.deferred),
        outcome: at(MR.outcome),
        seq: at(MR.seq),
        epoch: at(MR.epoch),
        timestamp,
        nonce,
        payload: new Uint8Array(payload)
    })
}

test.serial('an unsigned frame from a stranger is refused', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-unsigned')

    // A perfectly well-formed call, missing only a signature. Accepting it would make signing
    // optional in practice, which is to say absent.
    await raw.call(CSHARP_PEER!, { [MR.path]: 'meter', [MR.method]: 'read' }, JSON.stringify(['flow']))
    t.true(await raw.silentFor(), 'an unsigned call was answered')

    await raw.close()
})

test.serial('a frame signed with the wrong secret is refused', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-wrongkey')

    await raw.call(CSHARP_PEER!, { [MR.path]: 'meter', [MR.method]: 'read' }, JSON.stringify(['flow']), 'not-the-secret')
    t.true(await raw.silentFor(), 'a frame signed with the wrong secret was answered')

    await raw.close()
})

/**
 * Sign one set of properties and publish another.
 *
 * Signing what is actually sent is the honest path and every other helper here takes it; this one
 * exists to be dishonest in exactly one field at a time, which is the only way to show that a field
 * is *covered*. Changing a property and the nonce together would prove nothing - the nonce is
 * signed too, so the frame would fail for that instead, and a test that passes for the wrong reason
 * is worse than no test.
 */
const signedAs = async (raw: RawPeer, signed: Record<string, string>, sent: Record<string, string>, body: string) => {
    const correlation = randomUUID()
    const nonce = randomUUID()
    const timestamp = Date.now()
    const topic = `${PREFIX}/req/${CSHARP_PEER}`
    const base = { [MR.version]: '3', [MR.source]: raw.name, [MR.kind]: 'call' }

    const signature = await createHmacSigner(SECRET)(
        canonicalFor(topic, raw.replyTopic, raw.name, { ...base, ...signed }, correlation, timestamp, nonce, Buffer.from(body)),
        { source: raw.name }
    )
    const properties = { ...base, ...sent, [MR.nonce]: nonce, [MR.timestamp]: String(timestamp), [MR.signature]: signature }
    await raw.resend(CSHARP_PEER!, properties, body, correlation)
    return properties
}

test.serial('a captured frame cannot be sent again', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-replay')
    const body = JSON.stringify(['flow'])
    const honest = { [MR.path]: 'meter', [MR.method]: 'read' }

    // The positive control, and the reason the silences in this file mean anything: the same raw
    // construction, honestly signed, is answered. Without it, "nothing came back" would be as
    // consistent with a topic typo as with a refusal.
    const captured = await signedAs(raw, honest, honest, body)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    t.is(raw.replies.length, 1, 'the genuine frame was not answered')

    // The same bytes again - what an eavesdropper has and needs no key to send. A signature says
    // who wrote a frame, never how many times they meant to send it, and for RPC that difference is
    // a command carried out twice.
    await raw.resend(CSHARP_PEER!, captured, body, 'replayed')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    t.is(raw.replies.length, 1, 'a replayed frame was answered a second time')

    await raw.close()
})

test.serial('the fields a receiver acts on are covered, one at a time', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-tamper')
    const body = JSON.stringify(['flow'])
    const honest = { [MR.path]: 'meter', [MR.method]: 'read' }

    // Each of these is a fresh, correctly signed frame whose signature covers one thing and whose
    // properties say another. Every one must be refused, and for the field named rather than by
    // accident - a stale nonce or a stale clock would refuse them all whatever the signature said.
    const tampered: [string, Record<string, string>][] = [
        // A different method under a proof for `read`: the difference between reading a meter and
        // being refused by one, or in a plant between reading a valve and moving it.
        ['the method', { ...honest, [MR.method]: 'refuse' }],
        // A different responder entirely.
        ['the path', { ...honest, [MR.path]: 'nosuch' }],
        // A fence added after signing. This is the field whose absence from the signature was the
        // original bug: an unsigned fence can be stripped or forged in flight, and a command then
        // runs under an ownership its caller never observed.
        ['the owner fence', { ...honest, [MR.fence]: 'e-owner' }],
        // An idempotency key added after signing, which decides whether a command runs at all.
        ['the idempotency key', { ...honest, [MR.idempotencyKey]: `tamper-${run}` }]
    ]

    for (const [field, sent] of tampered) {
        const before = raw.replies.length
        await signedAs(raw, honest, sent, body)
        await new Promise((resolve) => setTimeout(resolve, 1200))
        t.is(raw.replies.length, before, `${field} is not covered by the signature`)
    }

    // And the body, which the properties say nothing about at all.
    const before = raw.replies.length
    const correlation = randomUUID()
    const nonce = randomUUID()
    const timestamp = Date.now()
    const base = { [MR.version]: '3', [MR.source]: raw.name, [MR.kind]: 'call', ...honest }
    const signature = await createHmacSigner(SECRET)(
        canonicalFor(`${PREFIX}/req/${CSHARP_PEER}`, raw.replyTopic, raw.name, base, correlation, timestamp, nonce, Buffer.from(body)),
        { source: raw.name }
    )
    await raw.resend(
        CSHARP_PEER!,
        { ...base, [MR.nonce]: nonce, [MR.timestamp]: String(timestamp), [MR.signature]: signature },
        JSON.stringify(['tampered']),
        correlation
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    t.is(raw.replies.length, before, 'the arguments are not covered by the signature')

    await raw.close()
})
