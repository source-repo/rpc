import type { RpcActivationOwner, RpcOwnershipStore } from './Ownership.js'

/**
 * Making an activation that is no longer the owner unable to act, rather than merely unwilling.
 *
 * The distinction is the whole of this file. An activation that checks whether it is still the owner
 * before each act is *cooperative*: it stops when it can see that it should. A partitioned
 * activation cannot see anything, which is exactly the situation in which it is most likely to still
 * be running and still be holding a valve open. Retiring A in the registry does not reach A.
 *
 * So a fence has two halves and they catch different failures.
 *
 * - The **local** half is `RpcActivationFence`, held by the activation. It is cheap, it catches
 *   every ordinary case, and it turns "I have been retired" into an immediate refusal rather than a
 *   write that races. It is not a safety property.
 * - The **sink** half is `fencedAt`, applied where the effect lands - the state store, the broker,
 *   the output gateway. It compares the epoch on the act against the epoch it has and rejects
 *   anything older. This is the half that holds under partition, because it does not require the
 *   stale activation to know anything.
 *
 * A deployment with only the local half has a fence that works whenever it was not needed, and
 * `RpcOwnershipCapabilities.fencedAtTheSink` is the field that says so out loud.
 */

/** Refused because the activation attempting it is not the one that may act. */
export class RpcFenceRefused extends Error {
    constructor(
        readonly componentId: string,
        readonly attemptedEpoch: bigint,
        readonly currentEpoch: bigint | undefined,
        message: string
    ) {
        super(message)
        this.name = 'RpcFenceRefused'
    }
}

/** An act carrying the epoch of the activation that produced it. Everything authoritative is one. */
export interface RpcFencedAct<T> {
    readonly componentId: string
    readonly epoch: bigint
    readonly act: T
}

/**
 * The local half: what an activation holds while it is authoritative.
 *
 * Starts closed. `open()` is called after the ownership swap commits and never before - an
 * activation that could act during preparation would be a second authoritative activation, which is
 * the one thing shadow running exists to avoid. `close()` is one-way: an activation that has been
 * fenced does not come back, because coming back would mean an epoch acting after its successor
 * began, and there is no way to know what the successor did in between.
 */
export class RpcActivationFence {
    private state: 'shadow' | 'authoritative' | 'fenced' = 'shadow'

    constructor(
        readonly componentId: string,
        readonly activationId: string,
        readonly epoch: bigint
    ) {}

    get authoritative(): boolean {
        return this.state === 'authoritative'
    }

    /** Whether this activation has been retired. Distinct from `!authoritative`, which is also true of a shadow. */
    get retired(): boolean {
        return this.state === 'fenced'
    }

    open(): void {
        if (this.state === 'fenced')
            throw new RpcFenceRefused(this.componentId, this.epoch, undefined, `${this.componentId}/${this.activationId} was fenced and may not become authoritative again - its successor has already acted`)
        this.state = 'authoritative'
    }

    close(): void {
        this.state = 'fenced'
    }

    /**
     * Stamp an act with this activation's epoch, or refuse.
     *
     * Every authoritative thing goes through here: a state write, a published output, a command to
     * a device. The stamp is what lets a sink reject it later, so an act that skipped this is an act
     * nothing downstream can fence.
     */
    stamp<T>(act: T): RpcFencedAct<T> {
        if (this.state !== 'authoritative')
            throw new RpcFenceRefused(
                this.componentId,
                this.epoch,
                undefined,
                this.state === 'shadow'
                    ? `${this.componentId}/${this.activationId} is a shadow activation and may not act: its outputs are disabled until ownership is handed to it`
                    : `${this.componentId}/${this.activationId} has been fenced at epoch ${this.epoch} and may not act`
            )
        return { componentId: this.componentId, epoch: this.epoch, act }
    }
}

/**
 * The sink half: refuse an act from any epoch that is not the current owner's.
 *
 * `<` rather than `!==` would be the tempting relaxation, and it is wrong in the direction that
 * matters: an epoch *ahead* of what this sink has read is an activation this sink has not been told
 * about, and accepting it would mean the sink's own view of ownership is decorative. A sink that is
 * behind must catch up from the store rather than trust the act to tell it who is in charge - which
 * is the same rule as everywhere else here, that a claim is not evidence.
 */
export const fencedAt = async <T>(store: RpcOwnershipStore, act: RpcFencedAct<T>): Promise<T> => {
    const owner = await store.read(act.componentId)
    const refusal = fenceRefusal(owner, act)
    if (refusal) throw new RpcFenceRefused(act.componentId, act.epoch, owner?.epoch, refusal)
    return act.act
}

/** The comparison on its own, so a sink that has the owner in hand need not read it again. */
export const fenceRefusal = <T>(owner: RpcActivationOwner | undefined, act: RpcFencedAct<T>): string | undefined => {
    if (!owner) return `${act.componentId} has no recorded owner, so nothing can be shown to be authoritative for it`
    if (act.epoch < owner.epoch)
        return `${act.componentId} is at epoch ${owner.epoch} and this act carries ${act.epoch}: it was produced by an activation that has since been replaced`
    if (act.epoch > owner.epoch)
        return `${act.componentId} is at epoch ${owner.epoch} and this act carries ${act.epoch}: it claims an activation this sink has not been told about, which is a claim rather than evidence`
    return undefined
}
