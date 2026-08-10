import { useMemo, useState } from 'react'
import type { RpcFilter, RpcGetListResult } from '@source-repo/rpc'
import { leavesUnder, typeAt, type ScopeLeaf } from './scope'
import { staticSource, ValueTree, type EditAffordance, type ValueSource } from './ValueTree'
import { compileFilter } from './filter'
import { useDebounced, usePolled } from './polled'
import type { DescribedComponent, TypeNode } from './types'

/**
 * The right pane: values, flat, one row each.
 *
 * Everything beneath the selected scope node, recursively - which for a component carrying three
 * hundred tags is the difference between a screen and a tree nobody can read. Rows are drawn by
 * `ValueTree` rather than by anything new here, so a process value stays one row with its unit and
 * quality, an editor still comes from what a method declares it `sets`, and the three ways a value
 * can be rendered cannot drift apart.
 *
 * **The two halves of the grid arrive by different means, split on the line the contract draws.**
 *
 * *Typed leaves are subscribed to.* The contract names them, so their number is bounded and known
 * before any data exists, and a projection naming them is cheap and stays current by itself.
 *
 * *Collection rows are asked for.* A record's keys are data, so nothing can name page two without
 * first receiving everything - which is what the pull exists to avoid. One `getList` per page, one
 * round trip, and a page costs a page.
 *
 * Type ends, data begins. The same cut that keeps records out of the scope tree decides which half
 * of this grid subscribes and which half asks.
 */

/** How a page is fetched. Supplied by whoever holds the link, so this component opens nothing. */
export type FetchPage = (resource: readonly string[], page: number, pageSize: number, filter?: RpcFilter) => Promise<RpcGetListResult>

/**
 * One collection, paged.
 *
 * Its own page number and its own period, so two collections in one scope turn pages independently
 * - and, because both fetches are issued in the same tick, they cost one frame rather than two on a
 * transport that batches calls.
 */
const Collection = ({
    leaf,
    types,
    fetchPage,
    period,
    pageSize,
    edit,
    settled
}: {
    leaf: ScopeLeaf
    types?: { [name: string]: TypeNode }
    fetchPage: FetchPage
    period: number | undefined
    pageSize: number
    edit?: EditAffordance
    settled: number
}) => {
    const [page, setPage] = useState(0)
    const [typed, setTyped] = useState('')
    const label = leaf.path.join('.')

    // Settled rather than live, so eight keystrokes are one question and not eight.
    const search = useDebounced(typed, 400)
    const filter = useMemo(() => compileFilter(search), [search])
    const filterKey = JSON.stringify(filter ?? null)

    // Adjusted during the render that noticed it, rather than in an effect afterwards. An effect
    // would let one request go out for page five of a set the filter has just emptied, and a second
    // for page zero - two questions where the operator asked one, on the link least able to spare it.
    const [asked, setAsked] = useState(filterKey)
    if (asked !== filterKey) {
        setAsked(filterKey)
        setPage(0)
    }

    // What identifies the question, so turning a page starts a new one and a re-render does not.
    // `settled` is in it because a call that has just changed something makes this a different
    // question - and it is a counter rather than a remount, so the operator stays on the page
    // they were reading rather than being sent back to the first one for having edited a row.
    //
    // The separator is written as an escape and never as the byte. A literal control character
    // makes the file binary to everything that sniffs content: grep matches and prints nothing,
    // and git stops diffing it. See CLAUDE.md - this has cost this repository time twice.
    const question = [label, page, pageSize, settled, filterKey].join('\u0001')
    const { data, error, fetching } = usePolled(() => fetchPage(leaf.path, page, pageSize, filter), period, question)

    /**
     * The answer as something a row can read from.
     *
     * `ids` and `data` travel as parallel arrays - a row may be a primitive, and one that already
     * had an `id` field would otherwise be quietly overwritten - so they are paired up here, and
     * nested under the resource path so a row's path is the true one. That matters for editing:
     * what `setterFor` is handed has to be the path a method claims, not a key on its own.
     */
    const source: ValueSource = useMemo(
        () =>
            staticSource(
                leaf.path.reduceRight<unknown>(
                    (below, segment) => ({ [segment]: below }),
                    Object.fromEntries((data?.ids ?? []).map((id, index) => [id, data?.data[index]]))
                )
            ),
        [data, leaf.path]
    )

    const total = data?.total ?? 0
    const pages = pageSize > 0 ? Math.ceil(total / pageSize) : 1
    const values = leaf.type?.kind === 'record' ? leaf.type.values : leaf.type?.kind === 'array' ? leaf.type.items : undefined

    return (
        <div className="collection">
            <div className="collection-head">
                <span className="value-name mono branch">{label}</span>
                {/* Compiled to a condition and answered where the data is, so a search that matches
                    nothing costs a sentence rather than a record. `quality:bad` is the query this
                    box exists for - the one a local filter would have to receive everything to
                    answer. See filter.ts for the grammar. */}
                <input
                    className="value-edit filter-box"
                    value={typed}
                    placeholder="filter"
                    title="a word searches the tag name; field:word narrows to a field; & is and, | is or"
                    onChange={(event) => setTyped(event.target.value)}
                />
                <span className="muted">
                    {data ? `${data.ids.length} of ${total}` : 'asking…'}
                    {/* Said out loud rather than shown as a blank: the rows below are the last
                        answer, and an operator has to know which of the two they are reading. */}
                    {fetching && data ? ' · refreshing' : ''}
                </span>
                {pages > 1 && (
                    <span className="pager">
                        <button className="toggle" disabled={page === 0} onClick={() => setPage((at) => at - 1)}>
                            ◂
                        </button>
                        <span className="muted mono">
                            {page + 1}/{pages}
                        </span>
                        <button className="toggle" disabled={page + 1 >= pages} onClick={() => setPage((at) => at + 1)}>
                            ▸
                        </button>
                    </span>
                )}
            </div>
            {error && <p className="component-error">{error}</p>}
            {data?.ids.map((id) => (
                <ValueTree key={id} name={`${label}.${id}`} source={source} type={values} types={types} path={[...leaf.path, id]} edit={edit} depth={1} />
            ))}
            {/* Three different nothings, and an operator has to be able to tell them apart: a
                collection with no entries, a search that matched none of them, and a page that ran
                off the end of a set which shrank while it was being read. */}
            {data && data.ids.length === 0 && <p className="muted">{total > 0 ? 'past the end' : filter ? 'nothing matches' : 'empty'}</p>}
        </div>
    )
}

export const ValueGrid = ({
    component,
    types,
    scope,
    source,
    edit,
    fetchPage,
    period,
    settled,
    pageSize = 50
}: {
    component: DescribedComponent
    types?: { [name: string]: TypeNode }
    /** The selected scope node, spelled from the root: `['state', 'zones']`. */
    scope: string[]
    /** The live snapshot, rooted at the component rather than at props or state. */
    source: ValueSource
    edit?: EditAffordance
    fetchPage: FetchPage
    period: number | undefined
    /** Bumped whenever a call settles, so a page that a command may have changed is asked again. */
    settled: number
    pageSize?: number
}) => {
    const leaves = useMemo(() => leavesUnder(typeAt(component, scope, types), scope, types), [component, scope, types])
    const plain = leaves.filter((leaf) => !leaf.collection)
    const collections = leaves.filter((leaf) => leaf.collection)

    return (
        <div className="value-grid">
            {plain.map((leaf) => (
                <ValueTree key={leaf.path.join('.')} name={leaf.path.join('.')} source={source} type={leaf.type} types={types} path={leaf.path} edit={edit} depth={1} />
            ))}
            {collections.map((leaf) => (
                <Collection key={leaf.path.join('.')} leaf={leaf} types={types} fetchPage={fetchPage} period={period} pageSize={pageSize} edit={edit} settled={settled} />
            ))}
            {leaves.length === 0 && <p className="muted">nothing under this node</p>}
        </div>
    )
}
