import { useEffect, useMemo, useState } from 'react'
import { matchesFilter, type RpcFilter, type RpcGetListResult, type RpcSort } from '@source-repo/rpc'
import { leavesUnder, typeAt, type ScopeLeaf } from './scope'
import { staticSource, ValueTree, type EditAffordance, type ValueSource } from './ValueTree'
import { compileFilter } from './filter'
import { useDebounced, usePolled, useWaitedSeconds } from './polled'
import type { DescribedAction, DescribedComponent, TypeNode } from './types'

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
export type FetchPage = (resource: readonly string[], page: number, pageSize: number, filter?: RpcFilter, sort?: RpcSort) => Promise<RpcGetListResult>

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
    settled,
    filter,
    actions,
    onAction
}: {
    leaf: ScopeLeaf
    types?: { [name: string]: TypeNode }
    fetchPage: FetchPage
    period: number | undefined
    pageSize: number
    edit?: EditAffordance
    settled: number
    /** Compiled once by the pane above, so both halves of the grid answer the same search. */
    filter?: RpcFilter
    /** What the component says may be done to a row of this resource, already checked to exist. */
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string) => void
}) => {
    const [page, setPage] = useState(0)
    const [sort, setSort] = useState<RpcSort | undefined>()
    const label = leaf.path.join('.')
    const values = leaf.type?.kind === 'record' ? leaf.type.values : leaf.type?.kind === 'array' ? leaf.type.items : undefined
    const ordering = JSON.stringify([filter ?? null, sort ?? null])

    // Adjusted during the render that noticed it, rather than in an effect afterwards. An effect
    // would let one request go out for page five of a set the filter has just emptied, and a second
    // for page zero - two questions where the operator asked one, on the link least able to spare it.
    // A new order does the same: page five of an old order holds nothing an operator asked to see.
    const [asked, setAsked] = useState(ordering)
    if (asked !== ordering) {
        setAsked(ordering)
        setPage(0)
    }

    /**
     * What may be ordered by: the id, and whatever the contract says a row holds.
     *
     * Drawn from the row type rather than from a row, so the choices exist before any data arrives
     * and are the same on an empty collection as on a full one - and so a field that is null in
     * every row currently loaded is still offered, which a value-driven list could not manage.
     */
    const sortable = values?.kind === 'object' ? Object.keys(values.fields) : []

    // What identifies the question, so turning a page starts a new one and a re-render does not.
    // `settled` is in it because a call that has just changed something makes this a different
    // question - and it is a counter rather than a remount, so the operator stays on the page
    // they were reading rather than being sent back to the first one for having edited a row.
    //
    // The separator is written as an escape and never as the byte. A literal control character
    // makes the file binary to everything that sniffs content: grep matches and prints nothing,
    // and git stops diffing it. See CLAUDE.md - this has cost this repository time twice.
    const question = [label, page, pageSize, settled, ordering].join('\u0001')
    const { data, error, fetching, since } = usePolled(() => fetchPage(leaf.path, page, pageSize, filter, sort), period, question)

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

    // Ticking while a fetch is in flight, and absent otherwise. A pane that says `asking…` and
    // nothing else looks exactly like one that has died.
    const waited = useWaitedSeconds(since)
    const total = data?.total ?? 0
    const pages = pageSize > 0 ? Math.ceil(total / pageSize) : 1

    return (
        <div className="collection">
            <div className="collection-head">
                <span className="value-name mono branch">{label}</span>
                <span className="muted">
                    {data ? `${data.ids.length} of ${total}` : 'asking…'}
                    {/* Said out loud rather than shown as a blank: the rows below are the last
                        answer, and an operator has to know which of the two they are reading. */}
                    {fetching && data ? ' · refreshing' : ''}
                    {/* Two different numbers, and both are worth having. How long this has been
                        waiting says the request is alive; how long the peer spent says where the
                        time went - and their difference is the link. Without the second, a slow
                        query and a dead link look the same from here. */}
                    {waited !== undefined && waited > 0 && <span className="waiting"> {waited}s</span>}
                    {!fetching && data?.ms !== undefined && data.ms >= 250 && (
                        <span className="slow">
                            {' '}
                            · peer {data.ms} ms
                            {/* Which half, where the component could tell them apart. A fast page
                                behind a slow count wants the count asked for less often; a slow
                                page wants an index. One figure cannot tell those apart. */}
                            {data.countMs !== undefined && data.queryMs !== undefined && ` (rows ${data.queryMs}, count ${data.countMs})`}
                        </span>
                    )}
                </span>
                {/* Ordering is the peer's, over the whole matched set - an order applied to the
                    fifty rows already here would be an order over nothing, and would disagree with
                    itself the moment a page was turned. */}
                <span className="sorter">
                    <select
                        className="period"
                        value={sort?.field ?? ''}
                        title="order the whole matched set, not this page"
                        onChange={(event) => setSort(event.target.value ? { field: event.target.value, order: sort?.order ?? 'ASC' } : undefined)}
                    >
                        <option value="">by key</option>
                        {sortable.map((field) => (
                            <option key={field} value={field}>
                                by {field}
                            </option>
                        ))}
                    </select>
                    {sort && (
                        <button className="toggle" title={sort.order === 'DESC' ? 'descending' : 'ascending'} onClick={() => setSort({ ...sort, order: sort.order === 'DESC' ? 'ASC' : 'DESC' })}>
                            {sort.order === 'DESC' ? '▾' : '▴'}
                        </button>
                    )}
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
            {error && (
                <p className="component-error">
                    {label}: {error}
                </p>
            )}
            {data?.ids.map((id) => (
                <div className="collection-row" key={id}>
                    <ValueTree name={`${label}.${id}`} source={source} type={values} types={types} path={[...leaf.path, id]} edit={edit} depth={1} />
                    {/* Named calls, not verbs of ours: what is committed is the component's own
                        method, and the button exists because the component said that method is
                        about this row. Same rule as an editor drawn from `sets`, one level up. */}
                    {actions?.length ? (
                        <span className="row-actions">
                            {actions.map((action) => (
                                <button key={action.method} className="toggle" title={`calls ${action.method}(${id})`} onClick={() => onAction?.(action, id)}>
                                    {action.label ?? action.method}
                                </button>
                            ))}
                        </span>
                    ) : null}
                </div>
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
    actionsFor,
    onAction,
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
    /** What may be done to a row of the resource at this path, if anything. */
    actionsFor: (path: string[]) => DescribedAction[] | undefined
    onAction?: (action: DescribedAction, id: string) => void
    pageSize?: number
}) => {
    const [typed, setTyped] = useState('')
    // Settled rather than live, so eight keystrokes are one question and not eight.
    const search = useDebounced(typed, 400)
    const filter = useMemo(() => compileFilter(search), [search])

    const leaves = useMemo(() => leavesUnder(typeAt(component, scope, types), scope, types), [component, scope, types])
    const collections = leaves.filter((leaf) => leaf.collection)
    const all = leaves.filter((leaf) => !leaf.collection)

    /**
     * The grid re-reads its own values while a filter is active, and only then.
     *
     * A subscribed leaf changes without this component rendering - that is the arrangement that
     * keeps one moving tag from redrawing its three hundred neighbours - so a filter on `quality`
     * would otherwise keep showing whichever rows matched when it was typed. The subscription costs
     * a render of the visible rows per snapshot, which is the price of a filter that stays true, and
     * nothing at all is subscribed when the box is empty.
     */
    const [, retest] = useState(0)
    useEffect(() => {
        if (!filter) return
        return source.subscribe(() => retest((count) => count + 1))
    }, [source, filter])

    // Filtered with the library's own matcher rather than a version of it, because a search meaning
    // two different things either side of one pane would be worse than no search at all. The id of a
    // typed leaf is its path, which is what makes `setp` find `state.zones.top.setpoint`.
    const plain = filter ? all.filter((leaf) => matchesFilter(filter, source.read(leaf.path), leaf.path.join('.'))) : all

    return (
        <div className="value-grid">
            <div className="grid-head">
                {/* One box for the pane. The subscribed half is filtered here, where it is already
                    held; the collections carry the same condition to the peer, so a search that
                    matches nothing there costs a sentence rather than a record. `quality:bad` is the
                    query this exists for - the one no local filter can answer. See filter.ts. */}
                <input
                    className="value-edit filter-box"
                    value={typed}
                    placeholder="filter"
                    title="a word searches the path; field:word narrows to a field; & is and, | is or"
                    onChange={(event) => setTyped(event.target.value)}
                />
                {all.length > 0 && (
                    <span className="muted">
                        {filter ? `${plain.length} of ${all.length}` : `${all.length}`} field{all.length === 1 ? '' : 's'}
                    </span>
                )}
            </div>
            {plain.map((leaf) => (
                <ValueTree key={leaf.path.join('.')} name={leaf.path.join('.')} source={source} type={leaf.type} types={types} path={leaf.path} edit={edit} depth={1} />
            ))}
            {filter && all.length > 0 && plain.length === 0 && <p className="muted">no field matches</p>}
            {collections.map((leaf) => (
                <Collection
                    key={leaf.path.join('.')}
                    leaf={leaf}
                    types={types}
                    fetchPage={fetchPage}
                    period={period}
                    pageSize={pageSize}
                    edit={edit}
                    settled={settled}
                    filter={filter}
                    actions={actionsFor(leaf.path)}
                    onAction={onAction}
                />
            ))}
            {leaves.length === 0 && <p className="muted">nothing under this node</p>}
        </div>
    )
}
