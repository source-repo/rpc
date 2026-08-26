/**
 * What arrives while nobody is authoritative.
 *
 * Between the barrier and the ownership swap there is a window in which A has stopped and B has not
 * started. It is short, and it is the whole reason the change is online rather than an outage: a
 * caller whose command lands in that window waits a few hundred milliseconds instead of receiving a
 * refusal. Buffering is therefore not an optimisation, it is the visible behaviour.
 *
 * Three things make it a buffer rather than a leak.
 *
 * **It is bounded.** A handoff that gets stuck with an unbounded buffer in front of it is an outage
 * of a different shape - one where every caller is still waiting, memory is climbing, and nothing
 * has failed loudly enough for anyone to act on. At the bound the buffer refuses, and a caller told
 * now can decide something.
 *
 * **It preserves order.** B processes exactly the sequence following the captured barrier. Not
 * approximately, and not in whatever order the release loop happens to iterate: the position each
 * input holds is the position it will be applied at, and a buffer that reordered would break the
 * one property the snapshot's `lastAppliedInputSequence` exists to name.
 *
 * **It is released once.** Release is a transition, not a mode. A buffer released twice would
 * deliver the same command twice - and for a non-repeatable command that is the failure the whole
 * design is arranged to prevent.
 */

/** What the transport underneath will do to a buffered input, which the buffer cannot improve on. */
export type RpcInboxSemantics = 'exactly-once' | 'at-least-once-deduplicated' | 'at-least-once'

export interface RpcBufferedInput<T> {
    /** Its position after the barrier: the barrier's `lastAppliedInputSequence` plus one, and up. */
    readonly sequence: bigint
    readonly input: T
}

export type RpcInboxRefusal = { readonly refused: 'full' | 'not-buffering' | 'released'; readonly why: string }

/**
 * The buffer, as a small state machine: `open` (nothing special happening) → `buffering` (barrier
 * established) → `releasing` → `open` again under the successor.
 *
 * `open` accepts nothing, deliberately. A buffer that quietly passed inputs through when it was not
 * buffering would be a component with two paths into it, and the second one is invisible in exactly
 * the situation where the first is being reasoned about carefully.
 */
export class RpcInputBuffer<T> {
    private state: 'open' | 'buffering' | 'releasing' | 'released' = 'open'
    private readonly held: RpcBufferedInput<T>[] = []
    private next: bigint

    constructor(
        /** The barrier's position. The first buffered input is this plus one. */
        readonly barrierSequence: bigint,
        readonly semantics: RpcInboxSemantics,
        readonly bound = 1024
    ) {
        this.next = barrierSequence + 1n
    }

    get buffering(): boolean {
        return this.state === 'buffering'
    }

    get depth(): number {
        return this.held.length
    }

    /** The position the next accepted input will take, so a caller can be told where it landed. */
    get nextSequence(): bigint {
        return this.next
    }

    /** Start holding. Called when the barrier goes in, before anything is captured. */
    begin(): void {
        if (this.state !== 'open') throw new Error(`the buffer for the barrier at ${this.barrierSequence} is ${this.state} and cannot begin again`)
        this.state = 'buffering'
    }

    /**
     * Hold one input, and say where it landed.
     *
     * The sequence is assigned here rather than carried in, because assigning it is what makes the
     * order a fact rather than a hope: two inputs that arrived in one tick would otherwise both
     * claim whatever the sender thought the position was.
     */
    accept(input: T): { readonly sequence: bigint } | RpcInboxRefusal {
        if (this.state === 'open') return { refused: 'not-buffering', why: 'no barrier is established, so this input belongs to the running activation rather than to a handoff' }
        if (this.state !== 'buffering') return { refused: 'released', why: `the buffer for the barrier at ${this.barrierSequence} has already been released and cannot take more` }
        if (this.held.length >= this.bound)
            return {
                refused: 'full',
                why: `the handoff buffer for the barrier at ${this.barrierSequence} is full at ${this.bound}: the handoff is taking longer than the buffer was sized for, and holding more would trade a short wait for a growing one`
            }
        const sequence = this.next
        this.next = sequence + 1n
        this.held.push({ sequence, input })
        return { sequence }
    }

    /**
     * Give everything to the successor, in order, exactly once.
     *
     * The successor is applied to each input in turn and awaited, so that an input which starts work
     * finishes before the next begins - the buffer's ordering guarantee is about *application*, and
     * handing all of them out at once would preserve the order of the handing and nothing else.
     *
     * A failure part-way stops the release and reports how far it got, rather than skipping to the
     * end. What has not been delivered is still held, which is what makes the position reportable
     * instead of lost.
     */
    async release(to: (input: T, sequence: bigint) => Promise<void> | void): Promise<{ readonly delivered: number; readonly through: bigint } | RpcInboxRefusal> {
        if (this.state !== 'buffering') return { refused: 'released', why: `the buffer for the barrier at ${this.barrierSequence} is ${this.state} and may be released only from buffering` }
        this.state = 'releasing'
        let delivered = 0
        let through = this.barrierSequence
        while (this.held.length) {
            const head = this.held[0]
            await to(head.input, head.sequence)
            this.held.shift()
            delivered += 1
            through = head.sequence
        }
        this.state = 'released'
        return { delivered, through }
    }

    /**
     * Give up on the handoff and hand everything back to the incumbent, in order.
     *
     * The failure table's ordinary case: quiescence expired, or capture refused, and A resumes
     * normal input. Rolling back is a delivery like any other and takes the same path, because a
     * buffer that dropped what it was holding when a handoff was abandoned would turn a *failed*
     * change into a *lossy* one - and only the second of those is unrecoverable.
     */
    async abandon(to: (input: T, sequence: bigint) => Promise<void> | void): Promise<{ readonly returned: number }> {
        if (this.state === 'released' || this.state === 'releasing') throw new Error(`the buffer for the barrier at ${this.barrierSequence} is ${this.state}: what it held has already gone to the successor`)
        this.state = 'releasing'
        let returned = 0
        while (this.held.length) {
            const head = this.held[0]
            await to(head.input, head.sequence)
            this.held.shift()
            returned += 1
        }
        this.state = 'released'
        return { returned }
    }
}
