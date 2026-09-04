import { GenericModule, IGenericModule, Message, TransportEvent, type RpcTransportDescription } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { valueRefusal } from '../RPC/Value.js'
import { refuseDelivery } from '../RPC/Undeliverable.js'
import { fromWireFrame, toWireFrame } from './FlatFrame.js'
import { isUsablePeerName, isUsableShape, MAX_CARRIED_PEERS, MAX_RELAY_HOPS, PresenceAnnouncement } from './Presence.js'

/**
 * A link between two peers on one machine, over a `MessagePort`.
 *
 * The third of the placements: a component's methods can run on a worker, a whole component can,
 * and this is what lets a worker be **a peer of its own** - with a name, a presence, and frames
 * routed to it like anywhere else. A worker peer answers calls from the plant bus because the host
 * relays them, and calls out to the plant because the host carries the rest of the network to it.
 *
 * ## Symmetric, because a channel has two ends and no broker
 *
 * socket.io has a client and a server, and MQTT has a broker; a `MessageChannel` has neither. So one
 * class serves both ends: each announces its own name and what it carries, each records the other's,
 * and neither is in charge. That is not a simplification of the other transports - it is what this
 * topology actually is, and pretending one end was a server would put an arbitration nobody needs
 * into a link that cannot have more than two participants.
 *
 * ## The null codec
 *
 * Frames cross as objects. A frame is projected to the same flat wire shape every other transport
 * sends - `toWireFrame`, the one described in `docs/flat-frame-spec.md` - and then simply posted:
 * `postMessage` copies it by structured clone, so there is nothing to encode and nothing to parse.
 * No MsgPack, no `$` to find, no header to walk. What there *is* is a boundary: a copy, with the far
 * side unable to see any object this one still holds.
 *
 * The projection is not a formality. The library's `Message` is a class, and a class crossing by
 * structured clone arrives with its prototype gone - so sending one would be the very mistake
 * `RpcValue` exists to catch, and this transport's own check caught it. Sending the wire frame
 * instead means the thing that crosses is data, which is what every other transport also sends and
 * what makes the rule below apply to the *payload* rather than to the library's own envelope.
 *
 * **Null encoding is not an identity boundary**, and the difference is the whole reason this
 * validates. A value that crosses here and not to a remote peer would make placement observable -
 * a component moved onto a thread would accept what a component on another host would refuse - so
 * every frame is checked against `RpcValue`, which is the rule for what crosses *any* of this
 * library's boundaries rather than what this one happens to carry.
 *
 * ## What presence means with two participants
 *
 * There is no retained state and nobody to ask, so presence is an announcement each way on open and
 * a `peerGone` when the port closes. A worker that exits closes its port, and the host learns the
 * same way it learns a socket dropped. `carrying` does the rest: the host advertises the peers it
 * can reach, and the worker addresses them through this link without knowing they are elsewhere.
 */

/** The part of a `MessagePort` this needs, so a test double or another runtime's port also fits. */
export interface RpcPortLike {
    postMessage(value: unknown): void
    on(event: 'message', listener: (value: unknown) => void): unknown
    on(event: 'close', listener: () => void): unknown
    close?(): void
    start?(): void
}

/** What travels on the port. Tagged, so a port shared with another protocol stays legible. */
type PortEnvelope =
    | { readonly rpc: 'frame'; readonly frame: unknown }
    | { readonly rpc: 'presence'; readonly announcement: PresenceAnnouncement }
    | { readonly rpc: 'gone' }

export class MessagePortTransport extends GenericModule<Message, unknown, Message, unknown> {
    /**
     * The null codec: present because a `Transport` has one, and never used.
     *
     * A server assigns its codec to every transport it attaches, and this one has nothing to encode
     * - the frame crosses as an object. Keeping the field rather than special-casing the server is
     * the smaller lie, and this comment is the difference between an unused field and a mystery.
     */
    codec: FrameCodec = msgPackCodec
    connected = false
    /** The peers this link has been told about: the far end, and whatever it carries. */
    readonly knownPeers = new Set<string>()
    private carrying: string[] = []
    private closing = false
    /** Whether this end has said who it is. Its own flag, because `knownPeers` is the far side's. */
    private introduced = false
    private sweepLanded?: () => void
    private readonly sweep = new Promise<void>((resolve) => (this.sweepLanded = resolve))

    constructor(
        name: string,
        private readonly port: RpcPortLike,
        sources?: IGenericModule[],
        /** Announce on open. Off leaves this peer unlisted and unaddressable, as elsewhere. */
        public announcePresence = true,
        /** The description hash, so a cache on the far side can tell a restart that changed shape. */
        public shape?: string
    ) {
        super(name, sources)
        queueMicrotask(() => void this.open().catch((e) => this.emit(TransportEvent.transportError, e)))
    }

    rpcDescription(): RpcTransportDescription {
        return { name: this.getName(), protocol: 'message-port', role: 'port' }
    }

    /**
     * Resolved once the far end has said who it is.
     *
     * The same promise the other transports offer and for the same reason: *who is here?* has to
     * stop being answered from a registry that is merely empty so far. A transport that does not
     * announce settles at once, because nothing is coming.
     */
    presenceSettled(): Promise<void> {
        if (!this.announcePresence) this.sweepLanded?.()
        return this.sweep
    }

    /** The peers reachable through whatever owns this transport, advertised to the far end. */
    carry(peers: readonly string[]): void {
        this.carrying = [...peers].slice(0, MAX_CARRIED_PEERS)
    }

    override async open() {
        if (this.connected) return
        void super.open()
        this.port.on('message', (value: unknown) => this.arrived(value as PortEnvelope))
        this.port.on('close', () => this.dropped('the port closed'))
        this.port.start?.()
        // Deliberately not unref'd: a peer with an open link is a reason for a process to stay up,
        // exactly as a listening socket is.
        this.connected = true
        this.readyFlag = true
        if (this.announcePresence) this.introduce()
        this.emit(TransportEvent.connected)
    }

    override async close() {
        if (this.closing) return
        this.closing = true
        // Said rather than left to be noticed: the far end can forget this peer now instead of when
        // the port's own close event reaches it, which for a worker being torn down may be never.
        try {
            this.send_({ rpc: 'gone' })
        } catch {
            // A port already closed by the other end. Nothing to say and nobody to say it to.
        }
        this.dropped('closed')
        this.port.close?.()
    }

    private announcement(): PresenceAnnouncement {
        return {
            name: this.name,
            ...(this.carrying.length ? { carrying: this.carrying } : {}),
            ...(this.shape ? { shape: this.shape } : {})
        }
    }

    private introduce(): void {
        this.introduced = true
        this.send_({ rpc: 'presence', announcement: this.announcement() })
    }

    private send_(envelope: PortEnvelope): void {
        this.port.postMessage(envelope)
    }

    /** Everything the far end forgets when this link goes, reported one peer at a time. */
    private dropped(why: string): void {
        if (!this.connected) return
        this.connected = false
        this.readyFlag = false
        for (const peer of [...this.knownPeers]) {
            this.knownPeers.delete(peer)
            this.peerRegistry.delete?.(peer)
            this.emit(TransportEvent.peerGone, peer)
        }
        this.emit(TransportEvent.disconnected, why)
    }

    private arrived(envelope: PortEnvelope): void {
        try {
            if (envelope?.rpc === 'presence') return this.announced(envelope.announcement)
            if (envelope?.rpc === 'gone') return this.dropped('the far end said it was going')
            if (envelope?.rpc !== 'frame') return
            const read = fromWireFrame(envelope.frame)
            if ('reason' in read) {
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: read.reason })
                return
            }
            void this.deliver(read.message, read.source, read.target, read.hops)
        } catch (e) {
            // A malformed envelope must not take a peer down, exactly as an undecodable frame does
            // not on the socket transports.
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: `bad port message: ${String(e)}`, error: e })
        }
    }

    private announced(announcement: PresenceAnnouncement): void {
        // Checked before it is stored, because it arrived from another process's memory: a name is a
        // key in this peer's routing tables, and a remote peer must not be able to grow them.
        if (!isUsablePeerName(announcement?.name)) {
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: 'a presence announcement with no usable name' })
            return
        }
        const named = [announcement.name, ...(announcement.carrying ?? []).filter(isUsablePeerName).slice(0, MAX_CARRIED_PEERS)]
        for (const peer of named) {
            this.knownPeers.add(peer)
            this.peerRegistry.set(peer, this)
        }
        if (announcement.shape !== undefined && !isUsableShape(announcement.shape)) this.emit(TransportEvent.rejected, { source: announcement.name, reason: 'an unusable shape' })
        this.emit(TransportEvent.peerOnline, announcement.name)
        this.sweepLanded?.()
        // Answered, so whichever end opened second is not the only one that knows anything - and
        // guarded by a flag of its own, because a reply to a reply would bounce for ever. The guard
        // was briefly this peer's own name in `knownPeers`, which worked and quietly made this
        // transport report *itself* gone when the link closed: that set is the far side's, and
        // nothing of this one's belongs in it.
        if (this.announcePresence && !this.introduced) this.introduce()
    }

    /** Inbound: for this peer, or for one this peer can reach. */
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
    forward(message: Message, source: string, target: string, hops: number): void {
        try {
            this.put(message, source, target, hops)
        } catch (e) {
            // Relaying is done for somebody else, so there is no caller here to reject.
            this.emit(TransportEvent.transportError, e)
        }
    }

    /**
     * Outbound: what the graph hands this transport goes on the port.
     *
     * Refused while the link is down rather than dropped, for the reason the socket transports give:
     * a frame quietly discarded is a caller waiting out its whole deadline for an answer nobody was
     * ever going to send.
     */
    override async receive(message: Message, source: string, target: string): Promise<void> {
        this.put(message, source, target, 0)
    }

    private put(message: Message, source: string, target: string, hops: number): void {
        if (!this.connected) throw new Error(`MessagePortTransport '${this.name}': the link is not open`)
        const frame = toWireFrame(message, source, target, hops)
        // Thrown rather than dropped, as on the socket transports: a caller whose message has no
        // frame representation has to hear about it here, where there is still a call to reject.
        if (!frame) throw new Error(`MessagePortTransport '${this.name}': no frame representation for this message`)
        // The rule for every boundary, applied to this one - and to the payload rather than to the
        // envelope, which is the library's own and is projected to data above. Structured clone
        // carries more than a codec will, and accepting the difference is what would make placement
        // observable: the same call would mean two things depending on where the callee ran.
        const refused = valueRefusal(frame, { at: `the frame for ${target}` })
        if (refused) throw new Error(refused.why)
        this.send_({ rpc: 'frame', frame })
    }

    override isTransport(): boolean {
        return true
    }
}
