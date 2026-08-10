import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Asking again on a period, which is how a pulled grid stays current.
 *
 * The rows of a collection are fetched rather than subscribed to - see `DataProvider.ts` for why -
 * so something has to decide when to ask again. Making that the caller's period rather than the
 * component's publish rate is the point: a subscription's rate belongs to whoever is publishing,
 * and on a slow link that means the peer decides how much of the operator's 1200 bits/s it spends.
 * A polled page costs one page per period whatever the plant is doing, and the person watching sets
 * the period.
 *
 * Four things make that behave, and each of them is a way it misbehaves otherwise.
 *
 * **The next fetch is scheduled when the previous one settles**, never on a fixed interval. A five
 * second timer against a thirty second round trip has six requests in flight and falls further
 * behind the longer it runs - the failure gets worse exactly where the design was aimed.
 *
 * **Nothing is asked while the pane is hidden.** A console left open over a weekend should not spend
 * a link on a tab nobody is looking at, and coming back to it asks immediately rather than waiting
 * out a period.
 *
 * **The previous answer stays readable while a fetch is in flight**, which is the same judgement the
 * component channel already makes for `stale`: last known with its age on it is an answer, and a
 * blank is not.
 *
 * **A caller can ask out of band.** What that is for is the moment after a call settles: waiting a
 * period to find out whether the plant accepted `setSetpoint(180)` is the one place a period is
 * plainly wrong.
 */
export interface Polled<T> {
    /** The last answer, kept across refetches so the grid never blanks. */
    data?: T
    error?: string
    /** A fetch is in flight, which the pane says rather than showing nothing. */
    fetching: boolean
    /** When the fetch in flight began, so a pane can say how long it has been waiting. */
    since?: number
    /** Ask now, out of band, and restart the period from the answer. */
    refresh: () => void
}

/**
 * Seconds spent waiting, ticking once a second and only while something is being waited for.
 *
 * A pane that says `asking…` and nothing else is indistinguishable from a pane that has died,
 * which during development is most of the time somebody spends wondering what is wrong. A number
 * that is visibly climbing says the opposite of a number that is not there.
 */
export const useWaitedSeconds = (since: number | undefined) => {
    const [, tick] = useState(0)
    useEffect(() => {
        if (since === undefined) return
        const timer = setInterval(() => tick((count) => count + 1), 1000)
        return () => clearInterval(timer)
    }, [since])
    return since === undefined ? undefined : Math.floor((Date.now() - since) / 1000)
}

/**
 * A value that has stopped changing, so a search box does not become a request per keystroke.
 *
 * Typing `setpoint` is eight questions, of which seven are already stale by the time they are asked,
 * and on the link this was built for the first would still be arriving as the last was typed. The
 * wait is deliberately longer than it feels necessary on a LAN, because the cost of being wrong is
 * paid by the slow link and the benefit is invisible on the fast one.
 */
export const useDebounced = <T,>(value: T, ms: number): T => {
    const [settled, setSettled] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), ms)
        return () => clearTimeout(timer)
    }, [value, ms])
    return settled
}

/**
 * @param request what to ask. Re-read on every cycle, so a stale closure is never called.
 * @param periodMs how long to wait after an answer before asking again. `undefined` means ask once
 *   and then only when told - the honest setting on a link whose round trip is minutes, where a
 *   period short enough to be useful is arithmetically impossible.
 * @param key what identifies the question. Changing it starts over; nothing else does, so a render
 *   that rebuilds the request function does not restart the period.
 */
export const usePolled = <T,>(request: () => Promise<T>, periodMs: number | undefined, key: string): Polled<T> => {
    const [data, setData] = useState<T | undefined>()
    const [error, setError] = useState<string | undefined>()
    const [fetching, setFetching] = useState(false)
    const [since, setSince] = useState<number | undefined>()
    // The request as of this render, read at call time rather than captured, so the period never
    // holds a closure over a page number the operator has already moved off.
    const latest = useRef(request)
    latest.current = request
    // Held so an out-of-band refresh, and a pane becoming visible, can cancel a pending wait
    // instead of racing it - two cycles running at once would double the traffic silently.
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const cycle = useRef<() => void>(() => undefined)

    useEffect(() => {
        let stopped = false
        const clear = () => {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = undefined
        }
        const run = async () => {
            clear()
            if (stopped) return
            setFetching(true)
            setSince(Date.now())
            try {
                const answer = await latest.current()
                if (stopped) return
                setData(answer)
                setError(undefined)
            } catch (e) {
                if (stopped) return
                // The last good page stays on screen: a link that dropped is not a collection that
                // emptied, and drawing it as one would be a lie the operator cannot see through.
                setError((e as { message?: string }).message ?? String(e))
            } finally {
                if (!stopped) {
                    setFetching(false)
                    setSince(undefined)
                    if (periodMs !== undefined && document.visibilityState === 'visible') timer.current = setTimeout(() => void run(), periodMs)
                }
            }
        }
        cycle.current = () => void run()
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void run()
            else clear()
        }
        document.addEventListener('visibilitychange', onVisibility)
        void run()
        return () => {
            stopped = true
            clear()
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [key, periodMs])

    return { data, error, fetching, since, refresh: useCallback(() => cycle.current(), []) }
}
