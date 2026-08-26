/**
 * A name for the state of a whole resource, moved by the writes this node served.
 *
 * The component channel gives a caller something no pull cache has had: a page drawn at the
 * revision the publisher currently holds has had nothing published over it, so it is *confirmed
 * current* rather than merely recent. That works for a record in `props` or `state`, because the
 * record is in the snapshot. It does not work for a **declared resource** - a table, a document
 * collection, a queue - because those live behind the component rather than inside it, and the
 * shipped store-backed nodes move their revision on *reads* and on a metrics timer.
 *
 * This is the beginning of the answer for those. It is deliberately a small beginning:
 *
 * **What it says.** Two answers carrying the same stamp describe the same state of that resource,
 * as far as writes this node served are concerned. Nothing else.
 *
 * **What it does not say.** It is not ordered, so two stamps cannot be compared for age - the one
 * thing a version number usually offers. It says nothing about a database changed by anything other
 * than this node, which on a plant is most things: another service, a scheduled job, a person with
 * a SQL prompt. A node publishing a stamp that did not move when the database moved would be worse
 * than one publishing none, and the whole design of this class is aimed at that sentence.
 *
 * **Which is why a stamp exists only for a resource a writer claimed.** A read-only table gets
 * `undefined`, and a deployment that wires the registry into its read service and forgets the write
 * service gets no stamps at all rather than a set of stamps that never move. That is the failure
 * this cannot afford to make quiet, so it is made structurally impossible instead of documented.
 *
 * The door it opens is the interesting part and is not built yet: a node that *published* its
 * resource stamps in its own component state would give a declared resource the same
 * confirmed-current a record already has, because the stamp moves only on writes even though the
 * revision beside it moves on reads.
 */

/**
 * The separator, written as an escape and never as the byte - a literal NUL makes the file binary
 * to everything that sniffs content. It cannot occur in a resource segment, so no clever name can
 * forge a collision between `['a b']` and `['a','b']`.
 */
const SEPARATOR = '\u0000'

export class RpcResourceStamps {
    private readonly counts = new Map<string, number>()

    /**
     * @param life what tells one run of this process from the next.
     *
     * In the stamp because the counters start again at zero when a node restarts, and without it
     * the third write after a restart would produce a stamp a caller had already seen - the one way
     * an opaque token can quietly claim two different states are the same. Supplied by a caller
     * that has something better, which a component does: its epoch means exactly this.
     */
    constructor(private readonly life: string = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`) {}

    /** Say this node can write this resource, which is the only thing that makes a stamp truthful. */
    claim(resource: readonly string[]): void {
        const key = resource.join(SEPARATOR)
        if (!this.counts.has(key)) this.counts.set(key, 0)
    }

    /** Every resource a writer has claimed, in the order they were claimed. */
    get claimed(): readonly string[] {
        return [...this.counts.keys()]
    }

    /** The stamp of a resource, or absent where this node cannot speak for it. */
    of(resource: readonly string[]): string | undefined {
        const count = this.counts.get(resource.join(SEPARATOR))
        return count === undefined ? undefined : `${this.life}.${count.toString(36)}`
    }

    /**
     * A write this node served landed.
     *
     * Called on the write that *succeeded*, never on the one that was refused: a conflict is a
     * change that did not happen, and moving the stamp for one would tell every caching reader to
     * throw away a page that is still perfectly good.
     *
     * Silently does nothing for a resource nobody claimed, which is the right shape for a caller
     * that writes more than it declared - the alternative is a stamp that appears the first time
     * somebody writes and was absent from every answer before it.
     */
    moved(resource: readonly string[]): void {
        const key = resource.join(SEPARATOR)
        const count = this.counts.get(key)
        if (count !== undefined) this.counts.set(key, count + 1)
    }
}
