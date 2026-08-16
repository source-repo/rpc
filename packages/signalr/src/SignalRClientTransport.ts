import { HubConnection, HubConnectionBuilder, HubConnectionState, IHttpConnectionOptions, JsonHubProtocol, LogLevel } from '@microsoft/signalr'
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack'
import {
    FRAME_EVENT,
    FLAT_FRAME_VERSION,
    FrameCodec,
    fromWireFrame,
    GenericModule,
    IGenericModule,
    isUsablePeerName,
    isUsableShape,
    jsonCodec,
    MAX_RELAY_HOPS,
    Message,
    msgPackCodec,
    PRESENCE_EVENT,
    PresenceAnnouncement,
    PresenceUpdate,
    refuseDelivery,
    toWireFrame,
    TransportEvent,
    WireFrame
} from '@source-repo/rpc'

/**
 * Source RPC over an ASP.NET Core SignalR hub.
 *
 * ## Why this exists
 *
 * The .NET world does not run socket.io servers; it runs SignalR. A C# process that wants to be an
 * ordinary peer - a Visual Studio automation host, say - can host a hub in a few lines and can find
 * a SignalR client for anything, but it cannot host a socket.io server without adopting a stack
 * that is nobody's default there. Without this transport the only way to reach such a process is to
 * put a broker between them and give it a topic of its own, which is a lot of machinery for two
 * programs on one machine, and it makes a local integration depend on infrastructure being up.
 *
 * ## Client only, and why that is not a gap
 *
 * There is no `SignalRServerTransport`, because a SignalR *server* is ASP.NET Core - there is
 * nothing to host one with from Node. The direction is therefore fixed: the C# process is the hub
 * and this dials in. That is the direction the problem has anyway, since the thing worth reaching
 * is the .NET process.
 *
 * ## What the hub has to implement
 *
 * Three methods and two pushes, all carrying the flat frame of `docs/flat-frame-spec.md`:
 *
 * ```csharp
 * public class RpcHub : Hub
 * {
 *     public Task Frame(RpcFrame frame)              => …;   // client -> hub
 *     public Task Presence(PresenceAnnouncement who) => …;   // client -> hub
 *     // hub -> client: Clients.Caller.SendAsync("frame", …) and ("presence", …)
 * }
 * ```
 *
 * A reference implementation is in `csharp/` beside this file.
 *
 * ## The frame is an object here, not bytes
 *
 * Every other transport in this library encodes the frame itself, because MQTT carries a byte
 * payload and socket.io carries whatever you hand it. SignalR is different: it *has* a
 * serialization layer, and hub methods are typed. Encoding a frame to bytes ourselves and passing
 * the blob would mean the hub receives `byte[]` and has to decode it by hand - throwing away the
 * one thing SignalR does for a C# author, which is to hand them a real object.
 *
 * So the frame goes as a frame, and `codec` selects the **hub protocol** rather than doing the
 * encoding: MsgPack for `msgPackCodec`, SignalR's default JSON otherwise. The difference that
 * matters is binary inside `body` - MsgPack carries a byte array as one, JSON base64s it.
 */
export class SignalRClientTransport extends GenericModule<Message, unknown, Message, unknown> {
    connection?: HubConnection
    connected = false
    /**
     * Chooses the SignalR hub protocol rather than encoding anything - see the class comment. Set
     * by `RpcClient` from its `useMsgPack` option, synchronously at construction, so `open()` reads
     * the caller's choice rather than this default.
     */
    codec: FrameCodec = msgPackCodec
    /** Peers this transport has been told are online, so a reconnect can report only what changed. */
    readonly knownPeers = new Set<string>()
    private carrying: string[] = []
    private shape?: string
    private closing = false
    private sweepLanded?: () => void
    private readonly sweep = new Promise<void>((resolve) => (this.sweepLanded = resolve))

    constructor(
        /** The peer name this transport announces itself under, which is what makes it addressable. */
        name: string,
        /** The hub's URL, e.g. `http://localhost:5217/rpc`. */
        public url: string,
        sources?: IGenericModule[],
        /**
         * Passed to `withUrl`. `accessTokenFactory` is how a bearer token reaches an authorising
         * hub, and is this transport's equivalent of socket.io's handshake `auth`: the hub decides
         * who the connection belongs to, and should pin each frame's `src` to that identity exactly
         * as `SocketIoServerTransport` does. Without that, a peer name here is an unchecked claim.
         */
        public options: IHttpConnectionOptions = {},
        /** Announce on connect. Off leaves this peer unlisted and unaddressable. */
        public announcePresence = true,
        /**
         * Delays before each reconnect attempt, in milliseconds. SignalR does not reconnect at all
         * unless asked, and its own default gives up after four tries - which is wrong for a plant,
         * where the far end may be down for a maintenance window and the link must come back
         * without anyone restarting anything. So this retries indefinitely, backing off to 30s.
         */
        public reconnectDelaysMs: number[] = [0, 2000, 5000, 10000, 30000],
        /**
         * Build the connection, instead of the builder below doing it.
         *
         * SignalR's builder has more in it than this constructor can reasonably mirror - custom
         * retry policies, stateful reconnect, a hub protocol of your own - and wrapping each option
         * one at a time would be a worse API than handing over the one call. Whatever this returns
         * has its handlers registered and is started by `open()`, so a builder here should not call
         * `start()` itself.
         */
        public createConnection?: () => HubConnection
    ) {
        super(name, sources)
        // Deferred by a microtask for the same reason the socket.io transport defers: whatever
        // constructs this has to finish wiring it - including assigning `codec` - before the link
        // comes up and frames start arriving with no handler piped in to take them.
        queueMicrotask(() => void this.open().catch((e) => this.emit(TransportEvent.transportError, e)))
    }

    /**
     * Resolved when the hub's answer to this peer's announcement has arrived, so "who is here?"
     * stops being answered from a registry that is merely still empty. Mirrors the socket.io
     * transport, including the part where a peer that does not announce is settled at once, since
     * nothing is coming and waiting would only spend the caller's bound.
     */
    presenceSettled(): Promise<void> {
        if (!this.announcePresence) this.sweepLanded?.()
        return this.sweep
    }

    private buildConnection() {
        return (
            new HubConnectionBuilder()
                .withUrl(this.url, this.options)
                // Retried forever rather than with SignalR's built-in default, which gives up after
                // four attempts. `nextRetryDelayInMilliseconds` returning null is how it is told to
                // stop, and this returns null only when closing deliberately: it holds at the last
                // delay instead, so a hub that comes back after a maintenance window is picked up
                // without anybody restarting anything.
                .withAutomaticReconnect({
                    nextRetryDelayInMilliseconds: (context) =>
                        this.closing ? null : this.reconnectDelaysMs[Math.min(context.previousRetryCount, this.reconnectDelaysMs.length - 1)]
                })
                .configureLogging(LogLevel.Warning)
                // The one place `codec` is read. See the class comment: this picks how SignalR
                // serialises, rather than asking this transport to serialise anything itself.
                .withHubProtocol(this.codec === jsonCodec ? new JsonHubProtocol() : new MessagePackHubProtocol())
                .build()
        )
    }

    override async open() {
        if (this.connection) return
        void super.open()
        const connection = this.createConnection ? this.createConnection() : this.buildConnection()
        this.connection = connection

        connection.on(FRAME_EVENT, (frame: WireFrame) => {
            void this.onFrame(frame).catch((e) =>
                // A hub that sends one unreadable frame must not take this peer down.
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `failed to handle frame: ${String(e)}`, error: e })
            )
        })
        connection.on(PRESENCE_EVENT, (update: PresenceUpdate) => {
            try {
                this.onPresence(update)
            } catch (e) {
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `bad presence update: ${String(e)}`, error: e })
            }
        })
        connection.onreconnected(() => {
            this.connected = true
            this.readyFlag = true
            // Announced on every reconnection, not only the first: SignalR gives the hub a new
            // connection id, so as far as the hub is concerned this is a peer it has never met.
            if (this.announcePresence) void this.announce()
            this.emit(TransportEvent.connected)
        })
        connection.onreconnecting((error) => this.onDown(error))
        connection.onclose((error) => this.onDown(error))

        await connection.start()
        this.connected = true
        this.readyFlag = true
        if (this.announcePresence) await this.announce()
        this.emit(TransportEvent.connected)
    }

    /** Nothing is reachable through a link that is down, so everyone it carried is reported gone. */
    private onDown(error?: Error) {
        this.connected = false
        this.readyFlag = false
        for (const peer of [...this.knownPeers]) {
            this.knownPeers.delete(peer)
            this.emit(TransportEvent.peerGone, peer)
        }
        this.emit(TransportEvent.disconnected, error)
    }

    private async onFrame(frame: WireFrame) {
        const read = fromWireFrame(frame)
        if ('reason' in read) {
            // Reported rather than dropped in silence, which shows up only as a call timing out.
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: read.reason })
            return
        }
        await this.deliver(read.message, read.source, read.target, read.hops)
    }

    /**
     * Hand a frame to this peer's handlers, or on to whichever transport reaches its addressee.
     * The second case is what lets a process bridge a SignalR hub to the rest of a network: a call
     * for one of its other peers arrives down this link and has to be passed inwards.
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

    private requireConnection() {
        if (!this.connection || this.connection.state !== HubConnectionState.Connected)
            // Thrown rather than dropped: an outgoing call discarded in silence leaves its caller
            // waiting out the full timeout for a frame that was never going to be sent.
            throw new Error(`SignalRClientTransport '${this.name}': not connected to ${this.url}`)
        return this.connection
    }

    private async sendFrame(message: Message, source: string, target: string, hops = 0) {
        // The link is checked first, because "not connected" is the condition a caller can do
        // something about and the one that actually happens. A message with no frame is a
        // programming error, and reporting it while the link is down would send whoever is
        // debugging after the wrong thing.
        const connection = this.requireConnection()
        const wire = toWireFrame(message, source, target, hops)
        if (!wire) throw new Error(`SignalRClientTransport '${this.name}': no frame representation for this message`)
        await connection.send(FRAME_EVENT, wire)
    }

    override async receive(message: Message, source: string, target: string) {
        await this.sendFrame(message, source, target)
    }

    /** Send with a hop count, for a frame being passed along rather than originated here. */
    forward(message: Message, source: string, target: string, hops: number) {
        this.sendFrame(message, source, target, hops).catch((e) =>
            // Relaying is done for someone else, so there is no caller here to reject.
            this.emit(TransportEvent.unroutable, { source, target, reason: `cannot forward: ${String(e)}`, error: e })
        )
    }

    private async announce() {
        const announcement: PresenceAnnouncement = { name: this.name, v: FLAT_FRAME_VERSION }
        if (this.carrying.length) announcement.carrying = this.carrying
        if (this.shape) announcement.shape = this.shape
        try {
            await this.connection?.send(PRESENCE_EVENT, announcement)
        } catch (e) {
            this.emit(TransportEvent.transportError, e)
        }
    }

    /** Set what this peer's surface hashes to, re-announcing if it changes on a live link. */
    announceShape(shape: string) {
        if (this.shape === shape) return
        this.shape = shape
        if (this.connected && this.announcePresence) void this.announce()
    }

    /** Say which peers can be reached through this connection, so the hub can route to them. */
    advertise(peers: string[]) {
        const next = [...peers].sort()
        if (next.length === this.carrying.length && next.every((peer, index) => peer === this.carrying[index])) return
        this.carrying = next
        if (this.connected && this.announcePresence) void this.announce()
    }

    private registerIfUnrouted(peer: string) {
        // A peer already reachable some other way keeps that route: a process that serves a peer
        // locally must not start sending its traffic up to the hub and back.
        if (this.peerRegistry.get(peer)) return
        this.setKnownSource(peer)
    }

    private noteShape(peer: string, shape: unknown) {
        if (!isUsableShape(shape)) return
        if (this.peerRegistry.noteShape(peer, shape)) this.emit(TransportEvent.peerShape, peer, shape)
    }

    private onPresence(update: PresenceUpdate) {
        if (Array.isArray(update.peers)) {
            const landed = this.sweepLanded
            this.sweepLanded = undefined
            landed?.()
            for (const peer of update.peers) {
                if (!isUsablePeerName(peer) || peer === this.name) continue
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
            if (update.shape !== undefined) this.noteShape(update.peer, update.shape)
            if (this.knownPeers.has(update.peer)) return
            this.knownPeers.add(update.peer)
            this.registerIfUnrouted(update.peer)
            this.emit(TransportEvent.peerOnline, update.peer)
        }
    }

    override async close() {
        this.closing = true
        // A waiter on the sweep must not outlive the transport: on a link that never came up, the
        // answer to "has the first picture arrived" is that no picture is coming.
        this.sweepLanded?.()
        this.sweepLanded = undefined
        const connection = this.connection
        this.connection = undefined
        this.connected = false
        this.readyFlag = false
        this.knownPeers.clear()
        // stop() is awaited: it returns once the connection is really down, and returning earlier
        // would resolve close() while the thing it closed was still running.
        if (connection) await connection.stop()
    }

    override isTransport() {
        return true
    }
}
