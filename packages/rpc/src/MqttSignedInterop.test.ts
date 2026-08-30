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
    if (skipped) return

    // Connected is not the same as answering, and this suite was failing on the difference. The
    // workflow waits for the peer to log RPC-MQTT-READY before starting, so it is on the broker -
    // but the first call into a cold .NET peer pays its JIT, its subscription settling and
    // whatever else is sharing the runner, and a 10 s deadline that is roomy on a laptop is not
    // always roomy there. The first test in this file is what paid that, and it read as "the
    // signed call did not cross" when what happened was that the peer had not woken up yet.
    //
    // So the waiting is here, once, where it can say what it is waiting for. A peer that is
    // genuinely absent still fails - four attempts is forty seconds - and fails with a sentence
    // about the peer rather than a timeout inside an assertion about signatures.
    const warmup = signingClient('warmup')
    try {
        await warmup.ready()
        const meter = await warmup.proxy<{ read(tag: string): Promise<string> }>('meter')
        for (let attempt = 1; ; attempt++) {
            try {
                await meter.read('flow')
                break
            } catch (error) {
                if (attempt === 4) throw new Error(`the signing C# peer '${CSHARP_PEER}' is on the broker but never answered a call`, { cause: error })
            }
        }
    } finally {
        await warmup.close()
    }
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
 * One frame, described as two things: what was signed, and what was sent.
 *
 * They are the same for an honest frame, and differ in exactly one field for a tampered one. That
 * separation is the whole point of this helper: changing a property *and* the nonce would be
 * refused because of the nonce, and prove nothing about the property.
 */
interface Frame {
    properties: Record<string, string>
    contentType: string
    replyTopic: string
    correlation: string
    body: string
}

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

    /** The ordinary frame these tests vary: a `meter.read`, addressed and answerable. */
    frame(over: Partial<Frame> = {}): Frame {
        return {
            properties: { [MR.version]: '3', [MR.source]: this.name, [MR.kind]: 'call', [MR.path]: 'meter', [MR.method]: 'read' },
            contentType: 'application/json',
            replyTopic: this.replyTopic,
            correlation: randomUUID(),
            body: JSON.stringify(['flow']),
            ...over
        }
    }

    /**
     * Sign one frame and send another.
     *
     * Pass the same object twice for an honest frame. `secret` may be wrong, or **null** to send
     * nothing at all where a signature belongs - null rather than undefined, because passing
     * undefined to a parameter with a default value uses the default, which quietly signed the
     * frame that this file's unsigned test was built to have refused.
     */
    async publish(target: string, signed: Frame, sent: Frame = signed, secret: string | null = SECRET) {
        const topic = `${PREFIX}/req/${target}`
        const properties = { ...sent.properties }

        if (secret) {
            const nonce = randomUUID()
            const timestamp = Date.now()
            const canonical = canonicalFor(topic, this.name, signed, timestamp, nonce)
            properties[MR.nonce] = nonce
            properties[MR.timestamp] = String(timestamp)
            properties[MR.signature] = await createHmacSigner(secret)(canonical, { source: this.name })
        }

        await this.send(topic, sent, properties)
        return properties
    }

    /** Put an already-built property set on the wire again, byte for byte. */
    async send(topic: string, sent: Frame, properties: Record<string, string>) {
        await this.mqtt.publishAsync(topic, Buffer.from(sent.body), {
            properties: {
                responseTopic: sent.replyTopic,
                correlationData: Buffer.from(sent.correlation),
                contentType: sent.contentType,
                userProperties: properties
            }
        })
    }

    /** How many answers have arrived. A refusal, from outside, is this number not changing. */
    get answered() {
        return this.replies.length
    }

    async settle(ms = 1500) {
        await new Promise((resolve) => setTimeout(resolve, ms))
    }

    async close() {
        await this.mqtt.endAsync()
    }
}

const canonicalFor = (topic: string, source: string, frame: Frame, timestamp: number, nonce: string) => {
    const at = (name: string) => frame.properties[name] ?? ''
    return canonicalBytes({
        version: at(MR.version),
        topic,
        responseTopic: frame.replyTopic,
        source,
        kind: at(MR.kind),
        path: at(MR.path),
        methodOrEvent: at(MR.method) || at(MR.event),
        correlation: frame.correlation,
        contentType: frame.contentType,
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
        payload: new Uint8Array(Buffer.from(frame.body))
    })
}

/**
 * The control every silence assertion in this file rests on: the same peer, the same construction,
 * honestly signed, is answered.
 *
 * Without it "nothing came back" is as consistent with a topic typo or a peer that is not running
 * as it is with a refusal - and the tests that assert silence would all pass against a dead broker.
 * It has to be the *same* code path as the assertion it backs, which is why it takes the frame.
 */
const proveAnswerable = async (t: { is: (a: unknown, b: unknown, m?: string) => void }, raw: RawPeer, frame: Frame) => {
    const before = raw.answered
    await raw.publish(CSHARP_PEER!, frame)
    await raw.settle()
    t.is(raw.answered, before + 1, 'the honest control frame was not answered - the refusals below would prove nothing')
}

test.serial('an unsigned frame from a stranger is refused', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-unsigned')

    // First that this peer can be reached at all, over this exact construction.
    await proveAnswerable(t, raw, raw.frame())

    // Then the same frame with nothing where the signature belongs. Accepting it would make
    // signing optional in practice, which is to say absent.
    const before = raw.answered
    const frame = raw.frame()
    await raw.publish(CSHARP_PEER!, frame, frame, null)
    await raw.settle()
    t.is(raw.answered, before, 'an unsigned call was answered')

    await raw.close()
})

test.serial('a frame signed with the wrong secret is refused', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-wrongkey')
    await proveAnswerable(t, raw, raw.frame())

    const before = raw.answered
    const frame = raw.frame()
    await raw.publish(CSHARP_PEER!, frame, frame, 'not-the-secret')
    await raw.settle()
    t.is(raw.answered, before, 'a frame signed with the wrong secret was answered')

    await raw.close()
})

test.serial('a captured frame cannot be sent again', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-replay')
    const frame = raw.frame()

    // The control and the capture in one: an honest frame, answered, whose exact properties an
    // eavesdropper now holds.
    const captured = await raw.publish(CSHARP_PEER!, frame)
    await raw.settle()
    t.is(raw.answered, 1, 'the genuine frame was not answered')

    // The same bytes again - every one of them, the correlation included. Sending a *different*
    // correlation would be a frame with a broken signature, which the signature check would refuse
    // whether or not any replay protection existed: the test would pass with the replay guard
    // deleted. A signature says who wrote a frame, never how many times they meant to send it, and
    // for RPC that difference is a command carried out twice.
    await raw.send(`${PREFIX}/req/${CSHARP_PEER}`, frame, captured)
    await raw.settle()
    t.is(raw.answered, 1, 'a replayed frame was answered a second time')

    await raw.close()
})

test.serial('a stranger spelling a number its own way is still verified', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-spelling')

    // Being reachable by a peer with no msgrpc code is the whole reason this layout exists, and
    // such a peer has no reason to spell a ttl the way `String(5000)` does. A verifier that
    // rebuilds the canonical bytes from *parsed* values signs a normalised copy of somebody else's
    // frame - and refuses their perfectly good signature as "bad signature", which is about the
    // most misleading thing it could say. Verified over the bytes that arrived, these all pass.
    for (const ttl of ['5000', '05000', '+5000', '5000 ']) {
        const before = raw.answered
        const frame = raw.frame()
        frame.properties[MR.ttl] = ttl
        await raw.publish(CSHARP_PEER!, frame)
        await raw.settle(1200)
        t.is(raw.answered, before + 1, `a frame with mr-ttl '${ttl}' was refused`)
    }

    await raw.close()
})

test.serial('the fields a receiver acts on are covered, one at a time', async (t) => {
    if (skipWithoutPeer(t)) return
    const raw = await RawPeer.connect('raw-tamper')
    await proveAnswerable(t, raw, raw.frame())

    // Each case is a fresh, correctly signed frame whose signature covers one thing and whose
    // frame says another. Every one must be refused, and for the field named rather than by
    // accident - a stale nonce or a stale clock would refuse them all whatever the signature said,
    // which is why nothing but the named field differs between `signed` and `sent`.
    const tampered: [string, (signed: Frame, sent: Frame) => void][] = [
        // A different method under a proof for `read`: in a plant, the difference between reading
        // a valve and moving it.
        ['the method', (_s, sent) => (sent.properties[MR.method] = 'refuse')],
        ['the path', (_s, sent) => (sent.properties[MR.path] = 'nosuch')],
        // The field whose absence from the signature was the original bug: an unsigned fence can
        // be stripped or forged in flight, and a command then runs under an ownership its caller
        // never observed.
        ['the owner fence', (_s, sent) => (sent.properties[MR.fence] = 'e-owner')],
        // Decides whether a command runs at all.
        ['the idempotency key', (_s, sent) => (sent.properties[MR.idempotencyKey] = `tamper-${run}`)],
        // The counterexample the whole signing revision was argued from: `0x31` is the JSON text
        // "1" and a MsgPack fixint 49. Both parse. Both verified. One setpoint.
        ['the content type', (_s, sent) => (sent.contentType = 'application/msgpack')],
        // Anything able to rewrite this has the answer delivered to a topic of its choosing.
        ['the reply address', (_s, sent) => (sent.replyTopic = `${PREFIX}/rsp/somewhere-else-${run}`)],
        // Not a property at all - the arguments.
        ['the arguments', (_s, sent) => (sent.body = JSON.stringify(['tampered']))]
    ]

    // One baseline for the whole loop, not one per case. Re-reading it each time would let a late
    // reply from case n land inside case n+1's baseline, so a run where *every* tampered frame was
    // answered would pass - the failure absorbed by the slowness that caused it.
    const before = raw.answered
    for (const [field, tamper] of tampered) {
        const signed = raw.frame()
        const sent = { ...signed, properties: { ...signed.properties } }
        tamper(signed, sent)
        await raw.publish(CSHARP_PEER!, signed, sent)
        await raw.settle(1200)
        t.is(raw.answered, before, `${field} is not covered by the signature`)
    }

    await raw.close()
})

test.serial('a deferred answer and an event are signed too, and verify', async (t) => {
    if (skipWithoutPeer(t)) return
    const client = signingClient('ts-signed-defer')
    await client.ready()
    const meter = await client.proxy<{
        slow(tag: string): Promise<{ id: string; result: Promise<string> }>
        on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
        pulse(reading: number): Promise<number>
    }>('meter')

    // `mr-deferred`, `mr-outcome`, `mr-seq` and `mr-epoch` are the four fields frame version 3
    // added, and the reason a signed version 2 frame is refused outright. Every other test in this
    // file exercises a plain call, where all four are absent - so without this they are signed and
    // verified by nothing, on either side.
    const ticket = (await meter.slow('signed')) as unknown as { id: string; result: Promise<string> }
    t.is(await ticket.result, 'finished signed', 'a receipt and a later ticket both had to verify')

    const seen: unknown[][] = []
    t.is(await meter.on('tick', (...args) => seen.push(args)), 'ok')
    await meter.pulse(9)
    const deadline = Date.now() + 8000
    while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    t.deepEqual(seen[0], [9, 'bar'], 'a signed event, carrying a signed cursor, arrived')

    await client.close()
})
