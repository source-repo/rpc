import { QueryClient, QueryObserver, onlineManager, type QueryObserverResult } from '@tanstack/query-core'
import { TransportEvent, type RpcActivitySignal, type RpcGetListResult, type RpcGetManyResult } from '@source-repo/rpc'
import { freshnessOf, supersedes, type RpcChannelAt, type RpcFreshness } from './Freshness.js'
import { pathsOverlap, revisionGoverns, rpcComponentKey, rpcPeerKey, rpcQueryKey, type RpcQuestion, type RpcQueryKey } from './Key.js'
import { rpcQueryOptions, type RpcAttempt } from './Options.js'

/** What `$data` answers. Both shapes carry the epoch and revision they were drawn at. */
export type RpcDataAnswer = RpcGetListResult | RpcGetManyResult

/**
 * Where the freshness signal comes from: something holding a component's current epoch and revision.
 *
 * Structurally an `RpcComponentStore`, so a caller that already has one hands it over unchanged. The
 * cache **never opens a channel of its own**, and that is a decision rather than an omission:
 * subscribing to a whole snapshot in order to learn a revision would spend, on the link this exists
 * to protect, exactly what the pull half was built to avoid. Where nothing is watching, freshness is
 * `unknown` and says so.
 */
export interface RpcRevisionSource {
    getSnapshot(): RpcChannelAt
    subscribe(listener: () => void): () => void
}

/** A peer's transport lifecycle, narrowed to the one method this needs. */
export interface RpcLifecycle {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    off?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface RpcDataCacheOptions {
    /**
     * How a question is actually asked. Supplied, so this package opens nothing and knows nothing
     * about proxies, targets or transports - which is also what makes every rule below testable
     * without a network.
     */
    ask(question: RpcQuestion, attempt: RpcAttempt): Promise<RpcDataAnswer>
    /** An application's own client, where it has one. A private one is made otherwise. */
    queryClient?: QueryClient
    /**
     * How long an answer is believed when **nothing can say whether it changed** - no channel open,
     * or a resource the revision does not govern. This is the age window, and it is the one place
     * `staleTime` is honest: where there is no signal, a clock is all there is. Where there is one,
     * it is not consulted at all.
     */
    unknownStaleMs?: number
    /**
     * How long an answer nobody is watching is kept.
     *
     * A caveat rather than a default, because the cache bounds by **time and not by count or bytes**:
     * a peer that runs for months over a wide key space - one entry per resource per filter per page
     * - accumulates until this expires them, and five minutes of a busy console is a lot of pages.
     */
    gcTime?: number
    /** The budget put on every request, across attempts. See `RpcQueryBehaviour.deadlineMs`. */
    deadlineMs?: number
    /**
     * The link, so that "offline" means *this* link rather than `navigator.onLine`.
     *
     * Worth wiring even though the failure is in the safe direction: a browser on a plant LAN with
     * no route to the peer reports itself online, so unwired the cache simply never pauses. Wired,
     * a request made while the link is down waits for the link instead of burning its budget on a
     * transport that already knows it cannot send.
     */
    lifecycle?: RpcLifecycle
}

/** What a watcher sees. The same shape a polled pane already drew, with the fact it could not have. */
export interface RpcDataState<T extends RpcDataAnswer = RpcDataAnswer> {
    /** The last answer, kept across refetches so a grid never blanks. */
    readonly data?: T
    readonly error?: string
    readonly fetching: boolean
    /** When the fetch in flight began, so a pane can say how long it has been waiting. */
    readonly since?: number
    readonly freshness: RpcFreshness
}

export interface RpcDataWatchOptions {
    /**
     * How long to wait after an answer before considering asking again.
     *
     * Considering, not asking. **A period tick over a `current` entry costs nothing at all** - the
     * publisher has said nothing since the page was drawn, so there is nothing to ask for - which is
     * the whole difference between this and the polling loop it replaces. A five second period
     * against a quiet plant becomes free, and the same five seconds against a moving one behaves
     * exactly as it did.
     *
     * Absent means ask once and then only when told, which is the honest setting on a link whose
     * round trip is minutes.
     */
    periodMs?: number
    /**
     * Whether anybody is looking. Injected rather than read from the DOM, like the channel's own -
     * this package runs in Node as readily as in a browser, and `visibilityActivity()` is the
     * browser implementation of the same interface.
     */
    activity?: RpcActivitySignal
}

export interface RpcDataWatch<T extends RpcDataAnswer = RpcDataAnswer> {
    getSnapshot(): RpcDataState<T>
    subscribe(listener: () => void): () => void
    /** Ask now, out of band, and restart the period from the answer. */
    refresh(): void
    close(): void
}

/** What a settled call claims to have changed. Either form, and neither is required. */
export interface RpcSettledClaim {
    readonly target: string
    readonly namespace: string
    /**
     * The resource a call was *about*, which is a structural fact rather than a claim: an action
     * offered on a row comes from that resource's own `actions` list, so where the button lives is
     * what it touched.
     */
    readonly resource?: readonly string[]
    /**
     * What the method declared it sets, as `describe()` publishes it - `zones.top.setpoint`, spelled
     * from `state`.
     */
    readonly sets?: string
}

/**
 * The separator, written as an escape and never as the byte.
 *
 * A literal NUL makes the file binary to everything that decides by sniffing content: grep matches
 * and prints nothing, and git stops diffing it. It is still the right separator - it cannot occur in
 * a peer name or a namespace, so no clever name can forge a collision - it just has to be spelled.
 */
const SEPARATOR = '\u0000'

const watchKey = (target: string, namespace: string) => `${target}${SEPARATOR}${namespace}`

/**
 * The pull half: a query cache whose freshness comes from the publisher.
 *
 * **What is theirs and what is ours** is the line this whole package is drawn on. Dedup, storage,
 * eviction, backoff, stale-while-revalidate, persistence, devtools - none of it interesting, all of
 * it fiddly, and rebuilding it would be rebuilding it twice. What is ours is unobtainable from any
 * cache library: that a page drawn at the revision the channel currently holds is *confirmed
 * current*; that `semantics` decides whether a retry is safe at all; that a deadline is a budget the
 * caller declared rather than a per-attempt timeout; and the key that makes two questions the same
 * question.
 *
 * It is not a browser thing. `@tanstack/query-core` is framework-agnostic and dependency-free - it
 * is what the React, Vue and Svelte bindings all sit on - and everything used here runs in Node.
 * Two services pulling from a third get the same dedup, the same budget arithmetic and the same
 * confirmed-current, with `useSyncExternalStore` replaced by whatever they already have.
 */
export class RpcDataCache {
    readonly queryClient: QueryClient
    private readonly ask: RpcDataCacheOptions['ask']
    private readonly unknownStaleMs: number
    private readonly deadlineMs?: number
    private readonly sources = new Map<string, { source: RpcRevisionSource; stop: () => void; last?: RpcChannelAt }>()
    private readonly undoOnline: (() => void)[] = []

    constructor(options: RpcDataCacheOptions) {
        this.ask = options.ask
        this.unknownStaleMs = options.unknownStaleMs ?? 0
        this.deadlineMs = options.deadlineMs
        this.queryClient =
            options.queryClient ??
            new QueryClient({
                defaultOptions: {
                    queries: {
                        gcTime: options.gcTime ?? 5 * 60_000,
                        // Off, all three. A window regaining focus is not news about a plant, and a
                        // component remounting is not either - what decides whether to ask again is
                        // the freshness below and the caller's own period, and leaving these on
                        // would spend the link every time an operator alt-tabbed back.
                        refetchOnWindowFocus: false,
                        refetchOnReconnect: false,
                        refetchOnMount: false
                    }
                }
            })
        // Mounted, and it is not ceremony: a request made while the link is down is *paused* rather
        // than failed, and what resumes it is the client's own subscription to the online manager.
        // Unmounted, the pause would be permanent - which is the one failure mode worse than not
        // pausing at all. Reference counted, so a shared client stays mounted for its own reasons.
        this.queryClient.mount()
        if (options.lifecycle) this.undoOnline.push(rpcOnlineFrom(options.lifecycle))
    }

    /**
     * Take the freshness signal for one component from a channel somebody else opened.
     *
     * Returns the way to stop. Registering the same pair twice replaces the first, because two
     * sources for one component would each answer for it and the answers could disagree.
     */
    observe(target: string, namespace: string, source: RpcRevisionSource): () => void {
        this.forgetSource(target, namespace)
        const entry: { source: RpcRevisionSource; stop: () => void; last?: RpcChannelAt } = { source, stop: () => undefined }
        const at = source.getSnapshot()
        if (at.status !== 'initializing') entry.last = at
        this.sources.set(watchKey(target, namespace), entry)
        entry.stop = source.subscribe(() => this.moved(target, namespace))
        return () => this.forgetSource(target, namespace)
    }

    /** What the channel holds for one component, or nothing where none is being watched. */
    channelAt(target: string, namespace: string): RpcChannelAt | undefined {
        const entry = this.sources.get(watchKey(target, namespace))
        if (!entry) return undefined
        const at = entry.source.getSnapshot()
        return at.status === 'initializing' ? undefined : at
    }

    key(question: RpcQuestion): RpcQueryKey {
        return rpcQueryKey(question)
    }

    /** What is known about the answer held for one question, without asking anything. */
    freshness(question: RpcQuestion): RpcFreshness {
        return this.freshnessOfKey(rpcQueryKey(question) as unknown as readonly unknown[], question.target, question.namespace, question.resource)
    }

    /**
     * Ask, or answer from what is held.
     *
     * The one-shot form, deduplicated: two callers asking the same question while one request is in
     * flight get the one answer, which is stampede protection the cache does by construction and is
     * most of why it is worth integrating rather than writing.
     */
    async fetch<T extends RpcDataAnswer = RpcDataAnswer>(question: RpcQuestion): Promise<T> {
        return (await this.queryClient.fetchQuery(this.options(question))) as T
    }

    /**
     * The subscribed form: an observer, a period that skips what it does not need, and a snapshot
     * shaped for `useSyncExternalStore` - or for anything else with the same two methods.
     */
    watch<T extends RpcDataAnswer = RpcDataAnswer>(question: RpcQuestion, options: RpcDataWatchOptions = {}): RpcDataWatch<T> {
        return new DataWatch<T>(this, question, options)
    }

    /**
     * A call settled, and it claims to have changed something. Ask that again, and nothing else.
     *
     * **Never a trigger on its own.** A claim with neither a resource nor a `sets` invalidates
     * nothing at all, and that degradation is the point rather than a gap: `sets` declares *intent*,
     * carries no compatibility rule, and is optional - so a method that says nothing must cost
     * nothing. What still covers that case is the revision compare, which is a fact from the
     * publisher rather than a claim from the caller.
     *
     * This replaces a counter the console kept that re-asked *every* collection in the pane after
     * any successful edit - one round trip per collection, on the link least able to spare it, for a
     * command that touched one field.
     *
     * Returns how many entries matched, so a caller - and a test - can see when it degraded to none.
     */
    settled(claim: RpcSettledClaim): number {
        const path = claim.resource ?? (claim.sets ? ['state', ...claim.sets.split('.').filter(Boolean)] : undefined)
        if (!path?.length) return 0
        const filters = {
            queryKey: rpcComponentKey(claim.target, claim.namespace),
            predicate: (query: { queryKey: readonly unknown[] }) => pathsOverlap(query.queryKey[3] as readonly string[], path)
        }
        const matched = this.queryClient.getQueryCache().findAll(filters).length
        // `active`, so a pane that is open re-asks now and one that is not is only marked. Waiting a
        // period to find out whether the plant accepted `setSetpoint(180)` is the one place a period
        // is plainly wrong, and it is the only place this package asks for anything unprompted.
        void this.queryClient.invalidateQueries({ ...filters, refetchType: 'active' })
        return matched
    }

    /** Everything cached from one peer, gone. What a peer being displaced or removed means. */
    forgetPeer(target: string): void {
        void this.queryClient.removeQueries({ queryKey: rpcPeerKey(target) })
    }

    close(): void {
        this.queryClient.unmount()
        for (const key of [...this.sources.keys()]) {
            const entry = this.sources.get(key)
            entry?.stop()
            this.sources.delete(key)
        }
        for (const undo of this.undoOnline.splice(0)) undo()
        this.queryClient.clear()
    }

    /** The options for one question, exposed so an application can hand them to its own binding. */
    options(question: RpcQuestion) {
        const key = rpcQueryKey(question) as unknown as readonly unknown[]
        const base = rpcQueryOptions<RpcDataAnswer>(
            async (attempt) => {
                const answer = await this.ask(question, attempt)
                const held = this.queryClient.getQueryData<RpcDataAnswer>(key)
                // The reordering rule. A late answer carrying a lower revision than the one already
                // held says nothing newer, and letting it land would leave the cache holding an
                // older page stamped with a revision that no longer compares to anything - reported
                // `current` on a test that was never really made. Keeping what is held discards
                // nothing: the newer answer is still there, and this one had nothing to add.
                return held && !supersedes(answer, held) ? held : answer
            },
            // `$data` reads and answers; there is no verb beside it that writes. So it is repeatable
            // by construction rather than by declaration, and this is the one place in this package
            // where a semantics is asserted rather than read.
            { semantics: 'query', deadlineMs: this.deadlineMs }
        )
        return {
            ...base,
            queryKey: key,
            /**
             * The library's own knob, carrying a fact it was never able to have.
             *
             * `Infinity` while the answer is confirmed current, so a second pane opening the same
             * question asks for nothing and a period tick has nothing to do. Otherwise the age
             * window, which is what `staleTime` was always for and is honest exactly where there is
             * no signal to be had.
             */
            staleTime: () => (this.freshnessOfKey(key, question.target, question.namespace, question.resource) === 'current' ? Infinity : this.unknownStaleMs)
        }
    }

    /** The freshness of whatever is held under a key that is already in hand. */
    freshnessOfKey(key: readonly unknown[], target: string, namespace: string, resource: readonly string[]): RpcFreshness {
        const held = this.queryClient.getQueryData<RpcDataAnswer>(key)
        if (!held) return 'unknown'
        return freshnessOf(held, this.channelAt(target, namespace), revisionGoverns(resource))
    }

    private forgetSource(target: string, namespace: string) {
        const existing = this.sources.get(watchKey(target, namespace))
        if (!existing) return
        existing.stop()
        this.sources.delete(watchKey(target, namespace))
    }

    /**
     * The channel published something. What that invalidates depends on *what kind* of change it is,
     * and the two are deliberately not the same rule.
     */
    private moved(target: string, namespace: string) {
        const entry = this.sources.get(watchKey(target, namespace))
        if (!entry) return
        const at = entry.source.getSnapshot()
        if (at.status === 'initializing') return
        const previous = entry.last
        entry.last = at
        if (!previous) return
        if (previous.epoch !== at.epoch) {
            // **A restart takes the declared resources with it**, which the revision move below
            // deliberately does not. A component that came back is a process that was restarted, and
            // a store-backed one may have reconnected to a different database, replayed a queue or
            // been pointed somewhere else entirely - so nothing it said in a previous life survives.
            // Reset rather than remove: the data goes, so nothing from before can be drawn, and only
            // what somebody is actually watching is asked for again.
            void this.queryClient.resetQueries({ queryKey: rpcComponentKey(target, namespace) })
            return
        }
        if (at.revision <= previous.revision) return
        void this.queryClient.invalidateQueries({
            queryKey: rpcComponentKey(target, namespace),
            // Marked, not fetched. The publisher's rate is the publisher's; a component committing
            // sixty times a second would otherwise become sixty requests a second from every console
            // watching it. What the mark buys is that the caller's *next* period tick asks - and
            // that the ticks before it did not.
            refetchType: 'none',
            predicate: (query) => revisionGoverns(query.queryKey[3] as readonly string[])
        })
    }
}

/**
 * Make "offline" mean this link.
 *
 * A cache pauses requests when it believes there is no network, and in a browser it believes
 * `navigator.onLine` - which is true on a plant LAN with no route to the peer, and false on a laptop
 * whose Wi-Fi dropped while the plant is reachable over Ethernet. The link itself knows, and says
 * so on every transition including reconnects, so it is a strictly better source and the same one in
 * Node and in a browser.
 *
 * Returns the way to undo it. A caller with two links is a caller that should be deciding this
 * itself rather than having whichever wired last win silently.
 */
export const rpcOnlineFrom = (lifecycle: RpcLifecycle): (() => void) => {
    let stop: (() => void) | undefined
    onlineManager.setEventListener((setOnline) => {
        const up = () => setOnline(true)
        const down = () => setOnline(false)
        lifecycle.on(TransportEvent.connected, up)
        lifecycle.on(TransportEvent.disconnected, down)
        stop = () => {
            lifecycle.off?.(TransportEvent.connected, up)
            lifecycle.off?.(TransportEvent.disconnected, down)
        }
        return stop
    })
    return () => {
        stop?.()
        onlineManager.setOnline(true)
    }
}

/**
 * One watched question.
 *
 * A `QueryObserver` with a period on top, and the period is where the interesting behaviour is: the
 * loop skips entirely while the entry is confirmed current, which is a poll that costs nothing while
 * the plant is quiet and behaves exactly as before while it is not.
 */
class DataWatch<T extends RpcDataAnswer> implements RpcDataWatch<T> {
    private readonly observer: QueryObserver<RpcDataAnswer, Error, RpcDataAnswer>
    private readonly listeners = new Set<() => void>()
    private readonly stops: (() => void)[] = []
    private timer: ReturnType<typeof setTimeout> | undefined
    private snapshot: RpcDataState<T>
    private since: number | undefined
    private active: boolean
    private closed = false

    constructor(
        private readonly cache: RpcDataCache,
        private readonly question: RpcQuestion,
        private readonly options: RpcDataWatchOptions
    ) {
        this.active = options.activity?.active ?? true
        // `enabled` rather than simply not calling anything, because an observer with no data yet
        // fetches when it is subscribed to whatever `refetchOnMount` says - that path is the initial
        // load rather than a refetch, and it is the only one this flag reaches.
        this.observer = new QueryObserver(cache.queryClient, { ...cache.options(question), enabled: this.active })
        this.snapshot = this.build(this.observer.getCurrentResult())
        this.stops.push(this.observer.subscribe((result) => this.settle(result)))
        if (options.activity) {
            this.stops.push(
                options.activity.subscribe((active) => {
                    this.active = active
                    this.observer.setOptions({ ...cache.options(question), enabled: active })
                    if (!active) return this.disarm()
                    // Coming back asks immediately rather than waiting out a period, unless there is
                    // nothing to ask: while nobody was looking the channel may have gone quiet, and
                    // a confirmed-current answer is still confirmed current.
                    if (this.freshness() === 'current') this.arm()
                    else this.refresh()
                })
            )
        }
    }

    getSnapshot(): RpcDataState<T> {
        return this.snapshot
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    refresh(): void {
        if (this.closed) return
        this.disarm()
        void this.observer.refetch().catch(() => undefined)
    }

    close(): void {
        this.closed = true
        this.disarm()
        for (const stop of this.stops.splice(0)) stop()
        this.listeners.clear()
    }

    private freshness(): RpcFreshness {
        return this.cache.freshnessOfKey(this.observer.options.queryKey as readonly unknown[], this.question.target, this.question.namespace, this.question.resource)
    }

    private settle(result: QueryObserverResult<RpcDataAnswer, Error>) {
        if (this.closed) return
        if (result.isFetching && this.since === undefined) this.since = Date.now()
        if (!result.isFetching) this.since = undefined
        this.snapshot = this.build(result)
        for (const listener of [...this.listeners]) listener()
        if (!result.isFetching) this.arm()
    }

    private build(result: QueryObserverResult<RpcDataAnswer, Error>): RpcDataState<T> {
        return {
            data: result.data as T | undefined,
            // A message rather than the error, because what a pane draws is a sentence. The last
            // good page stays beside it: a link that dropped is not a collection that emptied.
            error: result.error ? (result.error.message ?? String(result.error)) : undefined,
            fetching: result.isFetching,
            since: this.since,
            freshness: this.freshness()
        }
    }

    private arm() {
        this.disarm()
        if (this.closed || !this.active || !this.options.periodMs) return
        this.timer = setTimeout(() => {
            this.timer = undefined
            if (this.closed || !this.active) return
            // The whole point, in one line: a tick over a confirmed-current answer asks for nothing
            // and re-arms. The publisher has said nothing since the page was drawn, so there is
            // nothing on the far side to fetch - and on a slow link the request that is never made
            // is worth more than any amount of caching the one that is.
            if (this.freshness() === 'current') return this.arm()
            void this.observer.refetch().catch(() => undefined)
        }, this.options.periodMs)
    }

    private disarm() {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = undefined
    }
}
