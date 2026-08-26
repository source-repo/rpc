/**
 * Three states, and never two.
 *
 * A query cache reports `isStale`, and a comparison this repository has already written down says
 * what is wrong with that: **staleness is a policy wearing the costume of a fact.** `staleTime: 5000`
 * does not mean the data changed after five seconds, it means somebody decided to stop believing it
 * then - and on a plant, where a value is either the one the machine holds or it is not, a boolean
 * computed from a clock is an opinion presented as a measurement.
 *
 * What a Source RPC network has instead is a publisher that says when it changed. A page drawn at
 * the revision the channel currently holds is not "probably still good": the component has published
 * nothing since it was drawn, so it is **confirmed current** - and that is the state no pull cache
 * has ever been able to hold, because nothing was telling it.
 *
 * The third state is the one that keeps the first two honest. The signal is silently absent whenever
 * no channel is open, and the console does that routinely: a component whose state is only a record
 * has no typed leaves to subscribe to, so it opens no subscription at all and there is nothing to
 * compare against. Collapsing that into `possibly-changed` would look like caution and would in fact
 * be the same fake one level down - a screen saying "this may have changed" when what is true is
 * "nobody here knows". A `current` that is sometimes a guess is worth nothing.
 */
export type RpcFreshness =
    /** The publisher has said nothing since this was drawn. Not an age: a fact from the source. */
    | 'current'
    /** The publisher has said something since. Whether it touched *this* is a further question. */
    | 'possibly-changed'
    /** Nothing is watching, or what is watching cannot speak for this. Age is all there is. */
    | 'unknown'

/** When an answer was drawn. Both `$data` results carry these already; nothing is added to the wire. */
export interface RpcAnsweredAt {
    readonly epoch: string
    readonly revision: number
}

/**
 * What the channel holds now.
 *
 * Structurally an `RpcComponentView`, so a caller hands its component store over unchanged rather
 * than adapting it. The status is here because a revision is only news while the feed is live: a
 * stale channel's last revision is the last one it *heard*, not the last one the component published.
 */
export interface RpcChannelAt extends RpcAnsweredAt {
    readonly status: 'initializing' | 'live' | 'stale' | 'closed'
}

/**
 * What one answer's freshness is, given what the channel holds.
 *
 * The order of the tests is the argument.
 *
 * **A resource the revision does not govern is `unknown` before anything else is asked.** See
 * `revisionGoverns`: a declared resource lives behind the component rather than inside it, and the
 * store-backed nodes move their revision on reads.
 *
 * **An initializing channel is `unknown` and not a mismatch.** Its epoch is the empty string, which
 * differs from every real one - reading that as a restart would report every entry changed for as
 * long as the first snapshot takes to arrive, which on the slow link is exactly the wrong moment.
 *
 * **A different epoch is `possibly-changed`, and the caller drops the entry rather than showing it.**
 * A restart is not an update; the answer describes a world that no longer exists.
 *
 * **A lower revision than the channel's is `possibly-changed` whatever the status is.** That the feed
 * went quiet afterwards does not un-hear what it already said. Staleness can weaken `current` to
 * `unknown`; it can never weaken `possibly-changed`, which is a fact already in hand.
 *
 * **An answer *ahead* of the channel is current**, and it happens routinely: a request served at
 * revision 12 can be answered before the snapshot carrying 12 arrives. It is the newest thing known,
 * and it stops being so the moment something newer is published - which is the same test, run again.
 */
export const freshnessOf = (answer: RpcAnsweredAt, channel: RpcChannelAt | undefined, governed: boolean): RpcFreshness => {
    if (!governed || !channel || channel.status === 'initializing') return 'unknown'
    if (channel.epoch !== answer.epoch) return 'possibly-changed'
    if (answer.revision < channel.revision) return 'possibly-changed'
    return channel.status === 'live' ? 'current' : 'unknown'
}

/**
 * Whether an arriving answer is newer than the one already held, in the sense that decides whether
 * it may replace it.
 *
 * The reordering rule, and it is not hypothetical on a network where one peer may be reached over
 * MQTT and answer out of order. Two requests for one key, the second answered first: without this,
 * the first answer lands last and the cache ends up holding page two of a set that has moved on,
 * marked `current` because its revision matches nothing it was compared against.
 *
 * A different epoch always wins, because a restart is the newest thing there is. Otherwise the
 * higher revision wins, and an equal one wins too - the same revision answered twice is the same
 * data, and taking the later one costs nothing while making the common case need no special path.
 */
export const supersedes = (arriving: RpcAnsweredAt, held: RpcAnsweredAt | undefined): boolean =>
    !held || arriving.epoch !== held.epoch || arriving.revision >= held.revision
