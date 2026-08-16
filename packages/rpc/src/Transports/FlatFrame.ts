import { Message, MessageType } from '../RPC/Core.js'
import { fromInboundFrame, InboundFrame, OutboundFrame, toOutboundFrame } from '../RPC/Frame.js'
import { RpcBatchPayload, RpcMessage, RpcMessageType } from '../RPC/Messages.js'

/**
 * The neutral frame of RPC/Frame.ts as one flat map, and back. Described in docs/flat-frame-spec.md.
 *
 * **Not socket.io's, though socket.io was the first to need it.** A transport with one bidirectional
 * link and some way to name a message needs exactly this and nothing more: the frame carries its own
 * `src` and `tgt`, so there is no addressing left for the transport to supply and no per-transport
 * vocabulary to invent. socket.io names messages with events, SignalR names them with hub methods,
 * and both carry this frame under the name `frame` - which is why that constant lives here rather
 * than in either transport.
 *
 * ## Why this replaced the `$`-delimited layout
 *
 * The old frame was `JSON header` + `'$'` + `msgpack(Message)`, and the cost of it was not the
 * nesting - it was the **two encodings in one frame**. A boundary between them has to be found
 * before either can be read, and because the header is JSON, a peer name containing a `$` puts one
 * inside a quoted string where it is data rather than punctuation. So finding it means walking the
 * bytes with JSON's own quoting rules: `findHeaderEnd` in Core.ts, tracking brace depth, string
 * state and backslash escapes, with a length limit past which frames are silently dropped. An
 * implementer in another language has to reproduce that byte-exactly or lose frames, and
 * `Framing.test.ts` and `Resilience.test.ts` record what went wrong when this library got it wrong.
 *
 * One map in one encoding has no boundary to find. There is nothing to scan, no length limit, no
 * delimiter to collide with a peer name, and the whole frame is `codec.decode(bytes)` - which is
 * the same call a caller already has to make for the body.
 *
 * ## Why the keys are words
 *
 * They could be one character each and the frames would be smaller. They are not, because the point
 * of this format is that somebody implements it from the specification in a language nobody here
 * has thought about, and `k`/`c`/`p` turn every debugging session into a lookup. The names are the
 * MQTT 5 property names with the `mr-` prefix removed, so the two wire formats read as one protocol
 * - which is the whole reason the neutral frame exists.
 */

/**
 * What a flat frame is called: a socket.io event, and a SignalR hub method.
 *
 * On socket.io this doubles as the version negotiation, which is why there is no version to
 * negotiate: a peer emitting `frame` speaks v2, a peer emitting `message` speaks v1, and a server
 * listening for both serves both without reading a byte to find out which. socket.io hands an event
 * to the listener registered for it or to nobody, so the two populations cannot be confused for each
 * other the way two layouts sharing one name could be.
 *
 * MQTT could not do that cheaply - it took a whole topic prefix change, `msgrpc/v1` to `msgrpc/v2`,
 * to keep its populations apart. Here it costs one extra listener.
 */
export const FRAME_EVENT = 'frame'

/** The socket.io event the `$`-delimited layout uses. Still served, so a v1 peer keeps working. */
export const LEGACY_FRAME_EVENT = 'message'

export const FLAT_FRAME_VERSION = 2

/**
 * A frame on the wire. Every field is optional except the ones that address it, because a frame
 * carries what its kind needs and nothing else - the same rule the MQTT properties follow.
 *
 * `time` and `seq` are deliberately gone. The old header carried both and this transport read
 * neither: they exist for the MQTT v1 signing canonicalisation, and socket.io does not sign frames
 * at all - it authenticates the connection once at the handshake and pins the source to the
 * identity it authenticated as, which is a stronger claim than a per-frame signature and is checked
 * in one place. A field nobody reads is a field somebody has to implement.
 */
export interface WireFrame {
    /** Frame format version. A frame announcing anything else is refused, not guessed at. */
    v: number
    /** The sending peer. Checked against the connection's authenticated identity where there is one. */
    src: string
    /** The addressee. Present because socket.io has one bidirectional link and no topic to carry addressing. */
    tgt: string
    /** How many relays this frame has already passed through. Absent means none. */
    hops?: number
    kind: string
    /** The request id, shared by a call and every later answer to it. Absent on events. */
    corr?: string
    path?: string
    method?: string
    event?: string
    code?: string
    ver?: string
    ttl?: number
    idem?: string
    fence?: string
    deferred?: boolean
    outcome?: string
    seq?: number
    epoch?: string
    /** Arguments for a request, the value for a result, the emit arguments for an event. */
    body?: unknown
    /**
     * On `kind: 'batch'`: the frames this one carries, which are dispatched individually.
     *
     * A batch is an envelope rather than a frame, which is why it is a field here and not a shape in
     * the neutral frame. MQTT 5 cannot express it - one publish pairs with one correlation, and a
     * batch has as many correlations as it has calls - so that transport unpacks a batch into
     * separate publishes and pays the envelope cost for each. socket.io has one link and no
     * correlation rule to break, so the saving this exists for is real here: twenty small calls
     * cost one emit.
     *
     * Nothing about a batch is a transaction. Each carried frame keeps its own correlation, ttl,
     * idempotency key and fence, and each is answered separately.
     */
    batch?: WireFrame[]
}

/** The frame fields for one message, with no addressing - what a batch's carried entries hold. */
const fieldsFor = (frame: OutboundFrame): Omit<WireFrame, 'v' | 'src' | 'tgt'> => ({
    kind: frame.kind,
    ...(frame.correlation ? { corr: frame.correlation } : {}),
    ...(frame.path ? { path: frame.path } : {}),
    ...(frame.method ? { method: frame.method } : {}),
    ...(frame.event ? { event: frame.event } : {}),
    ...(frame.code ? { code: frame.code } : {}),
    ...(frame.version ? { ver: frame.version } : {}),
    ...(frame.ttl !== undefined ? { ttl: frame.ttl } : {}),
    ...(frame.idempotencyKey ? { idem: frame.idempotencyKey } : {}),
    ...(frame.fence ? { fence: frame.fence } : {}),
    ...(frame.deferred ? { deferred: true } : {}),
    ...(frame.outcome ? { outcome: frame.outcome } : {}),
    ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
    ...(frame.epoch ? { epoch: frame.epoch } : {}),
    ...(frame.body !== undefined ? { body: frame.body } : {})
})

/**
 * Undefined for a message this layout cannot express, which the transport reports rather than
 * sends. Nothing in the current vocabulary hits it - the point of the neutral frame is that this
 * cannot drift - but a message type added without a frame to carry it must fail loudly here rather
 * than travel as an empty frame.
 */
export const toWireFrame = (message: Message, source: string, target: string, hops = 0): WireFrame | undefined => {
    const addressing = { v: FLAT_FRAME_VERSION, src: source, tgt: target, ...(hops ? { hops } : {}) }
    const payload = message.payload as RpcMessage | undefined
    if (payload?.type === RpcMessageType.batch) {
        const carried = ((payload as RpcBatchPayload).payloads ?? [])
            .map((one) => toOutboundFrame({ type: message.type, payload: one } as Message))
            .filter((one): one is OutboundFrame => one !== undefined)
        // An envelope that lost its contents is not an empty batch to send - it is a frame whose
        // every call would be answered by nothing, and the caller would wait out each one.
        if (!carried.length) return undefined
        return { ...addressing, kind: 'batch', batch: carried.map((one) => ({ ...addressing, ...fieldsFor(one) })) }
    }
    const frame = toOutboundFrame(message)
    if (!frame) return undefined
    return { ...addressing, ...fieldsFor(frame) }
}

const inboundFrom = (wire: WireFrame): InboundFrame => ({
    kind: wire.kind,
    correlation: wire.corr,
    path: wire.path,
    method: wire.method,
    event: wire.event,
    code: wire.code,
    version: wire.ver,
    ttl: wire.ttl,
    idempotencyKey: wire.idem,
    fence: wire.fence,
    deferred: wire.deferred === true,
    outcome: wire.outcome,
    seq: wire.seq,
    epoch: wire.epoch,
    body: wire.body
})

/** What a decoded frame turned out to be, or why nothing could be made of it. */
export type ReadFrame = { message: Message; source: string; target: string; hops: number } | { reason: string }

/**
 * Read a decoded frame, refusing anything malformed rather than guessing at it.
 *
 * Never throws: every frame here came off the network, and one bad frame from one peer must not
 * take down a process serving the rest. The refusal says why, because a frame that merely
 * disappears is the hardest kind of problem to diagnose - it looks like a call that timed out.
 */
export const fromWireFrame = (decoded: unknown): ReadFrame => {
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return { reason: 'frame is not an object' }
    const wire = decoded as WireFrame
    if (wire.v !== FLAT_FRAME_VERSION) return { reason: `frame version ${String(wire.v)}, which this build does not accept` }
    if (typeof wire.src !== 'string' || !wire.src) return { reason: 'frame names no source' }
    if (typeof wire.tgt !== 'string' || !wire.tgt) return { reason: 'frame names no target' }
    const hops = typeof wire.hops === 'number' && Number.isSafeInteger(wire.hops) && wire.hops >= 0 ? wire.hops : 0

    if (wire.kind === 'batch') {
        if (!Array.isArray(wire.batch) || !wire.batch.length) return { reason: 'batch carries no frames' }
        const payloads: RpcMessage[] = []
        for (const one of wire.batch) {
            // A nested frame that cannot be read sinks the envelope rather than being skipped.
            // Dropping one silently would answer some of a caller's calls and leave the rest to
            // time out, which is the worst of the three possible outcomes to debug.
            const carried = fromInboundFrame(inboundFrom(one))
            if (!carried?.payload) return { reason: `batch carries an unreadable '${String(one?.kind)}' frame` }
            payloads.push(carried.payload as RpcMessage)
        }
        const payload: RpcBatchPayload = { type: RpcMessageType.batch, payloads }
        return { message: { type: MessageType.RequestMessage, payload }, source: wire.src, target: wire.tgt, hops }
    }

    const message = fromInboundFrame(inboundFrom(wire))
    if (!message) return { reason: `unrecognised or incomplete '${String(wire.kind)}' frame` }
    return { message, source: wire.src, target: wire.tgt, hops }
}
