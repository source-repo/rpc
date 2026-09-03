import { useEffect, useState } from 'react'
import type { RpcFilter } from '@source-repo/rpc'
import { searchAcross, type SearchAnswer, type SearchResult, type SearchTarget } from '@source-repo/search'
import { useDebounced } from './timing.js'
import { hitAddress } from './searching.js'

/**
 * One box, every resource of every peer that can answer.
 *
 * The drawing half of `@source-repo/search`. Which resources can be asked is read from each peer's
 * description; bounding the fan-out, merging what comes back and reporting what refused all happen
 * in that package, because they are the same problem whoever is asking and a browser is one asker
 * of three.
 *
 * ## Why this asks imperatively rather than watching
 *
 * Every other collection on this screen is a *watched* question: it has a period, it re-asks when
 * the component says something changed, and the cache answers a second viewer for free. A search is
 * none of those things. It is a question somebody asked once, of a set of resources chosen by what
 * they typed, and there is nothing to keep current - the answer stops being interesting the moment
 * the box changes. Watching it would open a subscription per resource per keystroke and close them
 * again immediately, which is the fan-out the bound exists to prevent, arriving from the cache side.
 */

export const Search = ({
    targets,
    ask,
    onQuery
}: {
    /** Everything that can be asked, built from the descriptions the host already holds. */
    targets: readonly SearchTarget[]
    /**
     * How to ask one of them. Supplied by the host for the reason every other question here is:
     * what a peer is called and how it is reached belongs to whoever holds the link.
     */
    ask: (target: SearchTarget, filter: RpcFilter, limit: number) => Promise<SearchAnswer>
    /**
     * Somebody is searching. The host uses this to fetch the descriptions it does not have yet -
     * a network is not described until somebody looks, and describing every peer on connect would
     * spend a round trip each on peers nobody asked about.
     */
    onQuery?: (query: string) => void
}) => {
    const [typed, setTyped] = useState('')
    // Settled rather than live: eight keystrokes are one question, and here one question is one per
    // resource per peer.
    const query = useDebounced(typed, 400)
    const [found, setFound] = useState<SearchResult | undefined>()
    const [looking, setLooking] = useState(false)

    useEffect(() => {
        onQuery?.(query)
    }, [query, onQuery])

    useEffect(() => {
        let cancelled = false
        if (!query.trim()) {
            setFound(undefined)
            return
        }
        setLooking(true)
        void searchAcross(targets, query, ask)
            .then((answer) => {
                // A slower answer to an older question must not land on a newer one - the box has
                // moved on, and the rows underneath it would be from a query nobody can see.
                if (!cancelled) setFound(answer)
            })
            .finally(() => {
                if (!cancelled) setLooking(false)
            })
        return () => {
            cancelled = true
        }
    }, [query, targets, ask])

    const where = (hit: { at: { peer: string; namespace: string; resource: readonly string[] } }) =>
        targets.find((one) => one.peer === hit.at.peer && one.namespace === hit.at.namespace && one.resource.join('.') === hit.at.resource.join('.'))

    return (
        <section className="search">
            <div className="search-head">
                <input
                    className="control"
                    value={typed}
                    placeholder={`search ${targets.length} resource${targets.length === 1 ? '' : 's'} by name`}
                    onChange={(event) => setTyped(event.target.value)}
                />
                {typed && (
                    <button className="toggle" onClick={() => setTyped('')}>
                        clear
                    </button>
                )}
                {looking && <span className="muted">looking…</span>}
                {/* Said plainly, because it is the bound: this finds things by the name their
                    resource nominated, not by anything else they contain. */}
                <span className="muted">by the field each resource says names a row</span>
            </div>

            {found && (
                <div className="search-where">
                    {found.total === 0 ? 'nothing of that name' : `${found.total} found`}
                    <span className="muted">
                        {' '}
                        · asked {found.asked} resource{found.asked === 1 ? '' : 's'}
                        {found.hits.length < found.total ? ` · showing ${found.hits.length}` : ''}
                    </span>
                </div>
            )}

            <ul className="search-hits">
                {found?.hits.map((hit) => {
                    const target = where(hit)
                    return (
                        <li key={`${hit.at.peer}.${hit.at.namespace}.${hit.at.resource.join('.')}.${hit.at.id}`}>
                            <a href={hitAddress(hit.at.peer, hit.at.namespace, hit.at.resource)} title={`${hit.at.peer} · ${hit.at.namespace}.${hit.at.resource.join('.')} · ${hit.at.id}`}>
                                {hit.name}
                            </a>{' '}
                            <span className="muted">
                                {hit.at.peer} · {target?.label ?? hit.at.resource.join('.')}
                            </span>
                        </li>
                    )
                })}
            </ul>

            {/* Named rather than counted. A network where one node is rebooting still answers, and a
                reader deciding the thing is not there deserves to know which peer did not look. */}
            {found?.refused.map((refusal) => (
                <p className="component-error" key={`${refusal.target.peer}.${refusal.target.namespace}.${refusal.target.resource.join('.')}`}>
                    {refusal.target.peer} · {refusal.target.namespace}.{refusal.target.resource.join('.')} could not answer: {refusal.reason}
                </p>
            ))}
        </section>
    )
}
