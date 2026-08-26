import { EventEmitter } from 'events'
import { GenericModule, PeerRegistry, Transport, TransportEvent } from './RPC/Core.js'
import { MessageSigner, type TrustedCertificateAuthority } from './RPC/Auth.js'
import { RpcSchema } from './RPC/Schema.js'
import { defaultWebSocketPort, IManageRpc } from './RPC/Rpc.js'
import { RpcOperations } from './RPC/Operations.js'
import { defaultCallTimeout, RpcClientHandler, type WithOptions } from './RPC/RpcClientHandler.js'
import {
    ComponentChannels,
    componentFacade,
    type ComponentProps,
    type ComponentState,
    type RpcComponentChannelOptions,
    type RpcComponentLike,
    type RpcComponentOptions,
    type RpcComponentProxy,
    type RpcComponentView
} from './RPC/ComponentClient.js'
import { restorable, snapshotKey } from './RPC/Snapshots.js'
import { contextNamespace, type ContextWireSnapshot } from './RPC/Context.js'
import type { RemoteSurface } from './RPC/Invocation.js'
import type { IClientOptions } from 'mqtt'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { settledAfterSweeps } from './Transports/Presence.js'
import { codecFor } from './RPC/Codec.js'
import { readableName } from './Utilities/ReadableName.js'

export interface RpcClientOptions {
    name: string
    /** Supply one to take full control of the link. When absent init() builds one from the url. */
    transport?: Transport
    defaultTarget?: string
    useMsgPack: boolean
    /** How long a call waits for a response before rejecting with an RpcError of code 'Timeout'. */
    callTimeout: number
    /**
     * Send calls issued in one tick as one frame instead of one frame each. **On by default.**
     *
     * It saves bytes rather than round trips, and the difference is worth keeping straight: calls
     * issued concurrently are already pipelined, so twenty of them cost one round trip either way,
     * but twenty envelopes for twenty numbers is most of the traffic. On MQTT it saves exchanges
     * too, each publish carrying its own topics and its own acknowledgement. It cannot help a
     * caller awaiting in a loop - nothing at this layer can, which is what plural methods are for.
     *
     * Set it `false` to talk to a peer built before `BATCH` existed, which cannot answer one. That
     * is the only reason to, and it is a property of the far end rather than of this caller.
     */
    batchCalls?: boolean
    /** How long ready() waits for the transport to connect before throwing. 0 waits forever. */
    readyTimeout: number
    /** Reject in-flight calls as soon as the link drops instead of waiting out their timeouts. */
    failCallsOnDisconnect: boolean
    /**
     * How this client's component channels behave beyond being open: whether to stop listening
     * while the peer is inactive, and how long to hold a channel after its last observer leaves.
     * Both off by default - see `RpcComponentChannelOptions`.
     */
    components?: RpcComponentChannelOptions
    /**
     * Credentials presented when connecting to a server that authenticates. Passed to socket.io as
     * the handshake `auth` payload, and to MQTT as broker connect options. When the server
     * authenticates, `name` must match the identity these credentials resolve to - the server
     * drops frames whose source does not match.
     */
    credentials?: unknown
    /**
     * Sign outgoing frames. Only meaningful for MQTT, where there is no connection for a server to
     * authenticate and the source field would otherwise be an unverifiable claim.
     */
    sign?: MessageSigner
    /**
     * The contract this client was built against. Its per-namespace versions are declared on each
     * call so a server can tell a genuinely stale caller from one sending rubbish.
     */
    schema?: RpcSchema
    /**
     * Connect to an `https://`, `wss://` or `mqtts://` peer without checking its certificate.
     *
     * Deliberately unsafe, and off: anything able to answer on that address can then read and
     * rewrite everything this client sends, which over this library means industrial commands. It
     * exists for a development server with a self-signed certificate. A plant with its own
     * certificate authority should pass the CA in `credentials` instead, which keeps verification
     * on rather than switching it off.
     */
    allowInsecureTls?: boolean
    /**
     * A certificate authority to trust, on top of the system ones, when dialling an `https://`,
     * `wss://` or `mqtts://` peer.
     *
     * This is the answer for a plant that issues its own certificates, and it is the one to reach
     * for before `allowInsecureTls`: verification stays on, so a server presenting anything this
     * does not vouch for is still refused.
     */
    ca?: TrustedCertificateAuthority
}

/**
 * What `proxy()` hands back: the remote instance itself, plus `$with` for the options a caller can
 * attach to a call - an idempotency key, so far. `$with` returns another proxy for the same instance
 * rather than changing this one, so options never leak into calls that did not ask for them.
 *
 * It used to be a record - `{ name, target?, remote }` - and every call went through `.remote`. The
 * wrapper carried two fields nothing ever read, and an optional `remote` that could not be absent,
 * so the cost of it was an assertion at every call site and a word in front of every method. Calling
 * a remote method now reads like calling a local one, which was the point of the library.
 *
 * The one name this reserves is `$with`. A class with a method of that name cannot be proxied - true
 * of the inner proxy before this change too, but now it is the whole of the surface rather than a
 * detail one level down.
 */
export type RpcProxy<T> = RemoteSurface<T> & WithOptions<RemoteSurface<T>>

/**
 * Emits the TransportEvent lifecycle events - connected and disconnected for the link itself, and
 * peerOnline, peerGone and peerDisplaced for the peers on it - so an application can show link and
 * peer state instead of inferring either from failed calls.
 */
export class RpcClient extends EventEmitter {
    /**
     * What this peer has asked other peers to do, and how each of those turned out.
     *
     * Owned here rather than by the handler, so it exists from construction: the handler is built in
     * `init()`, and a screen binding to a tray does so while the link is still being made. It is the
     * same object either way - `callWith` is the only thing that writes to it.
     */
    readonly operations = new RpcOperations()
    rpcClient?: RpcClientHandler
    manageRpc?: IManageRpc
    readyFlag = false
    /** Peer name -> module, shared by this client's modules and nothing outside them. */
    readonly peers = new PeerRegistry()
    // No transport here: constructing one in a field initialiser opened a socket on every client
    // that init() then replaced and orphaned, leaving it reconnecting forever.
    options: RpcClientOptions = {
        // Readable rather than a UUID: this name is what a peer list shows, what a log line blames
        // and, over MQTT, the broker's client id.
        name: readableName(),
        defaultTarget: '*',
        useMsgPack: true,
        callTimeout: defaultCallTimeout,
        readyTimeout: 30000,
        failCallsOnDisconnect: true
    }
    constructor(
        public url?: string,
        options: Partial<RpcClientOptions> = {}
    ) {
        super()
        this.options = { ...this.options, ...options }
        // init() is async and the constructor cannot await it, so its rejection was unhandled -
        // and Node ends the process on one of those. A bad url, an unreachable broker or a name the
        // transport refuses took the whole application down from a constructor. Kept instead, so
        // ready() can report the real cause rather than timing out with nothing to say.
        void this.init().catch((e) => {
            this.initError = e
            this.emit('initError', e)
        })
    }
    /** Why init() failed, rethrown by ready() so the caller sees the cause and not a timeout. */
    private initError?: unknown
    async close() {
        // Stores are told 'closed' rather than left waiting on a link that is gone; the server at
        // the far end reaps a departed subscriber, so local teardown is all that is owed.
        this.componentChannels?.closeAll()
        this.rpcClient?.failPendingCalls('client closed')
        this.rpcClient?.subscriptions.clear()
        await this.rpcClient?.close()
        await this.options.transport?.close()
        this.peers.clear()
        this.readyFlag = false
    }
    async init() {
        // A caller-supplied transport is honoured. It used to be overwritten unconditionally, so
        // passing one had no effect at all.
        let transport = this.options.transport
        if (!transport) {
            const socketOptions = {
                ...(this.options.credentials ? { auth: this.options.credentials as { [key: string]: unknown } } : {}),
                // The socket.io typings narrow `ca` to a string, while the runtime takes what Node's
                // tls does. Passing the bytes of a PEM is the ordinary thing readFileSync gives you.
                ...(this.options.ca ? { ca: this.options.ca as unknown as string } : {})
            }
            if (this.url?.startsWith('http') || this.url?.startsWith('ws'))
                transport = new SocketIoClientTransport(this.options.name, this.url, undefined, socketOptions, true, this.options.allowInsecureTls)
            else if (this.url?.startsWith('mqtt')) {
                // Imported on demand so a browser bundle that only speaks WebSocket does not have
                // to carry the MQTT client. Bundlers split this into a chunk fetched only when an
                // mqtt:// url is actually used.
                const { MqttTransport } = await import('./Transports/MqttTransport.js')
                transport = new MqttTransport(this.options.name, this.url, {
                    mqtt: {
                        ...((this.options.credentials ?? {}) as IClientOptions),
                        ...(this.options.ca ? { ca: this.options.ca as IClientOptions['ca'] } : {})
                    },
                    sign: this.options.sign,
                    allowInsecureTls: this.options.allowInsecureTls
                })
            } else transport = new SocketIoClientTransport(this.options.name, `http://localhost:${defaultWebSocketPort}`, undefined, socketOptions, true, this.options.allowInsecureTls)
        }
        this.options.transport = transport
        // The transport encodes, so there is no converter between it and the handler. A structured
        // wire format such as MQTT 5 needs to see the message, not bytes a converter already flattened.
        transport.codec = codecFor(this.options.useMsgPack)
        this.rpcClient = new RpcClientHandler(this.options.name, [transport], this.options.callTimeout, this.operations)
        this.rpcClient.batchCalls = this.options.batchCalls ?? true
        if (this.options.schema)
            this.rpcClient.schemaVersions = Object.fromEntries(
                Object.entries(this.options.schema.namespaces).map(([namespace, described]) => [namespace, described.version])
            )
        this.rpcClient.pipe(transport)
        for (const module of [transport, this.rpcClient]) module.usePeerRegistry(this.peers)
        this.wireTransportLifecycle(transport)
        this.readyFlag = true
        // Built directly instead of via proxy(), which awaits ready(). init() is not awaited by
        // the constructor, so a ready() rejection here would surface as an unhandled rejection.
        // The proxy is inert until a call is made, so there is nothing to wait for.
        this.manageRpc = this.rpcClient.proxy<IManageRpc>('manageRpc', this.options.defaultTarget)
        await this.options.transport.open()
    }

    /**
     * React to the link coming and going. On reconnect the subscriptions are replayed, which both
     * restores server-side state and re-identifies this client so pushed events can reach it again.
     */
    private wireTransportLifecycle(transport: GenericModule) {
        transport.on(TransportEvent.disconnected, (reason: string) => {
            if (this.options.failCallsOnDisconnect) this.rpcClient?.failPendingCalls(`transport disconnected: ${reason ?? 'unknown reason'}`)
            this.emit(TransportEvent.disconnected, reason)
        })
        transport.on(TransportEvent.connected, () => {
            // No-op on the first connect, when nothing has been subscribed yet.
            this.rpcClient
                ?.resubscribe()
                .then((restored) => this.emit(TransportEvent.connected, { restoredSubscriptions: restored }))
                // Not 'error': an EventEmitter throws on an unhandled 'error' event.
                .catch((e) => this.emit('resubscribeError', e))
        })
        // The other return, and the one nothing used to answer. Behind a bus an observed peer can
        // restart without this link being touched, so `connected` above never fires and its replay
        // never runs: the revived peer holds no subscription, and every channel watching it sits
        // `stale` for ever with a pre-restart value. Noting the loss and replaying on the return
        // costs one subscribe and one targeted snapshot per component, which is the repair.
        for (const event of [TransportEvent.peerGone, TransportEvent.peerDisplaced]) transport.on(event, (peer: string) => this.rpcClient?.markLost(peer))
        transport.on(TransportEvent.peerOnline, (peer: string) => {
            // Not 'error': an EventEmitter throws on an unhandled 'error' event.
            void this.rpcClient?.resubscribe(peer).catch((e) => this.emit('resubscribeError', e))
        })
        // Forwarded so a consumer aimed at one named peer can tell "the link is up but that peer is
        // gone" from "the whole link is down" - connected/disconnected alone cannot say which, and
        // the difference is what separates a stale view of a device from a dead network. peerShape
        // rides along for the caches: a peer that changed surface is worth re-describing on next use.
        // Registered after the recovery above, so an application reacting to a peer's return finds
        // the replay already issued rather than a view still marked stale.
        for (const event of [TransportEvent.peerOnline, TransportEvent.peerGone, TransportEvent.peerDisplaced, TransportEvent.peerShape])
            transport.on(event, (...args: unknown[]) => this.emit(event, ...args))
    }

    async ready() {
        const deadline = Date.now() + this.options.readyTimeout
        while (!this.options.transport?.readyFlag || !this.readyFlag) {
            // Checked every turn, not just once: init() is still running when ready() is first
            // called, so the failure usually arrives while this loop is already waiting.
            if (this.initError !== undefined)
                throw new Error(`RpcClient '${this.options.name}': could not start: ${this.initError instanceof Error ? this.initError.message : String(this.initError)}`, {
                    cause: this.initError
                })
            if (this.options.readyTimeout > 0 && Date.now() > deadline)
                throw new Error(`RpcClient '${this.options.name}': transport not ready within ${this.options.readyTimeout} ms`)
            await new Promise((res) => setTimeout(res, 10))
        }
    }
    async proxy<T>(name: string, target?: string): Promise<RpcProxy<T>> {
        await this.ready()
        // ready() returns only once init() has set readyFlag, and init() creates the handler before
        // it does - so this cannot be missing here. Thrown rather than asserted away, because the
        // alternative is returning something that is not a proxy at all.
        if (!this.rpcClient) throw new Error(`RpcClient '${this.options.name}': ready, but no handler - this is a bug in the library`)
        return this.rpcClient.proxy<T>(name, target ? target : this.options.defaultTarget) as RpcProxy<T>
    }

    /**
     * ready(), and then the first presence sweep: the retained presence read on MQTT, the
     * announced list delivered on socket.io. ready() means the link is up, not that anyone has
     * been heard from - asking who is there immediately finds an empty network on a bus that is
     * plainly there, which is why every script used to carry the same poll-for-peers loop.
     *
     * Settled means exactly that the first sweep arrived, not that every peer that will ever
     * exist has: a peer that joins a second from now still appears a second from now, and a
     * network with nobody on it settles empty. `waitMs` bounds the wait and then resolves rather
     * than throws - the names known at the bound are still worth more than an error.
     *
     * Returns the peer names known at that moment, this client's own excluded.
     */
    async peersSettled(waitMs = 2000): Promise<string[]> {
        await this.ready()
        await settledAfterSweeps([this.options.transport].filter(Boolean), waitMs)
        return this.peers.names().filter((name) => name !== this.options.name)
    }

    /** Created on the first component() call; every channel this client holds lives in it. */
    private componentChannels?: ComponentChannels

    /**
     * An observable component: the ordinary typed proxy plus cached, read-only `props` and `state`,
     * and a store under the `rpcComponent` symbol carrying status and change notification.
     *
     * Resolves after the first authorized snapshot has been accepted, so the reads are synchronous
     * from the first line that can execute. Repeated calls for one (target, namespace) share a
     * channel and one remote subscription; each call owes one `store.close()`.
     */
    async component<T extends RpcComponentLike>(name: string, target?: string, options?: RpcComponentOptions): Promise<RpcComponentProxy<T>> {
        await this.ready()
        if (!this.rpcClient) throw new Error(`RpcClient '${this.options.name}': ready, but no handler - this is a bug in the library`)
        // Wired to this client's own forwarded lifecycle, which is what turns "the link is up but
        // that peer is gone" into a stale channel instead of a frozen number.
        this.componentChannels ??= new ComponentChannels(this.rpcClient, this, this.options.components)
        const channel = await this.componentChannels.open(name, target ? target : this.options.defaultTarget, options?.paths)
        return componentFacade(channel, channel.inner) as RpcComponentProxy<T>
    }

    /**
     * The last snapshot this page saw of a component, from before it was reloaded - values, and the
     * age they carry, drawn while the live one is still on its way.
     *
     * A separate call rather than a mode on `component()`, deliberately. `component()` resolves only
     * on an accepted snapshot and that promise is worth keeping, so this hands back a plain view and
     * no proxy at all: nothing on it can be called, nothing about it can be mistaken for current.
     * The status is **always** `stale`, `receivedAt` is the age the values actually had, and
     * `staleSince` is when the record was written rather than when this page started - "stale since
     * I reloaded" would understate it by however long the machine was off.
     *
     * Answers `undefined` when there is nothing kept, when the record is older than the deployment's
     * `maxAgeMs`, or when it claims to have been written in the future - a clock that moved
     * backwards is not evidence about a plant, and a value with an age nobody can reason about is
     * worse than no value. A record refused for age is removed on the way past.
     *
     * Nothing is checked against the peer here, because nothing has been asked of it yet: the epoch
     * this returns is whatever was current last time, and the first accepted snapshot is what
     * replaces or retires it.
     */
    async lastKnown<T extends RpcComponentLike>(
        name: string,
        target?: string,
        options?: RpcComponentOptions
    ): Promise<RpcComponentView<ComponentProps<T>, ComponentState<T>> | undefined> {
        const persistence = this.options.components?.persistence
        if (!persistence) return undefined
        // Spelled exactly as component() spells it, or the key would not be the one that was written.
        const key = snapshotKey(persistence.scope, target ? target : this.options.defaultTarget, name, options?.paths)
        const record = await persistence.store.read(key).catch(() => undefined)
        if (!record) return undefined
        if (!restorable(record, persistence.maxAgeMs, Date.now())) {
            await persistence.store.remove(key).catch(() => undefined)
            return undefined
        }
        return {
            epoch: record.epoch,
            revision: record.revision,
            props: record.props,
            state: record.state,
            ...(record.slices === undefined ? {} : { slices: record.slices }),
            ...(record.projection === undefined ? {} : { projection: record.projection }),
            status: 'stale',
            receivedAt: record.receivedAt,
            // The record was written from a live view, so that is when the feed last proved itself
            // as far as anything this page can still know.
            confirmedAt: record.writtenAt,
            staleSince: record.writtenAt
        } as RpcComponentView<ComponentProps<T>, ComponentState<T>>
    }

    /**
     * One-shot: what a remote node's context looks like right now, as its host answers it. The
     * subscription-and-cache machinery belongs to hosts resolving their own nodes; this is the
     * question a tool - or a queue worker resolving `latest` task context - asks once.
     */
    async readContext(peer: string, node: string, tokenIds: string[]): Promise<ContextWireSnapshot> {
        const proxy = await this.proxy<{ read(node: string, tokenIds: string[]): Promise<ContextWireSnapshot> }>(contextNamespace, peer)
        return await proxy.read(node, tokenIds)
    }
}
