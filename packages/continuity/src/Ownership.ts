/**
 * Which single activation is currently allowed to act for a logical component.
 *
 * This is the fourth of the four concerns the design keeps apart, and the one with teeth. Logical
 * identity names the component; identity policy bounds what any activation of it may ever do;
 * artifact authorisation approves a particular revision for it. None of those say which *running
 * process* is authoritative right now, and an interface-compatible replacement does not receive
 * authority by being interface-compatible.
 *
 * The record is deliberately not the topology owner edge. `RpcTopologyRecord.ownerEpoch` is a
 * generation on a *logical scope* link and rotates when somebody reparents a component; an
 * activation epoch is a generation on *who is running it* and rotates when a process is replaced.
 * Merging them would mean a reparenting silently fenced every live activation in the plant, and a
 * handoff silently invalidated every standing caller fence. They travel at different speeds because
 * they are answers to different questions.
 */

/**
 * The record itself.
 *
 * `epoch` is a monotonically increasing integer rather than the topology edge's opaque generation,
 * because everything downstream needs to compare two of them and say which is older. An opaque
 * generation can answer *is this the current one*; a stale write arriving at a state store needs
 * *is this older than what I have*, and only an ordered value answers that.
 */
export interface RpcActivationOwner {
    readonly componentId: string
    /** This run of this revision. New on every activation, including a restart of the same code. */
    readonly activationId: string
    /** The immutable artifact, by the id its manifest was sealed under. */
    readonly revisionId: string
    readonly epoch: bigint
}

/**
 * What a compare-and-swap did.
 *
 * A rejection carries the owner that was actually there, because the caller's next move depends on
 * it: an epoch ahead of the one expected means somebody else completed a handoff and this one must
 * abort, and reading the store a second time to find out is a second chance to race.
 */
export type RpcOwnershipCas = { readonly committed: RpcActivationOwner } | { readonly rejected: RpcActivationOwner | undefined; readonly why: string }

/**
 * What an ownership store actually guarantees, stated rather than assumed.
 *
 * The precedent is `RpcTopologyCapabilities`, and the reason is stronger here. "At most one
 * activation may commit state or output" is a claim about behaviour under partition, and a store
 * that is a `Map` in one process cannot make it - not because it is badly written, but because the
 * question does not arise until there are two processes. A coordinator that assumed linearizability
 * because the interface offered a `compareAndSwap` would produce exactly the reassuring log line
 * that a split brain needs in order to go unnoticed.
 */
export interface RpcOwnershipCapabilities {
    /**
     * Whether concurrent swaps from different processes are totally ordered, so that exactly one of
     * two racing handoffs commits. `false` means the store orders swaps within one process only.
     */
    readonly linearizable: boolean
    /** Whether the record survives the store's own restart. A forgotten epoch is a reused epoch. */
    readonly durable: boolean
    /**
     * Whether a fence is enforced where the effect lands - the state store, the broker, the output
     * gateway - rather than only by the activation that is about to be retired. Retiring A in the
     * registry does not stop a partitioned A, and this is the field that says whether anything does.
     */
    readonly fencedAtTheSink: boolean
}

export interface RpcOwnershipStore {
    readonly capabilities: RpcOwnershipCapabilities
    read(componentId: string): Promise<RpcActivationOwner | undefined>
    /**
     * Replace `expected` with `next`, atomically, or reject and say what was there.
     *
     * `expected` is `undefined` for the first activation of a component, which is a distinct claim
     * from "whatever is there": the two differ exactly when a component was already activated by
     * somebody else, and that is the case worth failing.
     */
    compareAndSwap(expected: RpcActivationOwner | undefined, next: RpcActivationOwner): Promise<RpcOwnershipCas>
}

/**
 * The reference store: correct within one process, and honest about being no more than that.
 *
 * Useful for tests, for a single-process deployment, and as the shape a real one implements over
 * etcd, a Postgres row with a version column, or whatever the site already trusts to be
 * linearizable. It is deliberately not a default anywhere that a default would be read as an
 * endorsement.
 */
export class MemoryOwnershipStore implements RpcOwnershipStore {
    readonly capabilities: RpcOwnershipCapabilities = { linearizable: false, durable: false, fencedAtTheSink: false }
    private readonly owners = new Map<string, RpcActivationOwner>()

    async read(componentId: string): Promise<RpcActivationOwner | undefined> {
        return this.owners.get(componentId)
    }

    async compareAndSwap(expected: RpcActivationOwner | undefined, next: RpcActivationOwner): Promise<RpcOwnershipCas> {
        // Synchronous from the read to the write. An await in between is where a second swap gets
        // in, and this class exists partly to be the one place where that is obviously not so.
        const actual = this.owners.get(next.componentId)
        const refusal = admissibleSwap(actual, expected, next)
        if (refusal) return { rejected: actual, why: refusal }
        this.owners.set(next.componentId, next)
        return { committed: next }
    }
}

/**
 * Whether one swap may replace another, as a pure function, so that a store written against a real
 * backend applies the same rules as the one in memory rather than approximately the same rules.
 *
 * The refusals are separate sentences because they are separate situations: expecting nothing and
 * finding an owner is a component somebody else already activated, expecting an owner and finding a
 * different one is a handoff that lost a race, and a non-successive epoch is a coordinator that has
 * lost its place - and a store answering `false` to all of them leaves the operator to guess which.
 */
export const admissibleSwap = (actual: RpcActivationOwner | undefined, expected: RpcActivationOwner | undefined, next: RpcActivationOwner): string | undefined => {
    if (expected === undefined) {
        if (actual) return `${next.componentId} is already activated as ${actual.activationId} at epoch ${actual.epoch}, so this is not its first activation`
        if (next.epoch !== 0n) return `${next.componentId} has no owner, so its first activation is epoch 0 rather than ${next.epoch}`
        return undefined
    }
    if (!actual) return `${next.componentId} has no owner recorded, so there is nothing to hand over from ${expected.activationId}`
    if (actual.activationId !== expected.activationId || actual.epoch !== expected.epoch)
        return `${next.componentId} is owned by ${actual.activationId} at epoch ${actual.epoch}, not ${expected.activationId} at epoch ${expected.epoch} - reload the owner and decide again`
    if (next.epoch !== actual.epoch + 1n) return `${next.componentId} would go from epoch ${actual.epoch} to ${next.epoch}, and an activation succeeds the one before it or it is not a handoff`
    if (next.activationId === actual.activationId) return `${next.componentId} would hand over to ${next.activationId}, which is the activation already holding it`
    return undefined
}
