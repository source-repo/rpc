import type { RpcComponentData, RpcComponentSnapshot, RpcProjectionEntry } from './Component.js'

/**
 * Keeping the last known snapshot across a reload, so a page comes back with values and their age
 * rather than with nothing.
 *
 * The doctrine this serves is already written down: last-known-with-an-age beats a blank, which is
 * why a dropped link marks a view stale and keeps it readable. A reload is the one place that rule
 * was not honoured - the page came back `initializing`, and on a link where the first snapshot is
 * eighty seconds away that is eighty seconds of blank screen in front of an operator.
 *
 * What it is not is a way to skip waiting. `component()` still resolves only on an accepted
 * snapshot, so nothing here can hand a caller a stale view where it asked for a live one; reading
 * the cache is a separate call that answers a plain view, marked stale, and no proxy at all.
 */

/** What is kept between one run of a page and the next. */
export interface RpcPersistedSnapshot {
    epoch: string
    revision: number
    props: RpcComponentData
    state: RpcComponentData
    slices?: RpcComponentSnapshot<RpcComponentData, RpcComponentData>['slices']
    /** Kept, because a projected snapshot and a whole one are otherwise the same bytes. */
    projection?: readonly RpcProjectionEntry[]
    /** Receipt time of these values, carried across so a restored view cannot claim to be new. */
    receivedAt: number
    /** When the record was written, which is what a restored view is stale *since*. */
    writtenAt: number
}

/**
 * Where records are kept. Injected, because this library runs in Node as well as a browser, and
 * because serialisation is the adapter's business: the browser one uses JSON, so a component
 * carrying `Date` or binary in its state gets back whatever JSON makes of those. A deployment
 * needing fidelity supplies an IndexedDB adapter over structured clone instead.
 */
export interface RpcSnapshotStore {
    read(key: string): Promise<RpcPersistedSnapshot | undefined>
    write(key: string, snapshot: RpcPersistedSnapshot): Promise<void>
    remove(key: string): Promise<void>
}

export interface RpcSnapshotPersistence {
    store: RpcSnapshotStore
    /**
     * What these records belong to, and it has no default on purpose.
     *
     * Plant values at rest are readable by whatever opens that origin next, so the scope is what
     * keeps one operator's screen from being drawn for another: it must encode whatever identity
     * the deployment has - the signed-in user, the tenant, the site - and it must change when that
     * changes. A defaulted scope is how a cache outlives a logout.
     *
     * It is deliberately not derived from this peer's own name. A console page's name is random and
     * lives in `sessionStorage`, so it survives a reload and not a browser restart - and a browser
     * restart is precisely what `localStorage` is chosen for, so keying on it would orphan every
     * record at the one moment the feature exists to cover.
     */
    scope: string
    /** Past which a record is dropped rather than drawn. A deployment's number, not a library's. */
    maxAgeMs: number
    /** At most one write per component per interval. Defaults to five seconds. */
    writeEveryMs?: number
}

/**
 * The projection is in the key rather than only in the record, so a page that comes back asking for
 * different paths cannot be handed something claiming a shape it does not have.
 */
export const snapshotKey = (scope: string, target: string | undefined, namespace: string, projection?: readonly RpcProjectionEntry[]) =>
    // NUL as the separator: it cannot occur in a scope, a peer name or a namespace, so no clever
    // choice of one can forge another key. Escaped, never the byte - a literal one here would make
    // this file binary to grep, which is how it silently stops being searchable.
    ['srpc', scope, target ?? '', namespace, projection === undefined ? '' : JSON.stringify(projection)].join('\u0000')

/**
 * Whether a record may still be drawn. Both guards matter and neither is optional.
 *
 * Too old is the deployment's judgement about when last-known stops being worth showing. In the
 * future is a clock that moved backwards, and a snapshot from the future is evidence of nothing -
 * drawing it would put a number on screen with an age nobody can reason about.
 */
export const restorable = (record: RpcPersistedSnapshot, maxAgeMs: number, now: number) => record.writtenAt <= now && now - record.writtenAt <= maxAgeMs
