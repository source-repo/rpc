import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ILogger } from '../Logging/ILogger.js'

/**
 * Observable components: a long-lived RPC instance with two cached, read-only snapshots.
 *
 * `props` are the host's inputs - configuration, limits, location, a desired state where the domain
 * uses that convention. `state` is the instance's own public snapshot - mode, health, reported
 * values. Remote clients read both synchronously from a local cache and mutate neither: a client
 * that wants the world to change calls a typed method, whose semantics, authorization, deadline and
 * idempotency the library already carries. Anything less explicit than a method is how a property
 * assignment ends up commanding a pump with no place to put a TransportError.
 *
 * The snapshot travels whole. Full snapshots make reconnect recovery a resend rather than a patch
 * chain that one missed frame corrupts; most component state should be small and summarized, and
 * what is not small belongs in events, queues or a stream, not here.
 */

export type RpcComponentData = Record<string, unknown>

/**
 * Who is in control of this component, visible to every observer - the plant's arbitration state,
 * carried in the snapshot beside props and state rather than inside either: it is the library's
 * bookkeeping, not the class's contract, and it must not collide with a schema-checked state shape.
 */
export interface RpcComponentAuthority {
    /** Peer currently holding authority, as the transport vouched for it. Absent when free. */
    readonly holder?: string
    /** When the hold lapses on its own. A lease always expires - one that cannot is a mutex. */
    readonly expiresAt?: number
    /**
     * Increments on every grant, take, release and expiry - never on a holder's renewal, so a
     * holder's own in-flight commands survive extending the lease. The visible fence counter: the
     * within-epoch cousin of the topology spec's durable ownerEpoch, which arrives with M4.
     */
    readonly generation: number
}

export interface RpcComponentSnapshot<P extends RpcComponentData, S extends RpcComponentData> {
    /** Changes when the component instance is reconstructed - a restart is a new epoch. */
    readonly epoch: string
    /** Strictly increasing within one epoch. Published revisions may skip, never move backwards. */
    readonly revision: number
    readonly props: Readonly<P>
    readonly state: Readonly<S>
    /** Optional on the wire: a snapshot from a server older than the lease simply has no holder. */
    readonly authority?: RpcComponentAuthority
    /**
     * What each sliced record actually held, so a caller can page it without having to ask twice.
     *
     * `total` is the only thing a caller cannot work out for itself: the entries it received tell
     * it what is on this page and nothing about how many pages there are. A record's keys are data
     * rather than type, so nothing in the contract can say either.
     */
    readonly slices?: readonly RpcProjectedSlice[]
    /**
     * The paths this snapshot carries, when it carries only some of them. Absent means the whole
     * thing, which is what every snapshot was before projections existed and still is by default.
     *
     * It has to be stated rather than inferred, and this is the field the whole feature turns on: a
     * projected snapshot and a snapshot whose other fields have gone are the same bytes. A receiver
     * that could not tell them apart would read a narrowed subscription as a component that had
     * dropped half its state, and a cache merging them would be inventing.
     */
    readonly projection?: readonly RpcProjectionEntry[]
}

/**
 * One thing a subscriber asked for: a path, or a path into a record with a window over its entries.
 *
 * A plain path is the ordinary case and stays a plain array, so nothing that already worked changes
 * shape. The slice form exists because **a record's keys are data, not type**: the contract says
 * `{ [tag: string]: Reading }` and stops there, so a caller wanting fifty of three hundred tags
 * cannot name them - the only path that reaches them is the record itself, which is all three
 * hundred, and asking for everything to find out what to ask for is the thing projections exist to
 * avoid.
 *
 * Keys and values come back together deliberately. Asking for the key list and then asking again
 * for the values of a page would be two round trips per page, which is nothing on a pipeline and
 * unusable on a link whose round trip is measured in minutes.
 */
export type RpcProjectionEntry = readonly string[] | RpcProjectionSlice

export interface RpcProjectionSlice {
    /** The record to page. A path that does not reach a record yields nothing rather than erring. */
    readonly path: readonly string[]
    /** How many entries to skip, in key order. Defaults to none. */
    readonly offset?: number
    /**
     * How many to take. Absent means all of them from `offset`, which is how a caller says "the rest".
     *
     * **Zero is a count, and deliberately so.** It takes no entries and the slice still reports
     * `total`, which is how a caller learns the size of a record - and therefore how many pages
     * there are - for one number rather than for the record. That falls out of the arithmetic, but
     * it is stated and tested here rather than left as something that merely happens to work, since
     * a caller relying on it should not have to discover it by trying. `$data`'s `pageSize` answers
     * the same question the same way, and the two agreeing is the point.
     *
     * The record itself is then *absent* from the snapshot rather than present and empty, which is
     * the more honest of the two: `{}` would say the record is there and holds nothing, where the
     * slice beside it says it holds three hundred and that none of them were asked for.
     */
    readonly limit?: number
}

/** What one sliced record held, and how much of it there was. */
export interface RpcProjectedSlice {
    readonly path: readonly string[]
    readonly offset: number
    readonly keys: readonly string[]
    /** Entries in the record, which is what a caller needs to know how many pages exist. */
    readonly total: number
}

/** A slice entry, distinguished from a plain path without narrowing on a property that could collide. */
export const isProjectionSlice = (entry: RpcProjectionEntry): entry is RpcProjectionSlice => !Array.isArray(entry)

/**
 * Keys in a stable, agreed order, because an offset means nothing without one.
 *
 * Sorted rather than insertion-ordered: insertion order is a property of how the component happened
 * to build its state, so page 2 could hold something different after a restart that populated the
 * record in another sequence - and a caller paging through would see an entry twice and another not
 * at all, with nothing to indicate it.
 */
export const projectionKeyOrder = (record: RpcComponentData) => Object.keys(record).sort()

/**
 * The event name a component's snapshots travel under. Reserved the way `$with` is: the `$` prefix
 * marks it as the library's, so a class cannot accidentally expose an event that collides with it.
 * It is served to authorized subscribers only, never listed in introspection, and clients cannot
 * emit it - events only flow outward from a server.
 */
export const componentSnapshotEvent = '$snapshot'

interface ComponentInternals {
    epoch: string
    revision: number
    props: Readonly<RpcComponentData>
    state: Readonly<RpcComponentData>
    authority: RpcComponentAuthority
    /** Cleared and re-armed on every grant and renewal; unref'd so it cannot hold a process open. */
    expiryTimer?: NodeJS.Timeout
    /** Installed at exposure. Until then commits are local and nobody is listening. */
    notify?: () => void
    /** Installed at exposure when snapshot validation is on. A problem string refuses the commit. */
    validate?: (props: Readonly<RpcComponentData>, state: Readonly<RpcComponentData>) => string | undefined
}

/** Internals live beside the instance, not on it, so nothing here appears on the prototype walk. */
const internals = new WeakMap<object, ComponentInternals>()

const internalsOf = (component: object): ComponentInternals => {
    const found = internals.get(component)
    if (!found) throw new Error('not an RpcComponent - components are constructed through the RpcComponent base class')
    return found
}

/** Shallow copy, shallow freeze. Deep freezing is expensive and hostile to typed arrays. */
const frozen = <T extends RpcComponentData>(value: T): Readonly<T> => Object.freeze({ ...value })

const commit = (component: object, next: { props?: Readonly<RpcComponentData>; state?: Readonly<RpcComponentData> }) => {
    const held = internalsOf(component)
    const props = next.props ?? held.props
    const state = next.state ?? held.state
    // Validated before anything changes: an invalid snapshot must leave the previous one current,
    // not poison the cache first and complain afterwards. This is a self-check on server code, so
    // it throws at the setState call site - which is exactly where the bug is.
    const problem = held.validate?.(props, state)
    if (problem) throw new Error(`component snapshot rejected: ${problem}`)
    held.props = props
    held.state = state
    held.revision++
    held.notify?.()
}

export abstract class RpcComponent<P extends RpcComponentData, S extends RpcComponentData> extends EventEmitter {
    protected constructor(initialProps: P, initialState: S) {
        super()
        internals.set(this, { epoch: uuidv4(), revision: 0, props: frozen(initialProps), state: frozen(initialState), authority: Object.freeze({ generation: 0 }) })
    }

    public get props(): Readonly<P> {
        return internalsOf(this).props as Readonly<P>
    }

    public get state(): Readonly<S> {
        return internalsOf(this).state as Readonly<S>
    }

    /**
     * Own-property arrow functions rather than prototype methods, so the exposure scan cannot find
     * them - but that is consistency, not the guarantee. The guarantee is the `@rpc` allow-list a
     * component class is expected to use; a protected helper that mutated state on behalf of any
     * remote caller would be a command with no semantics, no authorization and no contract.
     */
    protected readonly setState = (update: Partial<S> | ((previous: Readonly<S>) => Partial<S>)): Readonly<S> => {
        const previous = this.state
        const patch = typeof update === 'function' ? update(previous) : update
        commit(this, { state: frozen({ ...previous, ...patch }) })
        return this.state
    }

    protected readonly replaceState = (update: S | ((previous: Readonly<S>) => S)): Readonly<S> => {
        const next = typeof update === 'function' ? update(this.state) : update
        commit(this, { state: frozen(next) })
        return this.state
    }
}

export interface RpcComponentHost<P extends RpcComponentData, S extends RpcComponentData> {
    getSnapshot(): RpcComponentSnapshot<P, S>
    /** Atomic at snapshot level: the whole props object is replaced, never patched in place. */
    replaceProps(update: P | ((previous: Readonly<P>) => P)): RpcComponentSnapshot<P, S>
}

/**
 * The local side's controller. Only code that holds the instance can obtain one, and it is never
 * reachable through a proxy - remote props are read-only by construction, not by convention.
 */
export const componentHost = <P extends RpcComponentData, S extends RpcComponentData>(component: RpcComponent<P, S>): RpcComponentHost<P, S> => ({
    getSnapshot: () => componentSnapshot(component) as RpcComponentSnapshot<P, S>,
    replaceProps: (update) => {
        const previous = component.props
        const next = typeof update === 'function' ? update(previous) : update
        commit(component, { props: frozen(next) })
        return componentSnapshot(component) as RpcComponentSnapshot<P, S>
    }
})

/** The current snapshot, for the exposure machinery and the host. */
export const componentSnapshot = (component: object): RpcComponentSnapshot<RpcComponentData, RpcComponentData> => {
    const held = internalsOf(component)
    return { epoch: held.epoch, revision: held.revision, props: held.props, state: held.state, authority: held.authority }
}

/**
 * One subscriber's narrowing of a snapshot: the named paths and nothing else.
 *
 * A component whose state carries three hundred tags sends all three hundred every time one moves,
 * which is free on a fast link and is the link itself on a slow one - a 12 kB snapshot is eighty
 * seconds at 1200 baud, so a screen showing twenty values cannot be drawn at all. Naming the paths
 * is the same answer the write side reached: say which, ask for that.
 *
 * **What comes back is still a whole snapshot** - of the projection. Every property that makes this
 * channel simple survives: duplicate delivery is still harmless, a reconnect is still repaired by
 * one frame rather than a replay, and the epoch and revision rules are untouched. What changes is
 * only how much of the state is in it, which is why this comes before delta encoding rather than
 * after - it needs no base tracking, no keyframe schedule and no new counter.
 *
 * A path that reaches nothing is simply absent from the result rather than an error. The state is
 * data and a caller may legitimately name a tag that has not appeared yet; refusing the whole
 * subscription because one of twenty paths is not currently populated would make a projection less
 * robust than the whole snapshot it replaces, which would be a poor trade.
 */
export const projectSnapshot = (
    snapshot: RpcComponentSnapshot<RpcComponentData, RpcComponentData>,
    entries: readonly RpcProjectionEntry[]
): RpcComponentSnapshot<RpcComponentData, RpcComponentData> => {
    const props: RpcComponentData = {}
    const state: RpcComponentData = {}
    const slices: RpcProjectedSlice[] = []
    for (const entry of entries) {
        const path = isProjectionSlice(entry) ? entry.path : entry
        if (!path.length) continue
        // `props` and `state` are the two roots a path may start at, so the first segment chooses
        // which - the same spelling a reader uses, and the same one `sets` uses on the write side.
        const [root, ...rest] = path
        const from = root === 'props' ? snapshot.props : root === 'state' ? snapshot.state : undefined
        const into = root === 'props' ? props : root === 'state' ? state : undefined
        if (!from || !into) continue
        if (!isProjectionSlice(entry)) {
            copyPath(from, into, rest)
            continue
        }
        const record = resolvePath(from, rest)
        // A path that reaches no record yields nothing rather than erring, for the same reason a
        // path reaching no value does: state is data, and a record a caller expects may not have
        // been populated yet. Reported as a slice of zero rather than omitted, so the difference
        // between "not there" and "never asked" stays visible.
        if (record === undefined || record === null || typeof record !== 'object' || Array.isArray(record)) {
            slices.push({ path, offset: entry.offset ?? 0, keys: [], total: 0 })
            continue
        }
        const ordered = projectionKeyOrder(record as RpcComponentData)
        const offset = Math.max(0, Math.trunc(entry.offset ?? 0))
        const taken = entry.limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + Math.max(0, Math.trunc(entry.limit)))
        for (const key of taken) copyPath(from, into, [...rest, key])
        slices.push({ path, offset, keys: taken, total: ordered.length })
    }
    return { ...snapshot, props, state, projection: entries, ...(slices.length ? { slices } : {}) }
}

/** Walk to whatever a path names, or undefined where it reaches nothing. */
const resolvePath = (from: RpcComponentData, path: readonly string[]): unknown => {
    let at: unknown = from
    for (const segment of path) {
        if (at === null || typeof at !== 'object' || !(segment in (at as RpcComponentData))) return undefined
        at = (at as RpcComponentData)[segment]
    }
    return at
}

/**
 * Copy one path's value across, creating only the branches that path passes through.
 *
 * Resolved before anything is built, so a path that reaches nothing leaves nothing behind it: an
 * empty `tags: {}` where a caller asked for `tags['tag.999']` says the record exists and is empty,
 * which is a different and false statement about the plant. Building only after the leaf is found
 * also lets sibling paths share a branch - `zones.top.setpoint` and `zones.top.temperature` meet at
 * the same object rather than the second replacing the first.
 */
const copyPath = (from: RpcComponentData, into: RpcComponentData, path: readonly string[]) => {
    // An empty tail names the whole root, which is how `['state']` asks for all of it.
    if (!path.length) {
        for (const [key, value] of Object.entries(from)) into[key] = value
        return
    }
    let at: unknown = from
    for (const segment of path) {
        if (at === null || typeof at !== 'object' || !(segment in (at as RpcComponentData))) return
        at = (at as RpcComponentData)[segment]
    }
    let branch = into
    for (const segment of path.slice(0, -1)) branch = (branch[segment] ??= {}) as RpcComponentData
    branch[path[path.length - 1]] = at
}

/** The current arbitration state, for the dispatch layer's authority checks. */
export const componentAuthority = (component: object): RpcComponentAuthority => internalsOf(component).authority

/** A lease always expires. The default is long enough to work under, short enough to walk away from. */
export const DEFAULT_AUTHORITY_TTL = 60_000

export type RpcAuthorityChangeReason = 'acquired' | 'renewed' | 'taken' | 'released' | 'expired'

/** Emitted on the component as the `authorityChanged` event, so expiry and takeover are observable. */
export interface RpcAuthorityChange {
    readonly reason: RpcAuthorityChangeReason
    readonly authority: RpcComponentAuthority
    readonly previousHolder?: string
}

/**
 * Replace the arbitration state and tell the world: revision bumps so the snapshot republishes with
 * the new holder in it, and `authorityChanged` carries the reason - a snapshot alone can say who is
 * in control now, but not whether the last holder released or was expired out.
 */
const commitAuthority = (component: object, next: RpcComponentAuthority, reason: RpcAuthorityChangeReason) => {
    const held = internalsOf(component)
    const previousHolder = held.authority.holder
    if (held.expiryTimer) clearTimeout(held.expiryTimer)
    held.expiryTimer = undefined
    held.authority = Object.freeze(next)
    held.revision++
    if (next.expiresAt !== undefined) {
        held.expiryTimer = setTimeout(() => {
            held.expiryTimer = undefined
            // Re-read rather than close over: a release or takeover that beat the timer already
            // committed, and this fire must not expire a lease that is no longer the one it timed.
            if (held.authority.holder !== next.holder || held.authority.generation !== next.generation) return
            commitAuthority(component, { generation: held.authority.generation + 1 }, 'expired')
        }, next.expiresAt - Date.now())
        held.expiryTimer.unref?.()
    }
    if (component instanceof EventEmitter) component.emit('authorityChanged', { reason, authority: held.authority, previousHolder } satisfies RpcAuthorityChange)
    held.notify?.()
}

export type RpcAuthorityOutcome = { granted: true; authority: RpcComponentAuthority } | { granted: false; holder: string; expiresAt: number }

/**
 * One caller asking for control. Free: granted. Held by the caller: renewed - same generation, so
 * the holder's own queued commands survive the extension. Held by another: refused with the holder
 * named, unless `take`, which is the break-in every real plant panel has - authorize() decides who
 * may use it, this only makes the takeover atomic and visible.
 */
export const acquireComponentAuthority = (component: object, caller: string, ttlMs: number, take: boolean): RpcAuthorityOutcome => {
    const held = internalsOf(component)
    const current = held.authority
    const now = Date.now()
    const holding = current.holder !== undefined && (current.expiresAt ?? 0) > now
    if (holding && current.holder !== caller && !take) return { granted: false, holder: current.holder!, expiresAt: current.expiresAt! }
    const renewal = holding && current.holder === caller
    commitAuthority(
        component,
        { holder: caller, expiresAt: now + ttlMs, generation: renewal ? current.generation : current.generation + 1 },
        renewal ? 'renewed' : holding ? 'taken' : 'acquired'
    )
    return { granted: true, authority: internalsOf(component).authority }
}

/** Idempotent, like dropping a subscription: releasing what you do not hold is not an offence. */
export const releaseComponentAuthority = (component: object, caller: string): 'ok' | 'ok - was not holding' => {
    const held = internalsOf(component)
    if (held.authority.holder !== caller) return 'ok - was not holding'
    commitAuthority(component, { generation: held.authority.generation + 1 }, 'released')
    return 'ok'
}

export interface RpcComponentExposeOptions {
    /**
     * Coalesce published snapshots to at most one per interval. Local state still changes
     * immediately - this bounds what the network hears, not what the instance knows. Same-turn
     * updates are microtask-coalesced regardless, so a method that sets three fields publishes one
     * snapshot.
     */
    minPublishIntervalMs?: number
    /**
     * Refuse to publish a snapshot larger than this. Measured as a JSON estimate, which is
     * deliberately approximate - the bound exists to catch a waveform buffer wired into state by
     * mistake, not to meter bytes. Local state still commits; the publish is skipped and logged.
     */
    maxSnapshotBytes?: number
}

/** Beyond this, a snapshot is almost certainly carrying something that belongs in a stream. */
const DEFAULT_MAX_SNAPSHOT_BYTES = 1_048_576

/** Wire commit-time validation. Called by the exposure machinery when the server asks for it. */
export const installComponentValidator = (component: object, validate: (props: Readonly<RpcComponentData>, state: Readonly<RpcComponentData>) => string | undefined) => {
    internalsOf(component).validate = validate
}

/**
 * Wire a component's commits to a publisher, coalesced. Called by the exposure machinery; the
 * publisher reads the snapshot at fire time, so several commits inside one window publish the
 * newest state once - conflation being the honest behaviour for state, where only the latest value
 * was ever the point.
 */
export const installComponentPublisher = (component: object, options: RpcComponentExposeOptions, publish: () => void, logger?: ILogger) => {
    const held = internalsOf(component)
    const interval = options.minPublishIntervalMs ?? 0
    const maxBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
    let queued = false
    let lastPublished = 0
    let timer: NodeJS.Timeout | undefined

    const publishBounded = () => {
        lastPublished = Date.now()
        const snapshot = componentSnapshot(component)
        // A rough byte count is enough: the bound is a tripwire, not an accountant.
        const estimated = JSON.stringify(snapshot).length
        if (estimated > maxBytes) {
            logger?.log('Error', 'component snapshot not published: {estimated} bytes exceeds the {maxBytes} byte bound', { estimated, maxBytes })
            return
        }
        publish()
    }

    held.notify = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
            queued = false
            const wait = lastPublished + interval - Date.now()
            if (wait <= 0) return publishBounded()
            if (timer) return
            timer = setTimeout(() => {
                timer = undefined
                publishBounded()
            }, wait)
            // Unref'd so a pending coalesce window cannot hold a closing process open. A publish
            // after the last subscriber detached is an emit nobody hears, which costs nothing.
            timer.unref?.()
        })
    }
}
