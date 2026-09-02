import { useMemo, useState } from 'react'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import type { RpcFilter, RpcGetListResult } from '@source-repo/rpc'
import { useRpcData } from './data'
import { useDebounced } from './timing'
import { hitAddress, searchable, searchFilter, type Searchable } from './searching'
import type { ServerDescription } from './types'

/**
 * One box, every resource of this peer that can answer.
 *
 * The experiment the plan calls for, built as a client so that what a real search contract needs can
 * be learnt rather than guessed: it asks the verbs and the filter language that already exist, and
 * what it cannot do is the specification for what would have to be added.
 *
 * Two things it already cannot do, and both are findings rather than omissions. A resource that
 * answers only `getChildren` - a document library - cannot be asked a question about all of it, so
 * it is absent from the results entirely. And there is no ranking: results are grouped by where they
 * came from, in the order the peer describes them, because nothing here can compare a customer
 * against an OPC UA node and say which is the better answer. A real search would have to.
 */

/** How many hits one resource may contribute. Small on purpose - see `SearchIn`. */
const PER_RESOURCE = 5

/**
 * One resource, asked.
 *
 * A component per resource rather than a loop over them, because a hook cannot be called in a loop
 * whose length changes and the number of searchable resources changes with the peer. It also means a
 * slow one does not hold up the rest: each arrives when it arrives.
 *
 * **The page is deliberately tiny.** A search box issues a question on every keystroke somebody
 * pauses in, against as many resources as a peer serves, over a link that may be a plant network -
 * so each asks for five. Five is enough to see whether the thing being looked for is there; the way
 * to see the rest is to open the resource, which is what the hit links to.
 */
const SearchIn = ({
    cache,
    where,
    filter,
    peer,
    pageQuestion,
    period
}: {
    cache: RpcDataCache
    where: Searchable
    filter: RpcFilter
    peer: string
    pageQuestion: (namespace: string, resource: readonly string[], filter: RpcFilter, size: number) => RpcQuestion
    period: number | undefined
}) => {
    const question = useMemo(() => pageQuestion(where.namespace, where.resource.path, filter, PER_RESOURCE), [pageQuestion, where, filter])
    const { data, error, fetching } = useRpcData<RpcGetListResult>(cache, question, period)

    const rows = data?.ids?.length ? data.ids.map((id, at) => ({ id, row: data.data?.[at] })) : []
    // Nothing found is not worth a line. A reader looking for `acme` does not need to be told that
    // eleven resources do not have it - the ones that do are the answer.
    if (!rows.length && !error) return null

    const label = where.resource.label ?? where.resource.path.join('.')
    return (
        <div className="search-group">
            <div className="search-where">
                <span className="mono">{where.namespace}</span> <span className="muted">{label}</span>
                {fetching && <span className="muted"> · looking</span>}
                {/* A count only where the peer could afford one, which is the same rule the pager
                    follows: a number nobody counted is a number somebody would believe. */}
                {data?.total !== undefined && data.total > rows.length && <span className="muted"> · {data.total} in all</span>}
            </div>
            {error && <p className="component-error">{error}</p>}
            <ul className="search-hits">
                {rows.map(({ id, row }) => {
                    const named = row && typeof row === 'object' ? (row as Record<string, unknown>)[where.representation] : undefined
                    return (
                        <li key={String(id)}>
                            <a href={hitAddress(peer, where.namespace, where.resource.path)} title={`${where.namespace}.${where.resource.path.join('.')} · ${String(id)}`}>
                                {typeof named === 'string' && named ? named : String(id)}
                            </a>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

export const Search = ({
    description,
    peer,
    cache,
    pageQuestion,
    period
}: {
    description: ServerDescription | undefined
    peer: string
    cache: RpcDataCache
    pageQuestion: (namespace: string, resource: readonly string[], filter: RpcFilter, size: number) => RpcQuestion
    period: number | undefined
}) => {
    const [typed, setTyped] = useState('')
    // Settled rather than live, for the reason the collection's own box settles: eight keystrokes
    // are one question and not eight - and here one question is one *per resource*.
    const query = useDebounced(typed, 400)
    const where = useMemo(() => searchable(description), [description])

    return (
        <section className="search">
            <div className="search-head">
                <input className="control" value={typed} placeholder={`search ${where.length} resource${where.length === 1 ? '' : 's'} by name`} onChange={(event) => setTyped(event.target.value)} />
                {typed && (
                    <button className="toggle" onClick={() => setTyped('')}>
                        clear
                    </button>
                )}
                {/* Said plainly, because it is the bound: this finds things by the name their
                    resource nominated, not by anything else they contain. */}
                <span className="muted">by the field each resource says names a row</span>
            </div>
            {query.trim() &&
                where.map((one) => {
                    const filter = searchFilter(query, one.representation)
                    return filter ? (
                        <SearchIn key={`${one.namespace}.${one.resource.path.join('.')}`} cache={cache} where={one} filter={filter} peer={peer} pageQuestion={pageQuestion} period={period} />
                    ) : null
                })}
        </section>
    )
}
