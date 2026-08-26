import { MessageModule, Message, MessageType, GenericModule } from './Core.js'
import { isEventFunction } from './Rpc.js'
import {
    RpcErrorPayload,
    RpcEventPayload,
    RpcErrorCode,
    RpcCallInstanceMethodPayload,
    RpcMessage,
    RpcSuccessPayload,
    type RpcTicketPayload,
    RpcMessageType,
    type RpcBatchPayload,
    type RpcMethodSemantics
} from './RpcServerHandler.js'
import { RpcOperations } from './Operations.js'
import { RpcTickets } from './Ticket.js'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'

export const defaultCallTimeout = 10000

/**
 * Identifies one subscription: which peer, which exposed instance, which event.
 *
 * Handlers used to be registered under the bare event name, so a client watching `alarm` on two
 * namespaces - or on two peers over one MQTT transport - delivered each event to all of them. An
 * empty source matches any peer, for a proxy created without a target.
 */
export const subscriptionKey = (source: string, namespace: string, event: string) => `${source}\u0000${namespace}\u0000${event}`

export class RpcError extends Error {
    constructor(
        public code: RpcErrorCode,
        message?: string,
        /** Stack trace from the remote peer, when it sent one. */
        public remoteStack?: string
    ) {
        super(message ? `${code}: ${message}` : code)
        this.name = 'RpcError'
    }
}

export interface RpcClientEmitter extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> {
    on(event: string, handler: (_event: string, params: unknown[]) => void): this
    emit(event: string, params: unknown[]): boolean
    removeListener(event: string, handler: (params: unknown[]) => void): this
}

function isTicketReply(payload: RpcMessage): payload is RpcTicketPayload {
    return payload.type === RpcMessageType.ticket
}

function isSuccessResponse(payload: RpcMessage): payload is RpcSuccessPayload {
    return payload.type === RpcMessageType.success
}

function isEventMessage(payload: RpcMessage): payload is RpcEventPayload {
    return payload.type === RpcMessageType.event
}

function isErrorResponse(payload: RpcMessage): payload is RpcErrorPayload {
    return payload.type === RpcMessageType.error
}

export type PromiseResolver<T> = { resolve: (result: T) => void; reject: (reason?: unknown) => void }

/** What a caller can say about one call that the library cannot work out for itself. */
export interface RpcCallOptions {
    /**
     * Names the command, so a second attempt at it is recognised as the same one.
     *
     * The case this exists for: an operator presses "start pump", the answer is `UnknownOutcome`,
     * and they press it again. Without a key those are two commands and a server with a durable
     * idempotency store will run both. With one they are two attempts at a command that runs once,
     * and the second gets the first's answer.
     *
     * It has to come from whatever identifies the operator's intent - a work order, a batch step, a
     * button press id. A value generated per attempt would defeat the purpose, since that is what
     * the request id already is.
     */
    idempotencyKey?: string
    /**
     * How long this call waits, overriding the client's `callTimeout`. The same number becomes the
     * transmitted ttl, so what the far end is told is exactly what this caller is going to do.
     *
     * `0` means no local timer and no ttl - a call that waits as long as it takes, for a long poll
     * whose bound lives on the server side. A finite, non-negative integer; anything else is a
     * usage error and is refused before anything is sent.
     */
    timeoutMs?: number
    /**
     * Fence this call on the target's owner generation, as this caller last observed it from the
     * topology record. Reassign the owner and the fence refuses `OwnershipChanged` - the
     * within-flight half of what the lease's target-side check cannot see.
     */
    ownerEpoch?: string
    /**
     * What this method does, for the operations registry to show beside the call.
     *
     * **It travels nowhere and decides nothing.** A client holds no schema, and this repository's
     * own rule is that a running class beats the schema for exactly this question - so a caller's
     * claim about semantics is for a screen to read and never for a mechanism to gate on. What it
     * buys is the difference between a tray that can say *this uncertain one was a non-repeatable
     * command* and one showing an operator six identical rows.
     */
    semantics?: RpcMethodSemantics
}

/** A proxy with per-call options attached. See `$with` on a proxy. */
export type WithOptions<T> = { $with(options: RpcCallOptions): T }

/**
 * One remote subscription resubscribe() could not re-establish, carried on `resubscribeFailed`.
 * Named rather than counted, because the consumer that matters is a shadow copy deciding which of
 * its values are now stale - and it cannot mark the right ones from a count.
 */
export interface FailedResubscription {
    /** The peer the subscription addressed, absent when it was taken out without a target. */
    peer?: string
    namespace: string
    event: string
    /** Why this one failed, verbatim - most often an RpcError whose code says whether the server no longer serves it or could not be asked. */
    error: unknown
}

/** One remote subscription this client holds, and what is known about restoring it. */
export interface HeldSubscription {
    remote?: string
    instanceName: string
    event: string
    projection?: unknown
    /** The peer serving it was reported gone. Cleared when a replay is accepted. */
    lost?: boolean
    /** Nothing is trying any more - see `resubscribeAbandoned`. Cleared by any fresh trigger. */
    abandoned?: boolean
}

/**
 * Refusals that will not change by being asked again, so asking again is only noise.
 *
 * `Forbidden` and `Unauthorized` are `authorize()` having ruled: a peer that retried them would be
 * repeatedly asking for what it has already been told it may not have, and every attempt lands in
 * somebody's audit log. `ClassNotFound` is a peer that no longer serves the namespace, which is a
 * decision about what it is rather than a moment it is having.
 *
 * Everything else is timing - a peer still booting, a broker that would not take the publish, a
 * mailbox that was full - and timing is exactly what a retry is for. Terminal *in kind*, not in
 * severity: this says nothing about how bad the refusal was, only about whether repeating the
 * question could produce a different answer.
 */
const terminalRefusal = (error: unknown) => {
    const code = (error as { code?: RpcErrorCode } | undefined)?.code
    return code === 'Forbidden' || code === 'Unauthorized' || code === 'ClassNotFound'
}

export class RpcClientHandler extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> implements RpcClientEmitter {
    responsePromiseMap = new Map<string, PromiseResolver<unknown>>()
    /** Tickets this peer is waiting on, and the rule about who may answer one. See Ticket.ts. */
    readonly tickets = new RpcTickets()
    responseTimeoutMap = new Map<string, NodeJS.Timeout>()
    /** Contract versions this client was built against, by namespace, declared on each call. */
    schemaVersions?: { [namespace: string]: string | undefined }
    /**
     * Send calls issued in one tick as one frame, rather than one frame each.
     *
     * **On by default.** A peer built before `BATCH` existed cannot answer one, so this is set
     * `false` to talk to such a peer - a property of the far end rather than of this caller.
     *
     * What it buys is bytes rather than round trips, and the distinction is worth keeping straight.
     * Calls issued concurrently are already pipelined, so twenty of them cost one round trip either
     * way - what they do not share is twenty envelopes, and on a POST moving a single number the
     * envelope is most of the frame. On MQTT it does save exchanges too, since each publish carries
     * its own topics and its own QoS acknowledgement.
     *
     * It cannot help a caller that awaits in a loop, because the second call is not issued until
     * the first has answered. That is not a limitation to fix here: it is why plural methods like
     * `rpcWrites` and the projection path list exist.
     */
    batchCalls = true

    /**
     * The most calls one frame may carry. Beyond it the flush sends several.
     *
     * A bound matters more than it looks, because the receiver may be a small embedded unit: a
     * frame has to be received and decoded *whole* before any of it can be dispatched, so an
     * unbounded batch is an unbounded buffer on a device that may have kilobytes. The mailbox bound
     * does not help - that limits what waits in a queue, and by then the frame has already been
     * held in memory and decoded.
     *
     * 64 costs almost nothing, because the saving saturates quickly. Batching N calls saves N-1
     * envelopes out of N, so sixteen already captures 94% of everything batching could ever save
     * and sixty-four captures 98%. Paying an unbounded memory cost on the far end for the last two
     * percent would be a poor trade even if every peer were a server.
     */
    maxBatchCalls = 64

    /** Calls waiting for the end of this tick, grouped by where they are going. */
    private readonly outbound = new Map<string, { payload: RpcMessage; settled: { resolve: () => void; reject: (e: unknown) => void } }[]>()
    private flushQueued = false

    /**
     * Hand a call to the transport, or hold it for the flush at the end of this tick.
     *
     * The promise settles when the *frame* is accepted, which is what the caller above needs to
     * know: it records the request as sent, or fails it as never having left.
     */
    private enqueueCall(payload: RpcMessage, remote: string | undefined): Promise<void> {
        if (!this.batchCalls) return this.sendPayload(payload, MessageType.RequestMessage, this.name, remote)
        return new Promise<void>((resolve, reject) => {
            const key = remote ?? ''
            const held = this.outbound.get(key)
            if (held) held.push({ payload, settled: { resolve, reject } })
            else this.outbound.set(key, [{ payload, settled: { resolve, reject } }])
            if (this.flushQueued) return
            this.flushQueued = true
            // A microtask rather than a timer: everything issued by one synchronous stretch of code
            // and by the promise callbacks it schedules travels together, and nothing waits on a
            // clock. A lone call is delayed by a microtask, which is not a delay anybody can time.
            queueMicrotask(() => this.flushCalls())
        })
    }

    private flushCalls() {
        this.flushQueued = false
        const groups = [...this.outbound.entries()]
        this.outbound.clear()
        const limit = Math.max(1, this.maxBatchCalls)
        for (const [key, held] of groups) {
            const remote = key === '' ? undefined : key
            for (let at = 0; at < held.length; at += limit) {
                const chunk = held.slice(at, at + limit)
                // One call goes as itself. Wrapping a single payload would spend the envelope this
                // exists to save, and would make every peer speak BATCH to talk to a batching
                // client - including the last chunk of a split, which may well be one call.
                const frame: RpcMessage =
                    chunk.length === 1 ? chunk[0].payload : ({ type: RpcMessageType.batch, payloads: chunk.map((one) => one.payload) } as RpcBatchPayload)
                this.sendPayload(frame, MessageType.RequestMessage, this.name, remote).then(
                    () => chunk.forEach((one) => one.settled.resolve()),
                    // The frame never left, so none of the calls in it did.
                    (e) => chunk.forEach((one) => one.settled.reject(e))
                )
            }
        }
    }

    /**
     * Remote subscriptions held by this client, replayed by resubscribe() after a reconnect.
     *
     * `lost` is set when the peer serving one was reported gone and cleared when a replay is
     * accepted, so a peer coming back knows which subscriptions to re-issue - and, more to the
     * point, which not to. MQTT emits `peerOnline` for every retained presence message rather than
     * on a transition, so this peer's own reconnect re-announces every peer it has ever seen;
     * without the flag that burst would replay every subscription a second time, and every replay
     * is answered with a full snapshot on the link least able to carry one.
     */
    subscriptions = new Map<string, HeldSubscription>()
    /**
     * Replays in flight, so a returning peer and a returning link do not both re-issue the same
     * subscribe. A skipped replay answers 0 rather than waiting for the one already running: the
     * count is what was restored by *this* call, and the caller that matters for it is the link.
     */
    private replayingAll = false
    private readonly replayingPeers = new Set<string>()
    /** Retry timers by subscription key, so one can be cancelled when its subscription goes. */
    private readonly retrying = new Map<string, NodeJS.Timeout>()
    /**
     * How hard to keep trying to restore a subscription a replay could not, before saying so and
     * stopping.
     *
     * A bound rather than forever, because a subscription that will never come back is otherwise a
     * permanent low-rate call loop against a peer that has done nothing wrong. Roughly two minutes
     * at these numbers, which covers the cases this exists for - a peer still booting when the
     * replay went out, and a gone/online pair a hub coalesced so no `peerOnline` ever fired - and
     * gives up on the ones it does not.
     */
    resubscribeRetry = { attempts: 8, baseMs: 1000, capMs: 30000 }
    eventEmitter: { [index: string]: unknown } = new EventEmitter() as unknown as { [index: string]: unknown }
    /**
     * What this peer has asked other peers to do. Supplied by whoever owns the handler where they
     * want an identity that exists before `ready()` - a screen binds to this while the link is still
     * being built - and made here otherwise.
     */
    readonly operations: RpcOperations

    constructor(
        name: string,
        sources?: GenericModule<unknown, unknown, Message, RpcMessage>[],
        public callTimeout = defaultCallTimeout,
        operations?: RpcOperations
    ) {
        super(name, sources)
        this.operations = operations ?? new RpcOperations()
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override async receive(message: Message<RpcMessage>, source?: string, target?: string) {
        const payload = message.payload
        if (!payload) return
        if (isEventMessage(payload)) {
            this.deliverEvent(payload, source)
            return
        }
        if (isTicketReply(payload)) {
            // A reply with no source has no peer to check against, and the check is the feature.
            if (!source) return
            // Only for a call this peer actually made, only from the peer it made it to. Both facts
            // are already held here, which is the point of the reply travelling as a reply: a
            // forged result has nothing to attach itself to. Refusals are reported rather than
            // dropped, because a rejected attempt is worth seeing and silence is not evidence.
            const accepted = this.tickets.deliver(payload.id, source, payload.outcome, payload.value, payload.error)
            if (!accepted && this.responsePromiseMap.has(payload.id))
                // The answer naming this ticket has not arrived yet, which an unordered transport
                // allows. Held, because the id is a call this peer has out.
                this.tickets.holdEarly(payload.id, source, payload.outcome, payload.value, payload.error)
            else if (!accepted) this.emit('ticketRefused', { id: payload.id, from: source })
            return
        }
        if (isSuccessResponse(payload)) {
            const pending = this.takePending(payload.id)
            if (!pending) return
            // A deferred method answers twice. This is the first: a correlation id and an expiry,
            // which become the ticket the caller holds while the work runs.
            const deferred = payload.deferred ? (payload.result as { id: string; expiresAt: number }) : undefined
            // A ticket is not a result, so the *call* succeeding is not the *operation* finishing.
            // The registry is handed the ticket's own promise rather than left to guess from the
            // shape of a value, because a remote method is free to return an object with an `id` and
            // an `expiresAt` and mean nothing by it - the same reason the server says `deferred`
            // rather than letting the client sniff for it.
            // Same reason as a ticket reply: a ticket whose target is unknown could be answered by
            // anyone, so an answer with no verifiable source is delivered as the plain result it
            // came as rather than hydrated into something that claims a guarantee it cannot make.
            if (deferred && source) {
                const ticket = this.tickets.open(deferred.id, source, deferred.expiresAt)
                this.deferring.set(payload.id, ticket.result)
                pending.resolve(ticket)
                return
            }
            pending.resolve(payload.result)
            return
        }
        if (isErrorResponse(payload)) {
            // Requires payload.id. A peer older than this fix sends errors without one, in which
            // case the call can only be settled by its timeout.
            this.takePending(payload.id)?.reject(new RpcError(payload.code, payload.error?.message, payload.error?.stack))
        }
    }

    /**
     * Routes an event to the handlers registered for that peer and that instance, rather than to
     * everything listening for the name.
     */
    /**
     * The seq/epoch stamp of the delivery currently in a handler's hands, when the emitting server
     * tracks the event. Set before the handlers run and meaningful only *during* one, read
     * synchronously - deliveries do not interleave within one client, so a handler that reads it
     * on its first line reads its own stamp. The alternative was widening every handler signature,
     * which would have broken each of them for the benefit of the one watcher that wants this.
     */
    lastDeliveredStamp?: { peer: string; namespace?: string; event: string; seq: number; epoch: string }

    private deliverEvent(payload: RpcEventPayload, source?: string) {
        this.lastDeliveredStamp =
            payload.seq !== undefined && payload.epoch
                ? { peer: source ?? '', ...(payload.path ? { namespace: payload.path } : {}), event: payload.event, seq: payload.seq, epoch: payload.epoch }
                : undefined
        // Held in a local so the narrowing survives into the delivery callbacks below.
        const emitter = this.eventEmitter
        if (emitter instanceof EventEmitter) {
            const from = source ?? ''
            const keys = payload.path
                ? [subscriptionKey(from, payload.path, payload.event), subscriptionKey('', payload.path, payload.event)]
                : // A peer that does not name the emitting instance: deliver to every subscription
                  // for this event whose peer matches, whatever namespace it was taken out on.
                  emitter
                      .eventNames()
                      .filter((name): name is string => typeof name === 'string')
                      .filter((name) => {
                          const [keySource, , keyEvent] = name.split('\u0000')
                          return keyEvent === payload.event && (keySource === from || keySource === '')
                      })
            for (const key of new Set(keys)) this.deliverSafely(() => emitter.emit(key, ...payload.params), payload)
        }
        // The handler's own emitter stays keyed by name: it is a firehose of everything this client
        // receives, and its consumers read the path off the payload.
        this.deliverSafely(() => this.emit(payload.event, payload.params), payload)
    }

    /**
     * Run one subscriber without letting it unwind into the transport that delivered the event.
     *
     * These are application callbacks reached from a transport's inbound loop, so a handler that
     * threw propagated all the way back out and became an unhandled rejection - one subscriber's
     * bug ending the process for everything else the client was doing.
     */
    private deliverSafely(deliver: () => void, payload: RpcEventPayload) {
        try {
            deliver()
        } catch (e) {
            this.emit('subscriberError', { event: payload.event, path: payload.path, error: e })
        }
    }

    /**
     * Mark a peer's subscriptions as no longer served, because that peer has gone or been
     * displaced. Nothing is re-issued here - the peer is not there to answer - and the flag is
     * what tells a later `peerOnline` that these are the ones worth replaying.
     */
    markLost(peer: string) {
        for (const [key, subscription] of this.subscriptions) {
            if (subscription.remote !== peer) continue
            subscription.lost = true
            // Whatever a retry chain was in the middle of, it was asking a peer that has since
            // gone. Its return is the trigger that matters now, and that replays these itself.
            this.stopRetrying(key)
        }
    }

    /**
     * Re-issue remote subscriptions this client holds. Called on two different returns, and the
     * difference between them is the whole reason this takes an argument.
     *
     * **The link returns.** Called with no peer: everything is replayed. If the server kept its
     * state the calls are no-ops on its side, and if it restarted they rebuild it; either way the
     * outgoing frames re-identify this client, which is what makes server-pushed events
     * addressable again.
     *
     * **A peer returns.** Called with its name, and this is the case that used to have no answer
     * at all. Behind a bus the observed peer can restart without the observer's link being touched
     * - no `disconnected`, no `connected` - so nothing replayed, the revived peer held no
     * subscription, and the channel sat `stale` for ever holding a pre-restart value while
     * `peerOnline` went past with nothing keyed to it. Only subscriptions `markLost` flagged are
     * re-issued, because a replay is answered with a full snapshot and re-sending one nobody lost
     * spends the link for nothing.
     *
     * The residual hole, worth knowing about rather than discovering: `peerOnline` is a transition
     * on socket.io and SignalR, so a gone/online pair a hub coalesces produces no event and nothing
     * here fires. That case belongs to a retry over `resubscribeFailed`, not to this.
     */
    async resubscribe(peer?: string) {
        if (peer === undefined) {
            if (this.replayingAll) return 0
            this.replayingAll = true
            try {
                return await this.replay(undefined)
            } finally {
                this.replayingAll = false
            }
        }
        // The link-wide replay covers every peer, so a burst arriving underneath it has nothing to add.
        if (this.replayingAll || this.replayingPeers.has(peer)) return 0
        this.replayingPeers.add(peer)
        try {
            return await this.replay(peer)
        } finally {
            this.replayingPeers.delete(peer)
        }
    }

    private async replay(peer: string | undefined) {
        const held = [...this.subscriptions.entries()].filter(([, subscription]) => peer === undefined || (subscription.remote === peer && subscription.lost))
        if (!held.length) return 0
        // A link back or a peer back is a fresh reason to ask, so anything a retry chain had given
        // up on is in scope again, and any chain still running is superseded by this pass.
        // Abandonment means "this peer stopped asking on its own", never "never again": a restarted
        // peer is a new incarnation, and the refusal may have gone with the process that made it.
        for (const [key, subscription] of held) {
            subscription.abandoned = false
            this.stopRetrying(key)
        }
        const results = await Promise.allSettled(held.map(([, subscription]) => this.issue(subscription)))
        const failed: FailedResubscription[] = []
        results.forEach((result, index) => {
            const [key, subscription] = held[index]
            // Accepted, so it is being served again. A refusal leaves the flag set, which is what
            // lets a retry find it later without having to remember anything of its own.
            if (result.status === 'fulfilled') {
                subscription.lost = false
                return
            }
            failed.push(this.describeFailure(subscription, result.reason))
            this.afterFailure(key, subscription, result.reason, 0)
        })
        if (failed.length) this.emit('resubscribeFailed', failed)
        return results.length - failed.length
    }

    /** The subscribe frame itself, carrying the projection when there is one. One shape, two callers. */
    private issue(subscription: HeldSubscription) {
        return subscription.projection === undefined
            ? this.call(subscription.remote, subscription.instanceName, 'on', subscription.event)
            : this.call(subscription.remote, subscription.instanceName, 'on', subscription.event, subscription.projection)
    }

    private describeFailure(subscription: HeldSubscription, error: unknown): FailedResubscription {
        return { peer: subscription.remote, namespace: subscription.instanceName, event: subscription.event, error }
    }

    /** Terminal in kind gives up now; anything else is timing, and timing is what a retry is for. */
    private afterFailure(key: string, subscription: HeldSubscription, error: unknown, attempt: number) {
        if (terminalRefusal(error)) this.abandon(key, subscription, error)
        else this.scheduleRetry(key, subscription, attempt)
    }

    private scheduleRetry(key: string, subscription: HeldSubscription, attempt: number) {
        const { attempts, baseMs, capMs } = this.resubscribeRetry
        if (attempt >= attempts) {
            this.abandon(key, subscription, new RpcError('TransportError', `gave up restoring ${subscription.instanceName}.${subscription.event} after ${attempts} attempts`))
            return
        }
        const window = Math.min(baseMs * 2 ** attempt, capMs)
        // Half fixed and half random: a hundred observers of one peer would otherwise ask again in
        // the same millisecond, which is the herd a replay already risks without help.
        const timer = setTimeout(() => void this.retry(key, subscription, attempt), Math.round(window / 2 + Math.random() * (window / 2)))
        timer.unref?.()
        this.retrying.set(key, timer)
    }

    private async retry(key: string, subscription: HeldSubscription, attempt: number) {
        this.retrying.delete(key)
        // Dropped while this waited - off(), close(), or a refused subscribe unwinding - so there
        // is nothing to restore and nobody left to restore it for.
        if (this.subscriptions.get(key) !== subscription) return
        try {
            await this.issue(subscription)
            subscription.lost = false
        } catch (error) {
            // Deliberately quiet between the first failure and giving up. `resubscribeFailed`
            // already named this subscription and a consumer has already marked its values stale;
            // eight more of the same event would say nothing it does not know, and the fact worth
            // reporting is the one at the end.
            this.afterFailure(key, subscription, error, attempt + 1)
        }
    }

    /**
     * Stop trying, and say so. `stale` means the freshness is unknown; this means nobody is
     * working on it any more, and collapsing those two into one status would leave an operator
     * waiting for a repair that is not coming.
     */
    private abandon(key: string, subscription: HeldSubscription, error: unknown) {
        this.stopRetrying(key)
        subscription.abandoned = true
        // A list of one, so a consumer can handle this with the same code as `resubscribeFailed` -
        // and for that event's own reason: what a shadow copy needs is which subscriptions, never
        // how many.
        this.emit('resubscribeAbandoned', [this.describeFailure(subscription, error)])
    }

    private stopRetrying(key: string) {
        const timer = this.retrying.get(key)
        if (timer === undefined) return
        clearTimeout(timer)
        this.retrying.delete(key)
    }

    /**
     * Reject every in-flight call. A reply to a call that was in flight when the link dropped can
     * no longer reach us, so failing now beats making every caller wait out the full timeout.
     *
     * How it failed depends on whether the request got out. One that never left cannot have run, and
     * `TransportError` says so; one that was published and never answered may have run, and only
     * `UnknownOutcome` is true of it. Reporting both the same way was the library telling callers
     * that a command had failed when what it knew was that it had lost track of it.
     */
    failPendingCalls(reason: string) {
        for (const id of [...this.responsePromiseMap.keys()]) {
            const sent = this.sentRequests.has(id)
            this.sentRequests.delete(id)
            this.takePending(id)?.reject(
                sent
                    ? new RpcError('UnknownOutcome', `${reason}, after the request was sent - it may or may not have run`)
                    : new RpcError('TransportError', `${reason}, before the request was sent`)
            )
        }
    }

    /**
     * Requests this client handed to a transport without it complaining.
     *
     * Not proof of delivery - nothing here can have that - but proof that the frame left, which is
     * the line between a command that certainly did not run and one that might have.
     */
    private sentRequests = new Set<string>()

    /**
     * The ticket promise for a call that answered with one, held between the success branch that
     * opened it and the resolve wrapper that hands it to the registry.
     *
     * Deleted on the way through rather than left, since a peer that defers a great deal would
     * otherwise accumulate one entry per call for the life of the process.
     */
    private readonly deferring = new Map<string, Promise<unknown>>()

    /** Detach a pending call and cancel its timeout. Returns undefined if it already settled. */
    private takePending(id: string | undefined) {
        if (id === undefined) return undefined
        const promise = this.responsePromiseMap.get(id)
        this.responsePromiseMap.delete(id)
        this.sentRequests.delete(id)
        const timeout = this.responseTimeoutMap.get(id)
        if (timeout !== undefined) {
            clearTimeout(timeout)
            this.responseTimeoutMap.delete(id)
        }
        return promise
    }

    /**
     * Call a method on the RPC server.
     * @param method The method to call.
     * @param additionalParameter The (optional) additionalParameter to include. See the JsonRpc class for more details.
     * @param params
     */
    public call(remote: string | undefined, instanceName: string, method: string, ...params: unknown[]): Promise<unknown> {
        return this.callWith({}, remote, instanceName, method, ...params)
    }

    /**
     * Call with per-call options. `call` is this with none.
     *
     * The only option so far is the idempotency key, which is the one thing a caller can say that
     * the library cannot work out for itself: whether this is a new command or another go at one it
     * has already sent.
     */
    public callWith(options: RpcCallOptions, remote: string | undefined, instanceName: string, method: string, ...params: unknown[]): Promise<unknown> {
        const timeoutMs = options.timeoutMs ?? this.callTimeout
        // Refused rather than clamped or rounded: a negative, fractional or infinite timeout is a
        // caller holding the option wrong, and a silently adjusted deadline is the kind of help
        // that surfaces two layers away as a call timing out at a number nobody wrote.
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0)
            return Promise.reject(new Error(`${instanceName}.${method}: timeoutMs must be a finite non-negative integer, not ${String(options.timeoutMs)}`))
        const payload: RpcCallInstanceMethodPayload = {
            id: uuidv4(),
            type: RpcMessageType.CallInstanceMethod,
            path: instanceName,
            method,
            params,
            version: this.schemaVersions?.[instanceName],
            // The same number that arms the timer below, so what the far end is told is exactly
            // what this caller is going to do. A request carrying no ttl is one with no deadline,
            // which is what a caller that has disabled its timeout is asking for.
            //
            // Which makes zero a dangerous number for anything that ever *computes* what is left of
            // a budget rather than reading what a caller declared. Nothing does today, and this is
            // the line where that would break: a remaining budget spent down to zero would travel
            // as no deadline at all, so the call with no time left becomes the one that may run for
            // ever - the exact inversion of the rule it was trying to keep. Such a thing has to
            // floor above zero and fail locally instead.
            ttl: timeoutMs > 0 ? timeoutMs : undefined,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            ...(options.ownerEpoch ? { fence: { ownerEpoch: options.ownerEpoch } } : {})
        }
        // Written down before anything is sent, so a call that never leaves is still a call this
        // peer made. `callWith` is the single funnel - a client's calls, a server-acting-as-caller's
        // and a component channel's all arrive here - which is why one hook covers every one of them
        // and why there is no wire change anywhere in this.
        //
        // Deliberately not `params`: an `untap(token)` argument is a bearer capability, and a
        // peer-wide store holding one would hand every screen in the process a read surface that
        // `authorize()` was protecting on the way in.
        this.operations.record({
            id: payload.id,
            ...(remote !== undefined ? { target: remote } : {}),
            namespace: instanceName,
            method,
            ...(options.semantics !== undefined ? { semantics: options.semantics } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            ...(timeoutMs > 0 ? { deadlineMs: timeoutMs } : {}),
            issuedAt: Date.now(),
            status: 'issued'
        })
        return new Promise((resolve, reject) => {
            // Registered before sending: a response can arrive before sendPayload's promise settles.
            //
            // Wrapped rather than recorded at each of the four places a call can settle - a reply, a
            // refusal, the local timer, the link dropping. Those are the paths that get added to, and
            // one that forgot to tell the registry would leave a tray showing a command still in
            // flight for ever, which is worse than not having the tray.
            this.responsePromiseMap.set(payload.id, {
                resolve: (value: unknown) => {
                    this.operations.resolved(payload.id, Date.now(), this.deferring.get(payload.id))
                    this.deferring.delete(payload.id)
                    resolve(value)
                },
                reject: (error: unknown) => {
                    this.deferring.delete(payload.id)
                    this.operations.rejected(payload.id, Date.now(), error)
                    reject(error)
                }
            })
            // No timer at all when the timeout is zero. setTimeout(..., 0) is not "never" - it is
            // "next tick", so a disabled timeout was an instant one: the ttl was correctly omitted
            // from the wire while the local timer fired before the reply could possibly arrive.
            if (timeoutMs > 0)
                this.responseTimeoutMap.set(
                    payload.id,
                    setTimeout(() => {
                        // A timeout is an unknown outcome by definition: the request went out, and
                        // nothing came back. Kept as Timeout because that names *why* nothing is known,
                        // which is more use than the general case - but a caller reading it should treat
                        // a command as possibly done. There is a note about this in the README.
                        this.takePending(payload.id)?.reject(new RpcError('Timeout', `no response to ${instanceName}.${method} within ${timeoutMs} ms`))
                    }, timeoutMs)
                )
            this.enqueueCall(payload, remote).then(
                () => {
                    // Recorded only once the transport has accepted it, and only while the call is
                    // still pending - a reply may well have arrived and settled it already.
                    if (this.responsePromiseMap.has(payload.id)) this.sentRequests.add(payload.id)
                    this.operations.sent(payload.id, Date.now())
                },
                (e) => {
                    // It never left, so whatever it would have done, it did not.
                    this.takePending(payload.id)?.reject(new RpcError('TransportError', e instanceof Error ? e.message : String(e)))
                }
            )
        })
    }

    /**
     * Create a proxy object - a sort of wrapper for calling methods and listening for events.
     * @param name Name of an existing instance on the server instance. If in the form "name: Class" an instance of type Class will be created
     * on the server if it does not already exist.
     */
    proxy<T>(name: string, remote?: string, options: RpcCallOptions = {}): T & WithOptions<T> {
        const proxyObj: { [index: string]: unknown } = {}
        return new Proxy(proxyObj, {
            get: (target, prop) => {
                let result: unknown
                if (typeof prop === 'string') {
                    if (target[prop]) {
                        return target[prop]
                    } else if (prop === 'then') {
                        // Undefined, so this is not a thenable. `proxy()` is async and hands one of
                        // these back, and `await` probes whatever it is given for `then` - without
                        // this the trap answers with a caller for a remote method named `then`, the
                        // runtime treats the proxy as a promise and adopts it, and the await never
                        // settles because nothing on the far end is ever going to answer. Every call
                        // in the library hung on this the moment `proxy()` stopped wrapping its
                        // result in a plain object.
                        //
                        // The cost is that `then` joins `$with` as a name a remote class cannot
                        // expose. That is inherent rather than incidental: an object you await
                        // cannot also have a method called `then`.
                        return undefined
                    } else if (prop === '$with') {
                        // The one name on a proxy that is not a remote method: it returns another
                        // proxy for the same instance whose calls carry these options. Prefixed with
                        // `$` because everything else here is whatever the far end happens to expose,
                        // and a collision would silently shadow a real method.
                        target[prop] = (callOptions: RpcCallOptions) => this.proxy<T>(name, remote, { ...options, ...callOptions })
                    } else if (isEventFunction(prop)) {
                        target[prop] = (...args: unknown[]) => {
                            const event = args[0]
                            // Set for `on` only: undoes the local half when the far end refuses the
                            // subscribe. Both halves go on *before* the call, deliberately - the
                            // server attaches its listener before answering with a snapshot, so a
                            // handler registered after the reply could miss an update that landed
                            // between them - which leaves rolling back as the only way to keep a
                            // refused subscribe from leaving one behind.
                            let unwind: (() => void) | undefined
                            if (typeof event === 'string') {
                                // Registered against this peer and this namespace, so a name shared
                                // with another instance does not deliver to both.
                                const key = subscriptionKey(remote ?? '', name, event)
                                ;(this.eventEmitter[prop] as (...args: unknown[]) => void)(key, ...args.slice(1))
                                // 'on' is the only form the server holds state for, so it is the
                                // only one worth replaying after a reconnect.
                                // The projection rides with it, so a reconnect re-subscribes to the
                                // same narrowing. Replaying without it would quietly restore the
                                // whole snapshot on the one link that cannot carry it, and nothing
                                // would report the widening - the values would simply all be there.
                                if (prop === 'on') {
                                    this.subscriptions.set(key, { remote, instanceName: name, event, projection: args[2] })
                                    unwind = () => {
                                        const emitter = this.eventEmitter as unknown as EventEmitter
                                        emitter.removeListener(key, args[1] as (...handled: unknown[]) => void)
                                        // Only when nothing local is left. A second observer's
                                        // refused subscribe must not delete the entry the first
                                        // one's live subscription is replayed from - the same
                                        // reference count `off` reads, for the same reason.
                                        if (emitter.listenerCount(key) === 0) this.subscriptions.delete(key)
                                    }
                                } else if (prop === 'off' || prop === 'removeListener') {
                                    // The remote subscription is one per key; the local emitter may
                                    // hold several handlers under it. The emitter's own listener
                                    // count is the reference count, so removing one handler while
                                    // others remain must not unsubscribe them all remotely - which
                                    // is exactly what it used to do, and the first component or
                                    // console pane to leave took the feed away from the rest.
                                    const emitter = this.eventEmitter as unknown as EventEmitter
                                    if (emitter.listenerCount(key) > 0) return Promise.resolve('ok - other local handlers remain')
                                    this.subscriptions.delete(key)
                                    // Nothing wants it any more, so a retry chain still working on
                                    // it is asking on behalf of nobody.
                                    this.stopRetrying(key)
                                }
                            } else {
                                // removeAllListeners, setMaxListeners and friends take no event.
                                ;(this.eventEmitter[prop] as (...args: unknown[]) => void)(...args)
                            }
                            // args[2] is the component projection, when the caller named one. The
                            // handler at args[1] is local and never travels.
                            const issued = prop === 'on' && args[2] !== undefined ? this.call(remote, name, prop, args[0], args[2]) : this.call(remote, name, prop, args[0])
                            const rollback = unwind
                            if (!rollback) return issued
                            return issued.catch((error: unknown) => {
                                rollback()
                                throw error
                            })
                        }
                    } else {
                        target[prop] = (...args: unknown[]) => this.callWith(options, remote, name, prop as string, ...args)
                    }
                    result = target[prop]
                }
                return result
            }
        }) as T & WithOptions<T>
    }
}
