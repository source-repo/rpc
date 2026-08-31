import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { canonicalText, visibilityActivity, type RpcGetListResult } from '@source-repo/rpc'
import type { RpcDataAnswer, RpcDataCache, RpcDataState, RpcDataWatch, RpcQuestion } from '@source-repo/query'

/**
 * A collection page, watched rather than polled.
 *
 * This is all that is left of `usePolled` in React terms, and the shrinkage is the point: the loop,
 * the visibility handling, the keeping of the last good answer across a failure and the not-asking
 * twice at once all moved into `@source-repo/query`, where they can be tested without a browser and
 * used by a Node peer. What stays here is binding one external store to one component.
 *
 * The behaviour that changed rather than moved is the period. It used to cost one page per period
 * whatever the plant was doing; now a tick over a page the component has not published since costs
 * nothing at all, and the pane says `current` instead of an age.
 */

/** One signal for the whole page, so every watched collection shares one `visibilitychange` listener. */
const activity = visibilityActivity()

/** Stable, because `useSyncExternalStore` compares the snapshot by identity. */
const NOTHING: RpcDataState<RpcDataAnswer> = { fetching: false, freshness: 'unknown' }

/**
 * Generic in what is being asked for, defaulting to a page.
 *
 * A page is what nearly every caller wants and it stays the default for that reason. `getOne`
 * answers a single row with no `ids` beside it, so a pane opening one row names `RpcGetOneResult`
 * and gets a snapshot typed as the thing it actually asked for - rather than every caller having to
 * narrow a union to reach the ids they were always going to read.
 */
export const useRpcData = <T extends RpcDataAnswer = RpcGetListResult>(
    cache: RpcDataCache,
    question: RpcQuestion,
    periodMs: number | undefined
): RpcDataState<T> => {
    const [watch, setWatch] = useState<RpcDataWatch<T> | null>(null)
    // What identifies the question, through the library's own encoder rather than a second one: two
    // renders that build the same options object in a different order must not open two watches.
    const identity = canonicalText([question.target, question.namespace, question.method, question.resource, question.params ?? {}])

    useEffect(() => {
        const opened = cache.watch<T>(question, { periodMs, activity })
        setWatch(opened)
        return () => opened.close()
        // `identity` rather than `question` itself, which is a fresh object on every render: watching
        // the object would reopen the watch - and re-ask the peer - once per keystroke in the filter
        // box. The encoder is the library's own, so this and the cache key agree by construction.
    }, [cache, identity, periodMs])

    return useSyncExternalStore(
        useCallback((listener: () => void) => watch?.subscribe(listener) ?? (() => undefined), [watch]),
        useCallback(() => watch?.getSnapshot() ?? (NOTHING as RpcDataState<T>), [watch])
    )
}
