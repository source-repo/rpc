import { Message, MessageType } from './Core.js'
import {
    RpcCallInstanceMethodPayload,
    RpcErrorCode,
    RpcErrorPayload,
    RpcEventPayload,
    RpcMessage,
    RpcMessageType,
    RpcRemoteError,
    RpcSuccessPayload,
    RpcTicketPayload
} from './Messages.js'

/**
 * The protocol, flat: what an RPC message *is*, with none of the nesting a `Message` carries and
 * none of the naming any one transport happens to use for it.
 *
 * This began inside the MQTT 5 transport, because MQTT 5 was the only wire format that needed
 * structured access to kind, path, method and correlation rather than an opaque blob. It is filed
 * here now for the reason docs/mqtt5-frame-spec.md predicted when it called for a
 * transport-independent frame: a second wire format that maps to the same shape is a mapping
 * exercise, and one that invents its own vocabulary is a second protocol to implement and document.
 *
 * **The frame is the superset, and that is load-bearing.** Anything a `Message` can carry has to be
 * representable here, or the transports quietly disagree about what the protocol includes - which is
 * exactly how the owner fence came to be enforced over socket.io and ignored over MQTT 5. When a
 * payload grows a field that a receiver *acts on*, it belongs in this file before it belongs in any
 * transport.
 */

/** What a frame is for. `ticket` is a later answer to a call that has already been answered once. */
export type FrameKind = 'call' | 'subscribe' | 'unsubscribe' | 'result' | 'error' | 'event' | 'ticket'

/**
 * Which of the three conversations a frame belongs to: a request expecting an answer, an answer to
 * one, or something unsolicited.
 *
 * MQTT gives each its own topic, which is where the names come from and why they are short. A
 * transport with one bidirectional link ignores this; it is still the honest classification of the
 * frame, and it is what decides whether naming a reply address means anything.
 */
export type Channel = 'req' | 'rsp' | 'evt'

/** Kinds that expect an answer, and so are the only ones entitled to say where it should go. */
export const isRequestKind = (kind: string | undefined) => kind === 'call' || kind === 'subscribe' || kind === 'unsubscribe'

/**
 * Kinds that answer a request, and so are addressed by whatever the request asked for rather than
 * by the addressee's own channel. `ticket` is one of these and is the reason this is a predicate
 * rather than a comparison with 'rsp': a deferred call is answered twice, so "is this a reply" and
 * "is this the last reply" are different questions. See `isFinalReply`.
 */
export const isReplyKind = (kind: string | undefined) => kind === 'result' || kind === 'error' || kind === 'ticket'

export interface OutboundFrame {
    kind: FrameKind
    channel: Channel
    /** The request id. Absent on events, and shared by a call and every later answer to it. */
    correlation?: string
    path?: string
    method?: string
    event?: string
    code?: string
    /** Contract version the caller declares, when it has one. */
    version?: string
    /** Milliseconds the caller will still wait. Drives the MQTT message expiry as well. */
    ttl?: number
    /** Names the command rather than this attempt at it, when the caller says so. */
    idempotencyKey?: string
    /**
     * The owner generation the caller observed, when it fences. Carried flat rather than as the
     * payload's `{ownerEpoch}` object, because a wire format with string-valued properties has
     * nowhere to put an object.
     */
    fence?: string
    /**
     * This result is a ticket to wait on rather than the answer, and a `ticket` frame will follow.
     *
     * Said by the server rather than inferred from the shape of the body: a method may legitimately
     * return something ticket-shaped and mean nothing by it, and a caller that hydrated one would
     * hand back a promise nothing ever settles.
     */
    deferred?: boolean
    /** On a ticket: whether this is progress, or the outcome that ends it. */
    outcome?: RpcTicketPayload['outcome']
    /** On an event the server counts: this emission's position, with `epoch`. See `seq` on RpcEventPayload. */
    seq?: number
    /** On an event the server counts: the emitting server's incarnation, which a `seq` only orders within. */
    epoch?: string
    /** Encoded as the wire payload: arguments for a request, the value for a result. */
    body: unknown
}

/**
 * A reply that ends the exchange, so the bookkeeping held for it can be released.
 *
 * A plain result or error is final. A result marked `deferred` is not - it is the receipt, and the
 * answer comes later as a ticket - and a ticket is final only on the outcome that resolves or
 * rejects it, never on progress. Getting this wrong in either direction is a real failure rather
 * than an untidiness: released too early, a caller's later answers go to a derived address and in
 * the wrong encoding; released never, the bookkeeping grows for the life of the process.
 */
export const isFinalReply = (frame: Pick<OutboundFrame, 'kind' | 'deferred' | 'outcome'>) => {
    if (frame.kind === 'ticket') return frame.outcome !== 'progress'
    if (frame.kind === 'result') return !frame.deferred
    return frame.kind === 'error'
}

const requestKind = (method: string): FrameKind =>
    method === 'on' ? 'subscribe' : method === 'off' || method === 'removeListener' ? 'unsubscribe' : 'call'

/** Undefined for anything this shape has no representation for, which the transport reports. */
export const toOutboundFrame = (message: Message): OutboundFrame | undefined => {
    const payload = message.payload as RpcMessage | undefined
    if (!payload) return undefined
    switch (payload.type) {
        case RpcMessageType.CallInstanceMethod: {
            const call = payload as RpcCallInstanceMethodPayload
            return {
                kind: requestKind(call.method),
                channel: 'req',
                correlation: call.id,
                path: call.path,
                method: call.method,
                version: call.version,
                ttl: call.ttl,
                idempotencyKey: call.idempotencyKey,
                fence: call.fence?.ownerEpoch,
                body: call.params
            }
        }
        case RpcMessageType.success: {
            const success = payload as RpcSuccessPayload
            return { kind: 'result', channel: 'rsp', correlation: success.id, deferred: success.deferred, body: success.result }
        }
        case RpcMessageType.error: {
            const error = payload as RpcErrorPayload
            return { kind: 'error', channel: 'rsp', correlation: error.id, code: error.code, body: error.error }
        }
        case RpcMessageType.ticket: {
            const ticket = payload as RpcTicketPayload
            // A rejection carries the error where a resolution carries the value, so the body is
            // whichever of the two this outcome has. The outcome names which, rather than a
            // receiver guessing from the shape of what arrived.
            return {
                kind: 'ticket',
                channel: 'rsp',
                correlation: ticket.id,
                outcome: ticket.outcome,
                body: ticket.outcome === 'rejected' ? ticket.error : ticket.value
            }
        }
        case RpcMessageType.event: {
            const event = payload as RpcEventPayload
            return { kind: 'event', channel: 'evt', event: event.event, path: event.path, seq: event.seq, epoch: event.epoch, body: event.params }
        }
        default:
            return undefined
    }
}

export interface InboundFrame {
    kind: string
    correlation?: string
    path?: string
    method?: string
    event?: string
    code?: string
    version?: string
    /** What the caller said it would still wait, already narrowed by anything the transport reported. */
    ttl?: number
    idempotencyKey?: string
    /** The owner generation the caller observed, when it fenced. */
    fence?: string
    deferred?: boolean
    outcome?: string
    seq?: number
    epoch?: string
    body: unknown
}

/** Undefined when the frame does not describe anything this RPC layer can dispatch. */
export const fromInboundFrame = (frame: InboundFrame): Message | undefined => {
    switch (frame.kind) {
        case 'call':
        case 'subscribe':
        case 'unsubscribe': {
            if (!frame.correlation || !frame.path || !frame.method) return undefined
            const payload: RpcCallInstanceMethodPayload = {
                type: RpcMessageType.CallInstanceMethod,
                id: frame.correlation,
                path: frame.path,
                method: frame.method,
                version: frame.version,
                ttl: frame.ttl,
                idempotencyKey: frame.idempotencyKey,
                // Absent rather than `{ownerEpoch: undefined}`: fenceRefusal tests the fence object
                // for presence, so an empty one would be a fence against nothing rather than none.
                ...(frame.fence ? { fence: { ownerEpoch: frame.fence } } : {}),
                // A caller that sends no payload means no arguments.
                params: Array.isArray(frame.body) ? frame.body : frame.body === undefined || frame.body === null ? [] : [frame.body]
            }
            return { type: MessageType.RequestMessage, payload }
        }
        case 'result': {
            if (!frame.correlation) return undefined
            const payload: RpcSuccessPayload = {
                type: RpcMessageType.success,
                id: frame.correlation,
                result: frame.body,
                // Only when true. An explicit `deferred: false` would travel as a field the sender
                // never set, and the client hydrates on presence rather than on value.
                ...(frame.deferred ? { deferred: true } : {})
            }
            return { type: MessageType.ResponseMessage, payload }
        }
        case 'error': {
            if (!frame.correlation) return undefined
            const payload: RpcErrorPayload = {
                type: RpcMessageType.error,
                id: frame.correlation,
                code: (frame.code ?? 'Exception') as RpcErrorCode,
                error: frame.body as RpcRemoteError | undefined
            }
            return { type: MessageType.ErrorMessage, payload }
        }
        case 'ticket': {
            // Refused rather than defaulted. The outcome decides whether the caller's promise
            // settles and how, so a ticket arriving without a readable one is not a ticket whose
            // outcome is 'progress' - it is a frame nothing here can act on.
            if (!frame.correlation) return undefined
            if (frame.outcome !== 'progress' && frame.outcome !== 'resolved' && frame.outcome !== 'rejected') return undefined
            const payload: RpcTicketPayload = {
                type: RpcMessageType.ticket,
                id: frame.correlation,
                outcome: frame.outcome,
                ...(frame.outcome === 'rejected' ? { error: frame.body as RpcRemoteError | undefined } : { value: frame.body })
            }
            return { type: MessageType.ResponseMessage, payload }
        }
        case 'event': {
            if (!frame.event) return undefined
            const payload: RpcEventPayload = {
                type: RpcMessageType.event,
                event: frame.event,
                path: frame.path,
                ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
                ...(frame.epoch ? { epoch: frame.epoch } : {}),
                params: Array.isArray(frame.body) ? frame.body : [frame.body]
            }
            return { type: MessageType.EventMessage, payload }
        }
        default:
            return undefined
    }
}
