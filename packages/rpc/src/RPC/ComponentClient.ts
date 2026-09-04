import { canonicalText } from './Canonical.js'
import { TransportEvent } from './Core.js'
import {
    componentSnapshotEvent,
    isProjectionSlice,
    type RpcComponent,
    type RpcComponentAuthority,
    type RpcComponentData,
    type RpcComponentSnapshot,
    type RpcProjectionEntry
} from './Component.js'
import type {
    RpcGetChildrenParams,
    RpcGetChildrenResult,
    RpcGetListParams,
    RpcGetListResult,
    RpcGetManyParams,
    RpcGetManyReferenceParams,
    RpcGetManyResult,
    RpcGetOneParams,
    RpcGetOneResult
} from './DataProvider.js'
import type { RpcCallOptions, RpcClientHandler, WithOptions } from './RpcClientHandler.js'
import { snapshotKey, type RpcSnapshotPersistence } from './Snapshots.js'

/**
 * The client side of an observable component: one shared channel per (target, namespace), a cached
 * view read synchronously, and a status that says whether the picture is current.
 *
 * Reads never contend and never cost a network hop; what they cost instead is honesty about age,
 * which is what the status carries. The last snapshot stays readable while stale, because "last
 * known, twenty seconds ago" is an answer and `undefined` is not.
 */

export const rpcComponent = Symbol('@source-repo/rpc/component')

export type RpcComponentStatus = 'initializing' | 'live' | 'stale' | 'closed'

export interface RpcComponentView<P extends RpcComponentData, S extends RpcComponentData> extends RpcComponentSnapshot<P, S> {
    readonly status: RpcComponentStatus
    /** Local receipt time of the values below. Useful for display; never for distributed ordering - clocks disagree. */
    readonly receivedAt: number
    /**
     * When the feed last proved it is current, which is a different fact from when these values
     * arrived and is usually a later one.
     *
     * A frame carrying no news - the targeted snapshot answering a re-subscribe, a redelivery, one
     * that arrived late - cannot move `receivedAt` without claiming the values are newer than they
     * are, and cannot be dropped without leaving the view saying the feed is stale a moment after
     * it spoke. So it moves this instead. "20 °C, measured 14:03, still true at 14:19" is two
     * facts, and collapsing them into one is the thing this channel exists not to do.
     */
    readonly confirmedAt: number
    readonly staleSince?: number
}

/**
 * A view of one thing in a component, and nothing else.
 *
 * The same two methods `useSyncExternalStore` consumes, and deliberately no `close`: a derived
 * store owns no channel, so closing stays with whoever opened one.
 */
export interface RpcDerivedStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
}

/**
 * One value from a snapshot, with enough of the channel beside it to know whether to believe it.
 *
 * `status` travels with the value on purpose. A pane that selected `state.pressure` alone would
 * keep drawing the last number after the feed went stale and never re-render to say so, which is
 * the whole argument of this channel defeated by an optimisation.
 *
 * The timestamps are deliberately **not** here. `receivedAt` and `confirmedAt` move on every frame,
 * so carrying them would notify every selected leaf on every publish - exactly the re-render this
 * exists to avoid. They belong to the one line at the top of a panel that draws them, read from the
 * whole view. The age of a *reading* is a different fact again and belongs in the reading, which is
 * what `RpcSourcedValue.at` is for.
 */
export interface RpcValueAt<T> {
    /** Absent where the path reaches nothing, which a projection makes an ordinary state to be in. */
    readonly value: T | undefined
    readonly status: RpcComponentStatus
    readonly staleSince?: number
}

export interface RpcComponentStore<P extends RpcComponentData, S extends RpcComponentData> {
    getSnapshot(): RpcComponentView<P, S>
    subscribe(listener: () => void): () => void
    close(): Promise<void>
    /**
     * Narrow what a consumer re-renders for. A projection narrows the wire; this narrows the render,
     * and a component wants both for the same reason.
     *
     * The selector is given the **view** rather than the state, so `status`, `staleSince` and the
     * revision are selectable and a pane bound to one value does not lose the one thing this
     * library has that a query cache does not.
     *
     * The derived store caches. A selector that returned a fresh object from every `getSnapshot`
     * would be React's "the result of getSnapshot should be cached" infinite loop, and that single
     * hazard is most of the reason this is here rather than in every application. Which also makes
     * `isEqual` the sharp edge: one that reports a changed value unchanged freezes a pane, and a
     * frozen pane on a plant is indistinguishable from a plant that stopped.
     */
    select<T>(selector: (view: RpcComponentView<P, S>) => T, isEqual?: (a: T, b: T) => boolean): RpcDerivedStore<T>
    /**
     * The path form, spelled from the root a reader uses - `['state', 'zones', 'top', 'setpoint']`,
     * which is what `rpcPath` produces and what a projection entry already spells.
     *
     * Correct for an object-valued path only because the snapshot is reference-shared underneath:
     * without that, every publish would hand back a new object and the comparison would never bail.
     */
    at<T = unknown>(path: readonly string[]): RpcDerivedStore<RpcValueAt<T>>
}

export type ComponentProps<T> = T extends RpcComponent<infer P, infer _S> ? P : never
export type ComponentState<T> = T extends RpcComponent<infer _P, infer S> ? S : never

/**
 * The constraint is the readable surface, not the base class: `setState`'s parameter makes
 * `RpcComponent<P, S>` contravariant in its generics, so a concrete component never satisfies
 * `RpcComponent<RpcComponentData, RpcComponentData>`. What a client needs proven is only that
 * props and state exist to cache; the server decides at runtime whether it is truly a component.
 */
export type RpcComponentLike = { readonly props: RpcComponentData; readonly state: RpcComponentData }

/**
 * Whether this peer is doing anything worth spending a link on.
 *
 * Injected rather than read from the DOM, and not only for tidiness: this file is exported from the
 * web build and the Node one both, so it must not touch `document` at all - and injecting it is
 * also the only way the behaviour is testable under a Node test runner. It generalises for free to
 * the things people actually ask for: a screensaver, a kiosk showing another page of the same app,
 * an operator who locked the screen.
 *
 * `visibilityActivity()` is the browser implementation, exported from the web entry point only.
 */
export interface RpcActivitySignal {
    readonly active: boolean
    subscribe(onChange: (active: boolean) => void): () => void
}

/** How this client's component channels behave beyond simply being open. */
export interface RpcComponentChannelOptions {
    /**
     * Stop listening while this peer is inactive, and start again when it is not.
     *
     * **Off unless supplied**, and the argument for that is stronger than the wall panel it is
     * usually made with: a page hosting the Sparkplug projection runner turns a non-live status
     * into a device DEATH, so an edge node would go offline because somebody switched tabs.
     */
    activity?: RpcActivitySignal
    /**
     * How long inactivity has to last before the subscriptions go. Seconds rather than
     * milliseconds, deliberately: every resume costs a full targeted snapshot, so an operator
     * alt-tabbing to check something would otherwise pay one per switch on exactly the link this
     * exists to protect. Resuming is immediate - there is nothing to gain by making somebody wait.
     */
    activityGraceMs?: number
    /**
     * Keep a channel subscribed for this long after its last observer leaves, so a pane closed and
     * reopened inside the window costs nothing on the wire and is still `live` when it comes back.
     *
     * Defaults to 0, which is the behaviour that always was: the last `close()` unsubscribes. It
     * deliberately does not go on to hold a *cold* cache after the window - `component()` resolves
     * only on an accepted snapshot, and a cache nobody may read without weakening that promise is
     * dead weight. What this buys is the round trip, not a stale read.
     *
     * The cost, stated because it is invisible otherwise: inside the window the channel is still
     * live, so a store handle whose owner has already called `close()` goes on being notified until
     * the window ends.
     */
    keepAliveMs?: number
    /**
     * Keep the last accepted snapshot somewhere it survives a reload, so a page comes back with
     * values and their age instead of a blank. Off unless supplied; see `RpcSnapshotPersistence`,
     * and read what it says about `scope` before turning it on.
     *
     * Reading it back is `client.lastKnown()`, deliberately a separate call: `component()` still
     * resolves only on an accepted snapshot, so nothing here can hand a caller a stale view where
     * it asked for a live one.
     */
    persistence?: RpcSnapshotPersistence
}

/** What a caller may ask for beyond the component itself. */
export interface RpcComponentOptions {
    /**
     * Receive only these paths, each spelled from `props` or `state` - `['state', 'zones', 'top',
     * 'setpoint']`, which `rpcPath` produces. Omitted means the whole snapshot, as it always was.
     *
     * What arrives is still a whole snapshot, of the projection: duplicate delivery stays harmless,
     * a reconnect is still repaired by one frame, and the epoch and revision rules are untouched.
     * Only how much of the state is in it changes, which is why this needs no base tracking and no
     * keyframe schedule - and why it is worth reaching for before any delta encoding.
     *
     * One peer holds one subscription per component, so opening a second view of the same component
     * with different paths is refused rather than silently served the first one's.
     */
    paths?: readonly RpcProjectionEntry[]
}


export type RpcComponentProxy<T extends RpcComponentLike> = T & {
    $with(options: RpcCallOptions): RpcComponentProxy<T>
    /**
     * Ask for control of the component. Granted when free, renewed when already held by this peer,
     * refused `NotInControl` naming the holder when held by another - unless `take`, the break-in
     * every plant panel has, which authorize() on the server decides who may use. The lease always
     * expires; who holds it is in every snapshot's `authority`.
     */
    $acquire(ttlMs?: number, options?: { take?: boolean }): Promise<RpcComponentAuthority>
    /** Idempotent: releasing what this peer does not hold answers politely rather than erring. */
    $release(): Promise<'ok' | 'ok - was not holding'>
    /**
     * Ask for a page of a collection this component holds, instead of subscribing to all of it.
     *
     * The DataProvider half of the component surface, and the reason it is a call: a record's keys
     * are data, so a caller cannot name page two without first receiving everything - and a
     * predicate on the subscription would run on every publish rather than when somebody asks. This
     * runs once, answers once, and leaves nothing behind on the server. See `DataProvider.ts`.
     */
    $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult>
    /** One row by id, optionally richer than the row returned in a list. */
    $data(method: 'getOne', resource: readonly string[], params: RpcGetOneParams): Promise<RpcGetOneResult>
    /** Rows by id, for a caller that already knows them - a page of foreign keys, in one call. */
    $data(method: 'getMany', resource: readonly string[], params: RpcGetManyParams): Promise<RpcGetManyResult>
    /** The rows of this resource pointing at one row of another: the orders of this customer. */
    $data(method: 'getManyReference', resource: readonly string[], params: RpcGetManyReferenceParams): Promise<RpcGetListResult>
    /** One level of a tree resource: roots when parentId is absent, otherwise that branch's children. */
    $data(method: 'getChildren', resource: readonly string[], params?: RpcGetChildrenParams): Promise<RpcGetChildrenResult>
    readonly [rpcComponent]: RpcComponentStore<ComponentProps<T>, ComponentState<T>>
}

/** The proxy surface a channel drives: the snapshot event, through the ordinary event machinery. */
type Subscribable = {
    on(event: string, handler: (snapshot: unknown) => void, projection?: readonly RpcProjectionEntry[]): Promise<unknown>
    off(event: string, handler: (snapshot: unknown) => void): Promise<unknown>
}

/** Own-property objects only. A class instance is compared by reference, like a Map or a buffer. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object') return false
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

/**
 * A decoded frame is a tree, and a deep one is a caller holding it wrong rather than a plant. The
 * bound is here because this runs in the receive loop on every publish, on a channel shared by
 * every observer of that component - including the ones that never asked for sharing.
 */
const maxSharingDepth = 32

/**
 * TanStack Query's replaceEqualDeep, and the name is worth keeping because **this is not a merge**.
 *
 * The result is always deep-equal to `next`. Only identities change: any node that compares equal
 * to the one in `previous` is returned as the previous reference, so a consumer memoizing on a
 * subtree sees it move only when something under it moved.
 *
 * That distinction is load-bearing in this file. A merge in the ordinary sense fills gaps in `next`
 * from `previous`, and this repository has already written down that doing so is inventing - see
 * the `projection` field's own comment in Component.ts. It is not hypothetical either: a channel's
 * own feed can be re-projected underneath it by one `on($snapshot, handler, paths)` through the
 * ordinary event surface, and a union-style merge would then keep drawing a value the publisher had
 * deliberately stopped sending, live, with a rising revision and nothing to show for it. Because
 * this reproduces `next` and never borrows from `previous`, a narrowed frame narrows the view and
 * no guard is needed to make that true.
 *
 * Walked: plain objects and arrays. Compared by reference: typed arrays, Map, Set and anything
 * carrying a prototype of its own. msgpack is the default codec and round-trips a `Uint8Array` as
 * itself, so walking a waveform buffer element by element on every publish would cost more than the
 * sharing saves - and the consequence, worth stating rather than discovering, is that a component
 * carrying binary in its state gets no sharing anywhere on the path from that value to the root.
 * `Date` is compared by its time, because two Dates for one instant are the same reading.
 */
export const replaceEqualDeep = <T>(previous: unknown, next: T, depth = 0): T => {
    if (Object.is(previous, next)) return next
    if (depth >= maxSharingDepth) return next
    if (previous instanceof Date && next instanceof Date) return (previous.getTime() === next.getTime() ? (previous as unknown as T) : next)

    const arrays = Array.isArray(previous) && Array.isArray(next)
    const objects = !arrays && isPlainObject(previous) && isPlainObject(next)
    if (!arrays && !objects) return next

    const from = previous as Record<string, unknown>
    const to = next as unknown as Record<string, unknown>
    const keys = arrays ? undefined : Object.keys(to)
    const size = arrays ? (next as unknown[]).length : keys!.length
    const copy = (arrays ? [] : {}) as Record<string, unknown>
    let shared = 0
    // Every key `next` has must also be one `previous` had, or returning `previous` would hand back
    // a shape the frame does not describe - two objects can carry the same number of keys and not
    // the same keys, and `{ a: 1 }` against `{ b: undefined }` is the case that catches it.
    let sameKeys = true
    for (let index = 0; index < size; index++) {
        const key = arrays ? String(index) : keys![index]
        if (!arrays && !(key in from)) sameKeys = false
        const child = replaceEqualDeep(from[key], to[key], depth + 1)
        copy[key] = child
        if (Object.is(child, from[key])) shared++
    }
    const unchanged = sameKeys && shared === size && (arrays ? (previous as unknown[]).length === size : Object.keys(from).length === size)
    return (unchanged ? previous : copy) as T
}

/** Follow a path from the root a reader spells - `props` or `state` first, as a projection does. */
const readAt = (from: unknown, path: readonly string[]): unknown => {
    let at = from
    for (const segment of path) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as Record<string, unknown>)[segment]
    }
    return at
}

const sameValueAt = <T>(a: RpcValueAt<T>, b: RpcValueAt<T>) => Object.is(a.value, b.value) && a.status === b.status && a.staleSince === b.staleSince

/**
 * One selector over one store, cached and attached lazily.
 *
 * Lazily because React calls `getSnapshot` before it calls `subscribe`, and because a derived store
 * nobody is listening to should not hold a listener on the channel. Cached because a selector
 * returning a fresh object from every `getSnapshot` is the "result of getSnapshot should be cached"
 * loop; keeping the previous value whenever `isEqual` says nothing moved is what makes the identity
 * stable enough for React to bail out on.
 */
const derive = <P extends RpcComponentData, S extends RpcComponentData, T>(
    parent: Pick<RpcComponentStore<P, S>, 'getSnapshot' | 'subscribe'>,
    selector: (view: RpcComponentView<P, S>) => T,
    isEqual: (a: T, b: T) => boolean
): RpcDerivedStore<T> => {
    let current = selector(parent.getSnapshot())
    let detach: (() => void) | undefined
    const listeners = new Set<() => void>()

    const recompute = () => {
        const next = selector(parent.getSnapshot())
        if (isEqual(current, next)) return false
        current = next
        return true
    }

    return {
        getSnapshot: () => {
            // Nothing is keeping this current while detached, and the first read happens then.
            if (!detach) recompute()
            return current
        },
        subscribe: (listener) => {
            listeners.add(listener)
            if (!detach) {
                // Re-read on attach: the parent may have moved between construction and this, and a
                // value already stale before the first render is the worst kind to hand back.
                recompute()
                detach = parent.subscribe(() => {
                    if (!recompute()) return
                    for (const one of [...listeners])
                        try {
                            one()
                        } catch {
                            // A consumer's render bug is not this store's failure to report.
                        }
                })
            }
            return () => {
                listeners.delete(listener)
                if (listeners.size > 0) return
                detach?.()
                detach = undefined
            }
        }
    }
}

class ComponentChannel {
    /** Replaced whole on every change, so a store consumer can compare by reference. */
    view: RpcComponentView<RpcComponentData, RpcComponentData> = {
        epoch: '',
        revision: -1,
        props: Object.freeze({}),
        state: Object.freeze({}),
        status: 'initializing',
        receivedAt: 0,
        confirmedAt: 0
    }
    users = 0
    readonly inner: object
    readonly store: RpcComponentStore<RpcComponentData, RpcComponentData>
    /** Settles when the first snapshot lands, which is what component() awaits. */
    readonly first: Promise<void>
    private readonly listeners = new Set<() => void>()
    private readonly retired = new Set<string>()
    private settleFirst!: () => void
    private readonly handler = (snapshot: unknown) => this.accept(snapshot as RpcComponentSnapshot<RpcComponentData, RpcComponentData>)

    constructor(
        client: RpcClientHandler,
        readonly namespace: string,
        readonly target: string | undefined,
        private readonly release: () => void,
        /** What this channel asked for, when it asked for less than everything. */
        readonly projection?: readonly RpcProjectionEntry[],
        private readonly keepAliveMs = 0,
        private readonly persistence?: RpcSnapshotPersistence
    ) {
        this.inner = client.proxy<object>(namespace, target)
        this.first = new Promise((resolve) => (this.settleFirst = resolve))
        this.store = {
            getSnapshot: () => this.view,
            subscribe: (listener) => {
                this.listeners.add(listener)
                return () => this.listeners.delete(listener)
            },
            close: () => this.close(),
            select: (selector, isEqual) => derive(this.store, selector, isEqual ?? Object.is),
            at: (path) => derive(this.store, (view) => ({ value: readAt(view, path), status: view.status, staleSince: view.staleSince }), sameValueAt)
        } as RpcComponentStore<RpcComponentData, RpcComponentData>
    }

    /**
     * Install the local handler, then ask the server - which answers with a targeted snapshot.
     *
     * The projection rides on the subscribe, because that is the only moment a subscriber gets to
     * say what it wants; everything after is the server pushing. What comes back is still a whole
     * snapshot, of the projection, so nothing about the acceptance rules below changes.
     */
    async open() {
        await (this.inner as Subscribable).on(componentSnapshotEvent, this.handler, this.projection)
        await this.first
    }

    /**
     * The acceptance rules, and nothing but them: first wins, then higher revision within an epoch,
     * then a new epoch replaces and retires the old. Wall clocks decide nothing - a browser, an
     * edge box and a plant server do not agree on the time, and do not need to.
     *
     * A frame carrying no news is not nothing, though, which is what `confirm` below is for.
     */
    private accept(snapshot: RpcComponentSnapshot<RpcComponentData, RpcComponentData>) {
        if (this.view.status === 'closed') return
        if (this.retired.has(snapshot.epoch)) return
        if (this.view.epoch === snapshot.epoch && snapshot.revision <= this.view.revision) {
            this.confirm()
            return
        }
        if (this.view.epoch && this.view.epoch !== snapshot.epoch) this.retired.add(this.view.epoch)
        const at = Date.now()
        // Identities preserved wherever the values did not move, so a consumer memoizing on a
        // subtree re-renders only when something under it did. Same epoch only, and not for the
        // very first frame: there is nothing to compare against there, and an epoch is the
        // statement that this is a *different object* under the same name - telling a memoizing
        // reader "nothing changed under zones" across that boundary would collapse "the same
        // reading" and "a different thing that happens to read the same".
        const share = this.view.status !== 'initializing' && this.view.epoch === snapshot.epoch
        this.view = share
            ? {
                  ...snapshot,
                  props: replaceEqualDeep(this.view.props, snapshot.props),
                  state: replaceEqualDeep(this.view.state, snapshot.state),
                  ...(snapshot.authority === undefined ? {} : { authority: replaceEqualDeep(this.view.authority, snapshot.authority) }),
                  ...(snapshot.slices === undefined ? {} : { slices: replaceEqualDeep(this.view.slices, snapshot.slices) }),
                  status: 'live',
                  receivedAt: at,
                  confirmedAt: at
              }
            : { ...snapshot, status: 'live', receivedAt: at, confirmedAt: at }
        this.settleFirst()
        this.notify()
        this.persist()
    }

    private lastWrite = 0

    /**
     * Write the view where a reload can find it, at most once per interval.
     *
     * `authority` is deliberately never written. A lease carries an expiry stamped on a server's
     * clock, and restoring "you hold control" across a reload is the optimistic-write failure this
     * repository refuses, wearing a different hat: last-known values with an age on them are
     * honest, and last-known *arbitration* is not - the plant may have been handed to somebody else
     * while this page was not running.
     */
    private persist(force = false) {
        const persistence = this.persistence
        if (!persistence || this.view.status === 'initializing') return
        const now = Date.now()
        if (!force && now - this.lastWrite < (persistence.writeEveryMs ?? 5000)) return
        this.lastWrite = now
        // Fire and forget, and swallow: a page that cannot cache draws a blank on its next reload,
        // which is not a reason to fail the frame that has just arrived.
        void persistence.store
            .write(snapshotKey(persistence.scope, this.target, this.namespace, this.projection), {
                epoch: this.view.epoch,
                revision: this.view.revision,
                props: this.view.props,
                state: this.view.state,
                ...(this.view.slices === undefined ? {} : { slices: this.view.slices }),
                ...(this.view.projection === undefined ? {} : { projection: this.view.projection }),
                receivedAt: this.view.receivedAt,
                writtenAt: now
            })
            .catch(() => undefined)
    }

    /**
     * A frame that told us nothing new still told us something: this feed is current as of now.
     *
     * Dropping it - which is what happened before - left the view marked `stale` behind a
     * subscription that had just answered. A component that survives a link blip without
     * committing is exactly that case: the re-subscribe is answered with a targeted snapshot at
     * the revision the observer already holds, so the repair arrives and the status goes on saying
     * the opposite of it, with nothing to distinguish it from a peer that really has gone quiet.
     * In a channel whose whole argument is that the status tells the truth, that was the status
     * telling the reverse of it.
     *
     * The values and their identities are kept exactly as they were, so nothing a consumer
     * memoizes on moves - only the two facts that actually changed. It notifies unconditionally
     * rather than only on a stale-to-live transition, because `confirmedAt` is a fact a reader may
     * be drawing, and a number that silently stops advancing is the failure this exists to fix
     * wearing a smaller hat. The frames that reach here are re-subscribes, redeliveries and
     * reordered arrivals - none of them frequent - so this is not a render per publish.
     *
     * Unreachable while `initializing`: the epoch there is the empty string and a real one is a
     * uuid, so the guard that leads here cannot match.
     */
    private confirm() {
        this.view = { ...this.view, status: 'live', confirmedAt: Date.now(), staleSince: undefined }
        this.notify()
    }

    /** The picture is no longer known to be current. The picture itself stays readable. */
    markStale() {
        if (this.view.status !== 'live') return
        this.view = { ...this.view, status: 'stale', staleSince: Date.now() }
        this.notify()
    }

    /** Paused by the activity signal: the subscription is gone, the values are not. */
    private paused = false
    private resuming?: NodeJS.Timeout
    /** Ticking down to teardown after the last observer left, when a keep-alive window is set. */
    private idle?: NodeJS.Timeout

    private clearTimers() {
        if (this.resuming !== undefined) clearTimeout(this.resuming)
        if (this.idle !== undefined) clearTimeout(this.idle)
        this.resuming = undefined
        this.idle = undefined
    }

    /** A new observer inside the keep-alive window: still subscribed, still live, nothing sent. */
    reclaim() {
        if (this.idle === undefined) return
        clearTimeout(this.idle)
        this.idle = undefined
    }

    /**
     * Drop the remote subscription and keep everything else - the values, the listeners, the epoch.
     *
     * Not a variant of `close`: nobody has given up their claim, so the channel stays in the map
     * and a `resume` puts it back with one targeted snapshot. `off` is what actually drops it,
     * including the replay entry - leaving that would have the next reconnect restore a
     * subscription this deliberately stopped.
     */
    async suspend() {
        if (this.paused || this.view.status === 'closed') return
        this.paused = true
        this.clearTimers()
        // The last moment worth recording: a tab going hidden is often a tab about to be closed.
        this.persist(true)
        await (this.inner as Subscribable).off(componentSnapshotEvent, this.handler).catch(() => undefined)
        // Never `live` while paused. Nothing is arriving, so the freshness is unknown - and a
        // paused channel reporting `live` would be this library's own fake in miniature.
        this.markStale()
    }

    async resume(attempt = 0) {
        if (!this.paused || this.view.status === 'closed') return
        try {
            await (this.inner as Subscribable).on(componentSnapshotEvent, this.handler, this.projection)
            this.paused = false
            this.clearTimers()
        } catch {
            // A resume that failed and was not retried leaves a pane somebody is looking at stale
            // for ever, which is the peer-return defect arriving through a new door. Bounded for
            // the same reason that one is: a subscription that will never come back should not be
            // asked for indefinitely.
            if (attempt >= 6) return
            const timer = setTimeout(() => void this.resume(attempt + 1), Math.min(500 * 2 ** attempt, 15000))
            timer.unref?.()
            this.resuming = timer
        }
    }

    private async close() {
        if (this.users > 0) this.users--
        if (this.users > 0) return
        if (this.keepAliveMs > 0 && this.view.status !== 'closed') {
            // Held rather than dropped, so a pane closed and reopened inside the window costs
            // nothing at all: the subscription never went, so there is nothing to restore and
            // `component()` resolves on a view that never stopped being live.
            const timer = setTimeout(() => void this.teardown(), this.keepAliveMs)
            timer.unref?.()
            this.idle = timer
            return
        }
        await this.teardown()
    }

    private async teardown() {
        this.clearTimers()
        this.view = { ...this.view, status: 'closed' }
        this.notify()
        this.release()
        // The refcounted off: other local handlers would keep the remote subscription, but a
        // channel holds exactly one, so this is what ends it on the server.
        await (this.inner as Subscribable).off(componentSnapshotEvent, this.handler).catch(() => undefined)
    }

    markClosed() {
        if (this.view.status === 'closed') return
        this.view = { ...this.view, status: 'closed' }
        this.notify()
    }

    private notify() {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch {
                // A store consumer's render bug is not this channel's failure to report.
            }
        }
    }
}

/** Whether two projections ask for the same thing. Mirrors the server's comparison exactly. */
const sameProjection = (a: readonly RpcProjectionEntry[] | undefined, b: readonly RpcProjectionEntry[] | undefined) => {
    if (!a || !b) return a === b
    if (a.length !== b.length) return false
    return a.every((entry, index) => canonicalText(entry) === canonicalText(b[index]))
}

const describeProjection = (projection: readonly RpcProjectionEntry[] | undefined) =>
    projection
        ? projection.map((entry) => (isProjectionSlice(entry) ? `${entry.path.join('.')}[${entry.offset ?? 0}..${entry.limit === undefined ? '' : (entry.offset ?? 0) + entry.limit}]` : entry.join('.'))).join(', ')
        : 'the whole snapshot'

/**
 * One channel per (target, namespace), shared by every component() call for it and reference
 * counted, so two panes watching one pump cost one subscription - and one leaving does not take
 * the feed from the other, which is the client-side half of the rule the subscription refcounting
 * enforces underneath.
 */
export class ComponentChannels {
    private readonly channels = new Map<string, ComponentChannel>()

    constructor(
        private readonly handler: RpcClientHandler,
        lifecycle: { on(event: string, listener: (...args: unknown[]) => void): unknown },
        private readonly options: RpcComponentChannelOptions = {}
    ) {
        this.watchActivity()
        // Link down: every picture is now of unknown age. Peer gone: only that peer's are - which
        // is the distinction the forwarded peer lifecycle exists to make visible.
        lifecycle.on(TransportEvent.disconnected, () => {
            for (const channel of this.channels.values()) channel.markStale()
        })
        for (const event of [TransportEvent.peerGone, TransportEvent.peerDisplaced])
            lifecycle.on(event, (peer: unknown) => {
                for (const channel of this.channels.values()) if (channel.target === peer) channel.markStale()
            })
    }

    /**
     * Suspend every channel while this peer is inactive, and resume them when it is not.
     *
     * Channels opened *during* an inactive spell are left subscribed on purpose: `component()`
     * resolves only on an accepted snapshot, so suspending one the moment it opened would be
     * racing the very call that asked for it. The next transition picks them up.
     */
    private watchActivity() {
        const activity = this.options.activity
        if (!activity) return
        const grace = this.options.activityGraceMs ?? 5000
        let pending: NodeJS.Timeout | undefined
        activity.subscribe((active) => {
            if (pending !== undefined) clearTimeout(pending)
            pending = undefined
            if (active) {
                for (const channel of this.channels.values()) void channel.resume()
                return
            }
            const timer = setTimeout(() => {
                for (const channel of this.channels.values()) void channel.suspend()
            }, grace)
            timer.unref?.()
            pending = timer
        })
    }

    async open(namespace: string, target: string | undefined, projection?: readonly RpcProjectionEntry[]): Promise<ComponentChannel> {
        // NUL as the separator: it cannot occur in a peer or namespace id. Escaped, never the byte.
        const key = `${target ?? ''}\u0000${namespace}`
        let channel = this.channels.get(key)
        // One subscription per peer per component, which the server enforces by keying on the pair -
        // so two observers here asking for different projections would be one subscription whose
        // paths depended on who opened first, and the second would silently receive the first's.
        // Refused instead, naming both, because a projection nobody asked for is worse on a slow
        // link than no projection at all: it looks like the feature working.
        if (channel && !sameProjection(channel.projection, projection))
            throw new Error(
                `component: ${namespace}${target ? ` on ${target}` : ''} is already observed here with a different projection ` +
                    `(${describeProjection(channel.projection)} against ${describeProjection(projection)}) - one peer holds one subscription per component`
            )
        if (channel) channel.reclaim()
        if (!channel) {
            channel = new ComponentChannel(this.handler, namespace, target, () => void this.channels.delete(key), projection, this.options.keepAliveMs ?? 0, this.options.persistence)
            this.channels.set(key, channel)
            try {
                await channel.open()
            } catch (e) {
                this.channels.delete(key)
                throw e
            }
        } else await channel.first
        channel.users++
        return channel
    }

    /** Local teardown only: the link is going away, and the server reaps a departed client. */
    closeAll() {
        for (const channel of this.channels.values()) channel.markClosed()
        this.channels.clear()
    }
}

/**
 * Wrap a channel's inner proxy: methods and events pass through untouched, `props`, `state` and the
 * store read from the channel, and `$with` returns another facade over the optioned proxy so the
 * component surface survives attaching an idempotency key or a per-call timeout.
 */
export const componentFacade = (channel: ComponentChannel, inner: object): object =>
    new Proxy(inner, {
        get: (target, prop) => {
            if (prop === 'props') return channel.view.props
            if (prop === 'state') return channel.view.state
            if (prop === rpcComponent) return channel.store
            if (prop === '$with') return (options: RpcCallOptions) => componentFacade(channel, (inner as WithOptions<object>).$with(options))
            return (target as Record<string | symbol, unknown>)[prop]
        },
        set: (target, prop, value) => {
            // The whole point, enforced at runtime as well as in the types: a component is read
            // through the cache and changed through methods, never assigned to.
            if (prop === 'props' || prop === 'state') throw new TypeError(`${String(prop)} is read-only on a component proxy - call a method to change the world`)
            ;(target as Record<string | symbol, unknown>)[prop] = value
            return true
        }
    })
