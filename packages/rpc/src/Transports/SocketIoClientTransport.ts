import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client'
import { GenericModule, IGenericModule, Message, publicTransportEndpoint, TransportEvent, type RpcTransportDescription } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { refuseDelivery } from '../RPC/Undeliverable.js'
import { isUsablePeerName, isUsableShape, MAX_RELAY_HOPS, PRESENCE_EVENT, PresenceAnnouncement, PresenceUpdate } from './Presence.js'
import { FRAME_EVENT, fromWireFrame, LEGACY_FRAME_EVENT, FLAT_FRAME_VERSION, toWireFrame } from './FlatFrame.js'

export class SocketIoClientTransport extends GenericModule<Message, unknown, Message, unknown> {
    socket?: Socket
    connected = false
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec
    /**
     * Send the flat frame rather than the `$`-delimited one. See docs/flat-frame-spec.md.
     *
     * Both are read on the way in, so a server of either vintage can answer this peer. What this
     * decides is what goes *out*, and the honest limit is worth stating: a v2 frame reaches a
     * pre-v2 server as an event it has no listener for, which socket.io delivers to nobody - so the
     * call times out with nothing said. That is why this is a flag and not merely a rewrite, and
     * why `rpc` and its dependants version together.
     */
    frameVersion: 1 | 2 = FLAT_FRAME_VERSION
    /** Peers this transport has been told are online, so a reconnect can report only what changed. */
    readonly knownPeers = new Set<string>()
    /** Peers reachable through whatever owns this transport, advertised to the far end. */
    private carrying: string[] = []
    /** Resolves the sweep below. Undefined once it has fired - settled never unsettles. */
    private sweepLanded?: () => void
    private readonly sweep = new Promise<void>((resolve) => (this.sweepLanded = resolve))

    /**
     * Resolved when the server's answer to this transport's announcement - the full peers list -
     * has arrived. That list is socket.io's stand-in for MQTT's retained presence, so this is the
     * moment "who is here?" stops being answered from an empty registry that merely has not been
     * filled yet. Resolved once and stays resolved: settled is about the first picture, not about
     * every change since, and a reconnect's fresh snapshot does not re-open it.
     *
     * A transport that does not announce is settled immediately, because the server only sends the
     * list in reply to an announcement - nothing is coming, and waiting for it would just spend
     * the caller's bound.
     */
    presenceSettled(): Promise<void> {
        if (!this.announcePresence) this.sweepLanded?.()
        return this.sweep
    }

    constructor(
        /**
         * The peer name this transport announces itself under, which is what makes it findable and
         * addressable. Taking it here mirrors MqttTransport, where the name has always been needed
         * to subscribe to the peer's own topic.
         */
        name: string,
        public url?: string,
        sources?: IGenericModule[],
        // SocketOptions carries `auth`, which is how credentials reach an authenticating server.
        public options: Partial<ManagerOptions & SocketOptions> = {},
        /** Announce on connect. Off leaves this peer unlisted and unaddressable, as before. */
        public announcePresence = true,
        /**
         * Connect to an `https://` or `wss://` server without checking its certificate.
         *
         * This used to be the default, and it should never have been: it accepts any certificate at
         * all, so anything able to answer on the server's address can read and rewrite everything
         * sent over the link - which on this library's traffic means industrial commands. Left as a
         * deliberate, named choice for a development server with a self-signed certificate. A plant
         * with its own certificate authority should pass `ca` in the socket options instead, which
         * keeps verification on.
         */
        public allowInsecureTls = false,
        /** Which frame layout to send. See the `frameVersion` field for what the older one costs. */
        frameVersion: 1 | 2 = FLAT_FRAME_VERSION
    ) {
        super(name, sources)
        this.frameVersion = frameVersion
        // Deferred by a microtask so whatever constructs this transport can finish wiring it
        // before the link comes up. A resumed MQTT session is delivered its queued messages the
        // instant it connects, and a frame arriving before the RPC handler is piped in would find
        // no target and be dropped. A fresh session never exposes this, because nothing arrives
        // that early.
        queueMicrotask(() => void this.open().catch((e) => this.emit(TransportEvent.transportError, e)))
    }

    rpcDescription(): RpcTransportDescription {
        const endpoint = this.url ? publicTransportEndpoint(this.url) : undefined
        return { name: this.getName(), protocol: 'socket.io', role: 'connect', ...(endpoint ? { endpoint } : {}) }
    }

    /** Set for good by close(). What stops the server-restart retry from resurrecting the link. */
    private closing = false

    override async close() {
        this.closing = true
        // A waiter on the sweep must not outlive the transport - on a link that never came up,
        // the answer to "has the first picture arrived" is that no picture is coming.
        this.sweepLanded?.()
        this.sweepLanded = undefined
        const socket = this.socket
        this.socket = undefined
        this.connected = false
        this.readyFlag = false
        if (!socket) return
        // Disarm reconnection before disconnecting. An explicit close is not a link failure, and
        // a manager left free to reconnect keeps a timer armed that outlives the transport.
        // reconnection(false) is the setter; assigning to opts.reconnection does not reach the
        // manager's own flag and left the timer armed anyway.
        socket.io.reconnection(false)
        // Only disconnect() - close() is an alias for it, and calling both corrupted the manager's
        // socket bookkeeping.
        //
        // Awaited, because disconnect() only *starts* the close: it sends a close packet and
        // returns, leaving the engine's ping timer armed until the transport is actually torn down.
        // Returning before that makes close() a promise that resolves while the connection it was
        // supposed to close is still running.
        const engine = socket.io.engine
        const closed =
            socket.connected && engine
                ? new Promise<void>((resolve) => {
                      // Bounded: a close that never completes must not hang the caller forever.
                      const settle = setTimeout(resolve, 2000)
                      settle.unref?.()
                      engine.once('close', () => {
                          clearTimeout(settle)
                          resolve()
                      })
                  })
                : Promise.resolve()
        socket.disconnect()
        await closed
        socket.removeAllListeners()
        this.knownPeers.clear()
    }

    override async open() {
        // Idempotent: the constructor opens, and RpcClient.init() opens again. Without this guard
        // every client ends up with a second, orphaned socket that stays connected forever.
        if (this.socket) return
        // Deliberately not awaited. The base hook is a no-op, and awaiting it yields before the
        // socket below is assigned - which lets a second open() past the guard above and leaves the
        // first socket orphaned and reconnecting forever, exactly what the guard is here to prevent.
        void super.open()
        const urlSocketIo = this.url
        // Certificate verification is Node's default and stays on. It was turned off here for
        // every client, before the caller's own options were applied, so a Node peer accepted an
        // impersonated TLS server unless whoever wrote it knew to turn verification back on.
        if (this.allowInsecureTls) {
            // Spread after, so a caller that asks for both gets the safer of the two.
            this.options = { rejectUnauthorized: false, ...this.options }
            this.warnAboutInsecureTls()
        }
        this.socket = urlSocketIo ? io(urlSocketIo, this.options) : io(this.options)
        this.socket.on(LEGACY_FRAME_EVENT, async (messageArray) => {
            try {
                const [header, payload, reason] = this.extractHeader(new Uint8Array(messageArray))
                if (!header) {
                    // Reported rather than dropped in silence, which showed up only as a timeout.
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: reason ?? 'no msgrpc header' })
                    return
                }
                const message = this.codec.decode(payload as Uint8Array) as Message
                await this.deliver(message, header.source, header.target, header.hops ?? 0)
            } catch (e) {
                // A peer that sends a frame this codec cannot read must not take the client down.
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `undecodable frame: ${String(e)}`, error: e })
            }
        })
        // Both layouts are read regardless of which one this peer sends, so a server may answer in
        // whichever it speaks and an upgrade needs no coordination in this direction.
        this.socket.on(FRAME_EVENT, async (frameArray) => {
            try {
                const read = fromWireFrame(this.codec.decode(new Uint8Array(frameArray)))
                if ('reason' in read) {
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: read.reason })
                    return
                }
                await this.deliver(read.message, read.source, read.target, read.hops)
            } catch (e) {
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `undecodable frame: ${String(e)}`, error: e })
            }
        })
        this.socket.on(PRESENCE_EVENT, (update: PresenceUpdate) => {
            // socket.io emits synchronously from its parser, so a listener that throws unwinds into
            // the engine rather than anywhere that could report it.
            try {
                this.onPresence(update)
            } catch (e) {
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `bad presence update: ${String(e)}`, error: e })
            }
        })
        // socket.io emits 'connect' on reconnects too, so this fires on every transition.
        this.socket.on('connect', () => {
            this.connected = true
            this.readyFlag = true
            // Announced on every connect, not only the first: the server forgets a peer when its
            // socket drops, so a reconnected peer that stayed silent would be unaddressable.
            if (this.announcePresence) this.announce()
            this.emit(TransportEvent.connected)
        })
        this.socket.on('disconnect', (reason) => {
            this.connected = false
            this.readyFlag = false
            // Nothing is reachable through a link that is down, and the server will send a fresh
            // snapshot when it comes back. Reported so a console can grey the whole list out.
            for (const peer of [...this.knownPeers]) {
                this.knownPeers.delete(peer)
                this.emit(TransportEvent.peerGone, peer)
            }
            this.emit(TransportEvent.disconnected, reason)
            // socket.io deliberately never auto-reconnects after 'io server disconnect' - and that
            // is exactly what a restarting server sends on its way down. Left alone, a plant
            // server reboot permanently orphans every client it had, which no HMI can accept. So a
            // server-initiated close is retried like a network drop, on a delay so a server that
            // kicks deliberately - displacement, a rejected handshake - is not hammered. Two peers
            // configured with one name will fight through this; that is the misconfiguration's
            // noise, not a reason to stay disconnected after every reboot.
            if (reason === 'io server disconnect' && !this.closing) {
                const retry = setTimeout(() => {
                    if (!this.closing && this.socket?.disconnected) this.socket.connect()
                }, 1000)
                retry.unref?.()
            }
        })
    }

    /**
     * Said once per transport, and only where it means anything: the flag has no effect on a plain
     * `http://` link, and warning about one would teach people to ignore the warning.
     */
    private warnAboutInsecureTls() {
        if (!this.url || !/^(https|wss):/i.test(this.url)) return
        console.warn(
            `source-rpc: '${this.name}' is connecting to ${this.url} with allowInsecureTls, so the server's certificate is not checked. ` +
                'Anything able to answer on that address can read and rewrite this link. Use it for a development server, not a plant.'
        )
    }

    /**
     * A peer heard about through this link is routable through it - but only if nothing already
     * reaches it. A server that serves a peer locally must not start sending its traffic up to the
     * hub and back, and it would, since the hub lists that peer like any other.
     */
    private registerIfUnrouted(peer: string) {
        if (this.peerRegistry.get(peer)) return
        this.setKnownSource(peer)
    }

    private announce() {
        const announcement: PresenceAnnouncement = { name: this.name }
        if (this.carrying.length) announcement.carrying = this.carrying
        if (this.shape) announcement.shape = this.shape
        // So the server can address this peer before it has sent a frame - an event pushed to a
        // subscriber being the ordinary case. See PresenceAnnouncement.v.
        if (this.frameVersion !== 1) announcement.v = this.frameVersion
        this.socket?.emit(PRESENCE_EVENT, announcement)
    }

    /** The description hash this peer announces. See PresenceAnnouncement.shape. */
    private shape?: string

    /**
     * Set what this peer's surface hashes to, re-announcing if the change happens on a live link -
     * which it does whenever something is exposed after ready(), the way the introspection
     * namespace itself is.
     */
    announceShape(shape: string) {
        if (this.shape === shape) return
        this.shape = shape
        if (this.connected && this.announcePresence) this.announce()
    }

    /**
     * Say which peers can be reached through this connection. Sent again whenever the set changes,
     * which is how a peer appearing three hops away eventually becomes addressable from here.
     */
    advertise(peers: string[]) {
        const next = [...peers].sort()
        if (next.length === this.carrying.length && next.every((peer, index) => peer === this.carrying[index])) return
        this.carrying = next
        if (this.connected && this.announcePresence) this.announce()
    }

    /** The server's view of who else is connected, turned into the same events MQTT emits. */
    /** Checked and deduplicated before anyone hears about it - see TransportEvent.peerShape. */
    private noteShape(peer: string, shape: unknown) {
        if (!isUsableShape(shape)) return
        if (this.peerRegistry.noteShape(peer, shape)) this.emit(TransportEvent.peerShape, peer, shape)
    }

    private onPresence(update: PresenceUpdate) {
        if (Array.isArray(update.peers)) {
            // The snapshot is here, whoever asked for it. Resolved before the loop, not after:
            // even an all-filtered list (every name unusable or already known) is still the sweep.
            const landed = this.sweepLanded
            this.sweepLanded = undefined
            landed?.()
            for (const peer of update.peers) {
                if (!isUsablePeerName(peer) || peer === this.name) continue
                // Before the known-peers gate: a reconnect's fresh snapshot repeats known names,
                // and a repeated name carrying a new hash is the restart this exists to catch.
                if (update.shapes && Object.prototype.hasOwnProperty.call(update.shapes, peer)) this.noteShape(peer, update.shapes[peer])
                if (this.knownPeers.has(peer)) continue
                this.knownPeers.add(peer)
                this.registerIfUnrouted(peer)
                this.emit(TransportEvent.peerOnline, peer)
            }
            return
        }
        if (!isUsablePeerName(update.peer) || update.peer === this.name) return
        if (update.state === 'offline') {
            if (!this.knownPeers.delete(update.peer)) return
            this.emit(TransportEvent.peerGone, update.peer)
        } else {
            // Same reasoning as the snapshot: a re-announcement of a known peer with a new hash is
            // a change of surface, not a change of presence, and must not be gated out with it.
            if (update.shape !== undefined) this.noteShape(update.peer, update.shape)
            if (this.knownPeers.has(update.peer)) return
            this.knownPeers.add(update.peer)
            this.registerIfUnrouted(update.peer)
            this.emit(TransportEvent.peerOnline, update.peer)
        }
    }

    /**
     * Hand a frame to this peer's own handlers, or on to whichever transport reaches its addressee.
     * The second case is what makes a server that is both a hub for its own peers and a member of a
     * bus work: a call for one of its peers arrives down this link and has to be passed inwards,
     * not answered here. Without it the frame reached the right process and was refused by it.
     */
    private async deliver(message: Message, source: string, target: string, hops: number) {
        if (target !== this.name) {
            const carrier = this.peerRegistry.get(target)
            if (carrier && carrier !== (this as IGenericModule) && carrier.isTransport()) {
                if (hops + 1 > MAX_RELAY_HOPS) {
                    await refuseDelivery(this, message, source, target, 'TransportError', `over ${MAX_RELAY_HOPS} relays`)
                    return
                }
                const relay = carrier as { forward?: (message: Message, source: string, target: string, hops: number) => void }
                if (relay.forward) relay.forward(message, source, target, hops + 1)
                else await carrier.receive(message, source, target)
                return
            }
        }
        if (this.targetExists(target)) {
            await this.send(message, source, target)
            return
        }
        await refuseDelivery(this, message, source, target, 'TransportError', `no route to '${target}'`)
    }

    /** Send over this link with a hop count, for a frame being passed along rather than originated. */
    forward(message: Message, source: string, target: string, hops: number) {
        try {
            this.emitFrame(this.requireSocket(), message, source, target, hops)
        } catch (e) {
            // Relaying is done for someone else, so there is no caller here to reject.
            this.emit(TransportEvent.unroutable, { source, target, reason: `cannot forward: ${String(e)}`, error: e })
        }
    }

    /**
     * Put one frame on the link in whichever layout this peer sends.
     *
     * Throws rather than returning quietly when the message has no representation. The old path
     * could not fail this way - it encoded a `Message` whole and asked no questions - so a caller
     * whose message cannot be framed has to hear about it here, where there is still a call to
     * reject, rather than discover it as a timeout.
     */
    private emitFrame(socket: Socket, message: Message, source: string, target: string, hops = 0) {
        if (this.frameVersion === 1) {
            const header = this.buildHeader(source, target, hops ? { hops } : undefined)
            socket.emit(LEGACY_FRAME_EVENT, this.frameMessage(header, this.codec.encode(message)))
            return
        }
        const wire = toWireFrame(message, source, target, hops)
        if (!wire) throw new Error(`SocketIoClientTransport '${this.name}': no frame representation for this message`)
        socket.emit(FRAME_EVENT, this.codec.encode(wire))
    }

    /**
     * The link, or an error saying there is none - where "there is none" includes a socket that
     * exists but is not currently connected.
     *
     * Sending went through `this.socket?.emit(...)`, which is a no-op once the transport is closed -
     * so an outgoing call was discarded without a word and its caller waited out the full timeout
     * for a frame that was never going to be sent.
     *
     * The connected check is the second half of the same idea and was the more expensive omission.
     * socket.io buffers an emit made while disconnected and flushes the whole buffer on reconnect,
     * which reads like resilience and is not: by then the call has failed on its own timeout, its
     * caller has been told so and acted on it, and the frame is delivered anyway. Measured at nine
     * and a half seconds past the caller's deadline on a two-second timeout, with the command
     * running at the far end. The server's own deadline re-read cannot catch it either, because
     * that budget is measured from the moment a frame *arrives* and this one arrives untouched.
     */
    private requireSocket() {
        if (!this.socket) throw new Error(`SocketIoClientTransport '${this.name}': not connected to ${this.url ?? 'the default url'}`)
        if (!this.socket.connected) throw new Error(`SocketIoClientTransport '${this.name}': the link to ${this.url ?? 'the default url'} is down`)
        return this.socket
    }

    override async receive(message: Message, source: string, target: string) {
        // Refused while the link is down rather than waited out or handed over - see requireSocket.
        // The rule this replaces was "let socket.io buffer it, and if the link never comes back the
        // call fails on its own timeout", which is true and is not the whole story: when the link
        // *does* come back, the buffered frame is delivered to a caller that gave up long ago.
        this.emitFrame(this.requireSocket(), message, source, target)
    }

    override isTransport() {
        return true
    }
}
