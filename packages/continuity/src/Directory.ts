import type { RpcActivationOwner, RpcOwnershipStore } from './Ownership.js'

/**
 * Turning a logical component name into whichever process is currently running it.
 *
 * Source RPC already addresses peers by name, so a component that never moves needs none of this:
 * the name *is* the indirection. What a handoff adds is that the name outlives the process, and a
 * caller who resolved it once is holding an answer with a shelf life.
 *
 * Two mappings, kept apart on purpose:
 *
 * - **Registration** is where an activation can be reached. A shadow activation is registered and
 *   reachable, because preparation has to be able to talk to it - restore it, dry-run it, ask
 *   whether it is ready - while it is not authoritative for anything.
 * - **Ownership** is which activation may act, and that lives in the store.
 *
 * Collapsing the two is the mistake this shape exists to prevent: a directory that only knew about
 * the authoritative activation could not address the shadow at all, and one that treated everything
 * registered as authoritative would route to both.
 */

/** Where an activation can be reached: the Source RPC peer, and the instance path on it. */
export interface RpcActivationAddress {
    readonly peer: string
    readonly instance: string
}

/**
 * A resolution, with the epoch it was taken under.
 *
 * The epoch is the shelf life. A caller may hold this and address `peer` directly - that is the
 * point of resolving - but it must carry the epoch on anything it sends, so that an act decided
 * against a resolution that has since been superseded is refused rather than delivered to a process
 * that is no longer in charge. Holding the address without the epoch is the failure: it is a
 * destination that looks correct and stops being correct silently.
 */
export interface RpcResolvedActivation {
    readonly componentId: string
    readonly activationId: string
    readonly revisionId: string
    readonly epoch: bigint
    readonly address: RpcActivationAddress
}

export class RpcActivationDirectory {
    private readonly registered = new Map<string, RpcActivationAddress>()

    constructor(private readonly store: RpcOwnershipStore) {}

    /** An activation announces where it is. Called by shadows as well, and before any ownership. */
    register(activationId: string, address: RpcActivationAddress): void {
        this.registered.set(activationId, address)
    }

    /**
     * An activation is gone. Deregistering is not fencing and does not pretend to be: it removes an
     * address, which stops new callers finding it and does nothing at all to one already talking.
     */
    deregister(activationId: string): void {
        this.registered.delete(activationId)
    }

    /** Where a particular activation is, authoritative or not. This is what preparation talks to. */
    addressOf(activationId: string): RpcActivationAddress | undefined {
        return this.registered.get(activationId)
    }

    /**
     * The current authoritative activation of a logical component.
     *
     * `undefined` when nothing owns it, and `undefined` too when the owner is not registered - which
     * is a real state rather than an error: an owner whose process has gone is still the owner until
     * somebody swaps it, and answering with a stale address would be worse than answering nothing.
     */
    async resolve(componentId: string): Promise<RpcResolvedActivation | undefined> {
        const owner = await this.store.read(componentId)
        if (!owner) return undefined
        const address = this.registered.get(owner.activationId)
        if (!address) return undefined
        return { componentId, activationId: owner.activationId, revisionId: owner.revisionId, epoch: owner.epoch, address }
    }

    /**
     * Whether a resolution a caller is holding still describes who is in charge.
     *
     * A sentence rather than a boolean, for the reason every refusal here is: *the component moved
     * on*, *nobody owns it now* and *the process it named has gone* are three different situations
     * and a caller that has to guess which will guess the convenient one.
     */
    async stale(held: RpcResolvedActivation): Promise<string | undefined> {
        const owner = await this.store.read(held.componentId)
        if (!owner) return `${held.componentId} has no owner now, so a resolution from epoch ${held.epoch} names nobody`
        if (owner.epoch !== held.epoch) return `${held.componentId} is at epoch ${owner.epoch} and this resolution was taken at ${held.epoch}: it has been handed over since`
        if (!this.registered.has(owner.activationId)) return `${held.componentId} is owned by ${owner.activationId}, which is no longer registered anywhere`
        return undefined
    }
}

/** The owner record as an address, for the ordinary case of wanting both at once. */
export const addressed = (owner: RpcActivationOwner, address: RpcActivationAddress): RpcResolvedActivation => ({
    componentId: owner.componentId,
    activationId: owner.activationId,
    revisionId: owner.revisionId,
    epoch: owner.epoch,
    address
})
