import { useEffect, useMemo, useState } from 'react'
import { matchesFilter, type RpcFilter, type RpcSort } from '@source-repo/rpc'
import type { RpcDataCache, RpcFreshness, RpcQuestion } from '@source-repo/query'
import { leavesUnder, treeResourceAt, typeAt, type ScopeLeaf } from './scope'
import { staticSource, ValueTree, type EditAffordance, type ValueSource } from './ValueTree'
import { compileFilter } from './filter'
import { pageControls } from './pager'
import { useRpcData } from './data'
import { ResourceTree, type BranchQuestion, type RowQuestion } from './ResourceTree'
import { RecordPanel } from './RecordPanel'
import { ObjectPanel, type ObjectAccess, type Ref, type Where } from './ObjectPanel'
import { useDebounced, useWaitedSeconds } from './timing'
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

/**
 * How a page is *named*, rather than how it is fetched. Supplied by whoever holds the link, so this
 * component opens nothing - and asks for nothing either: naming the question is now the whole of
 * what the grid does, and the cache decides whether asking it costs anything.
 */
export type PageQuestion = (resource: readonly string[], page: number, pageSize: number, filter?: RpcFilter, sort?: RpcSort) => RpcQuestion

/**
 * The three states, said out loud.
 *
 * A pane that showed only an age would be reporting the one thing this network does not have to
 * guess at. `current` is a fact from the publisher - it has said nothing since this page was drawn -
 * and `unknown` is the honest third: nothing is watching this component, or it is a table behind it
 * that the revision does not speak for. Collapsing that into "may have changed" would look like
 * caution and would be a guess wearing the same costume as the number it replaced.
 */
const FRESHNESS: { [state in RpcFreshness]: { label: string; title: string; className: string } } = {
    current: { label: 'current', title: 'the component has published nothing since this page was drawn', className: 'fresh-current' },
    'possibly-changed': { label: 'may have changed', title: 'the component has published since this page was drawn', className: 'fresh-changed' },
    unknown: { label: 'age unknown', title: 'nothing here can say whether this changed: no channel open, or a resource the revision does not cover', className: 'fresh-unknown' }
}

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
    cache,
    pageQuestion,
    period,
    pageSize,
    edit,
    filter,
    actions,
    onAction
}: {
    leaf: ScopeLeaf
    types?: { [name: string]: TypeNode }
    /** Holds the answers, and decides whether a period tick has anything to ask for. */
    cache: RpcDataCache
    pageQuestion: PageQuestion
    period: number | undefined
    pageSize: number
    edit?: EditAffordance
    /** Compiled once by the pane above, so both halves of the grid answer the same search. */
    filter?: RpcFilter
    /** What the component says may be done to a row of this resource, already checked to exist. */
    actions?: DescribedAction[]
    /** The resource travels with the call: where the button lives is what the method touched. */
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
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

    // What identifies the question is now the question itself, keyed by the library's own canonical
    // encoder inside the cache - so turning a page starts a new one and a re-render does not, and
    // two panes asking the same thing ask it once. The counter that used to be part of this key is
    // gone with it: a call that changed something now invalidates what it *claims* to have touched,
    // rather than making every collection in the pane a different question.
    const { data, error, fetching, since, freshness } = useRpcData(cache, pageQuestion(leaf.path, page, pageSize, filter, sort), period)

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
    // Every decision that depends on whether the resource could afford a count, in one place and
    // tested there: an absent total is unknown rather than zero, and reading it as zero is what
    // would tell an operator "nothing matches" over a filter that matched sixty.
    const controls = pageControls(page, pageSize, data, filter !== undefined)

    // Every row of a list is a leaf, so an action about leaves is about all of them; an action
    // declared for branches has nothing here to be about.
    const offered = (actions ?? []).filter((action) => (action.appliesTo ?? 'leaves') !== 'branches')

    return (
        <div className="collection">
            <div className="collection-head">
                <span className="value-name mono branch">{label}</span>
                <span className="muted">
                    {/* "3 of 47" where the count is known, and the row count alone where it is not -
                        rather than "3 of 0", which is what a missing count would print if it were
                        read as a zero. */}
                    {controls.count}
                    {/* Said out loud rather than shown as a blank: the rows below are the last
                        answer, and an operator has to know which of the two they are reading. */}
                    {fetching && data ? ' · refreshing' : ''}
                    {/* The fact, rather than an age. `current` here means the component has
                        published nothing since this page was drawn - which is not "recent" and is
                        not a policy, and is the one thing a period alone could never report. */}
                    {data && !fetching && (
                        <span className={FRESHNESS[freshness].className} title={FRESHNESS[freshness].title}>
                            {' · '}
                            {FRESHNESS[freshness].label}
                        </span>
                    )}
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
                {/* Drawn whenever there is anywhere to go, which is the only test that works for
                    both kinds of resource: a counted one knows how many pages there are, and an
                    uncounted one knows only that something follows. */}
                {controls.paged && (
                    <span className="pager">
                        <button className="toggle" disabled={!controls.hasPrevious} onClick={() => setPage((at) => at - 1)}>
                            ◂
                        </button>
                        {/* "2/9" where the pages can be counted, and "2" where they cannot - a
                            page number over a total nobody knows would be a made-up denominator. */}
                        <span className="muted mono">{controls.position}</span>
                        <button className="toggle" disabled={!controls.hasNext} onClick={() => setPage((at) => at + 1)}>
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
            {/* A list's rows have no children, so they are all leaves - which is why the default
                shows them and only an explicit `branches` does not. */}
            {data?.ids.map((id) => (
                <div className="collection-row" key={id}>
                    <ValueTree name={`${label}.${id}`} source={source} type={values} types={types} path={[...leaf.path, id]} edit={edit} depth={1} />
                    {/* Named calls, not verbs of ours: what is committed is the component's own
                        method, and the button exists because the component said that method is
                        about this row. Same rule as an editor drawn from `sets`, one level up. */}
                    {offered.length ? (
                        <span className="row-actions">
                            {offered.map((action) => (
                                <button key={action.method} className="toggle" title={`calls ${action.method}(${id})`} onClick={() => onAction?.(action, id, leaf.path)}>
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
            {controls.emptiness && <p className="muted">{controls.emptiness}</p>}
        </div>
    )
}

export const ValueGrid = ({
    component,
    types,
    scope,
    source,
    edit,
    cache,
    pageQuestion,
    branchQuestion,
    rowQuestion,
    objectAccess,
    period,
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
    cache: RpcDataCache
    pageQuestion: PageQuestion
    /** How to name one branch of a tree resource. Absent leaves such a resource undrawable. */
    branchQuestion?: BranchQuestion
    /** How to name one row of a resource, for opening it. Absent leaves rows unopenable. */
    rowQuestion?: RowQuestion
    /** How to open an object a row names, and follow its links. Absent leaves rows inert. */
    objectAccess?: ObjectAccess
    period: number | undefined
    /** What may be done to a row of the resource at this path, if anything. */
    actionsFor: (path: string[]) => DescribedAction[] | undefined
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
    pageSize?: number
}) => {
    // Decided before anything else in this pane, because a tree is not a page of the same thing: it
    // has no page number, its filter belongs to a branch rather than to the collection, and the
    // question it asks names a parent. Sharing the grid's machinery would mean explaining, in both
    // directions, which half of it does not apply.
    const tree = treeResourceAt(component, scope)
    // Where the reader is, which is what makes a link keep its aspect: `follow` is answered against
    // the place they are following *from*, and without it every link would land in whichever
    // structure the provider prefers.
    const [where, setWhere] = useState<Where | undefined>()
    /**
     * The row opened in the record panel, by id.
     *
     * Separate from `where`, which is an aspects placement and carries a structure with it. A row
     * opened by id has no placement and needs none - and keeping them apart is what lets one tree
     * offer whichever of the two its rows actually support.
     */
    const [opened, setOpened] = useState<string | undefined>()

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

    // Offered only where the resource said it answers for one row, which is what the verb list is
    // for: a viewer offers what is served and nothing else.
    const opensRows = !!rowQuestion && !!tree && tree.verbs.includes('getOne')
    // Closed when the reader moves to another resource. An id belongs to the resource that handed
    // it out, so carrying it across would ask the new one about a row of the old one - which it
    // answers, correctly and uselessly, with "no longer a row with this id".
    const here = scope.join('.')
    useEffect(() => setOpened(undefined), [here])
    const columns = tree?.presentation?.defaultColumns ?? []

    // A tree is the whole pane when one is selected. There is nothing else under that scope node -
    // a resource has no typed leaves of its own - so drawing the empty grid furniture around it
    // would be a filter box and a field count for something that has neither.
    if (tree)
        return (
            <div className="value-grid">
                {branchQuestion ? (
                    <div className="tree-and-object">
                        <ResourceTree
                            resource={tree}
                            cache={cache}
                            branchQuestion={branchQuestion}
                            period={period}
                            selected={where?.occurrenceId ?? opened}
                            onSelect={objectAccess ? (ref: Ref, occurrenceId: string) => setWhere({ target: ref, aspectId: tree.path[0], occurrenceId, inherited: false }) : undefined}
                            onOpenRow={opensRows ? setOpened : undefined}
                            actions={actionsFor(tree.path as string[])}
                            onAction={onAction}
                        />
                        {objectAccess && where && <ObjectPanel target={where.target} access={objectAccess} where={where} onWhere={setWhere} />}
                        {/* Only where the resource said it answers for one row. A panel offered
                            against a resource that does not serve `getOne` would open on a refusal,
                            which is a worse answer than no button at all - the verb list is there
                            precisely so a viewer offers what is served and nothing else. */}
                        {opensRows && opened !== undefined && (
                            <RecordPanel cache={cache} question={rowQuestion(tree.path, opened)} id={opened} period={period} columns={columns} onClose={() => setOpened(undefined)} />
                        )}
                    </div>
                ) : (
                    <p className="muted">this pane was given no way to ask for a branch, so the tree cannot be drawn</p>
                )}
            </div>
        )

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
                    cache={cache}
                    pageQuestion={pageQuestion}
                    period={period}
                    pageSize={pageSize}
                    edit={edit}
                    filter={filter}
                    actions={actionsFor(leaf.path)}
                    onAction={onAction}
                />
            ))}
            {leaves.length === 0 && <p className="muted">nothing under this node</p>}
        </div>
    )
}
