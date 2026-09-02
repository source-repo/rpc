import { useEffect, useState } from 'react'

/**
 * Two things a pane does with a clock, and neither of them decides when to ask.
 *
 * What used to be here was `usePolled`, the loop that asked a collection for a page every so many
 * seconds. That is gone: the period now belongs to `@source-repo/query`, where it can skip a tick
 * entirely because the component's revision says the page has not changed - which is a decision
 * about the protocol rather than about React, and was never this file's to make.
 *
 * What is left is the part that genuinely is React: a number that has to tick to look alive, and a
 * value that has to stop moving before it is worth acting on.
 */

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
