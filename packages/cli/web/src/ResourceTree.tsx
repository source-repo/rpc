import { useMemo, useState } from 'react'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import { useRpcData } from './data'
import type { Ref } from './ObjectPanel'
import type { DescribedAction, DescribedResource } from './types'

/**
 * A resource declared `shape: 'tree'`, browsed one branch at a time.
 *
 * The grid beside this asks `getList` and draws a page. That is the right shape for a table and the
 * wrong one for a hierarchy the node computes rather than holds: documentation filed in folders, a
 * workspace on another service, a security zoning of things that are physically elsewhere. Nobody
 * can say how many descendants a node has before somebody asks, so there is no page size that means
 * anything until a branch is named.
 *
 * So this asks `getChildren`, once per opened branch, and closing a branch stops asking. Expanding
 * one folder says nothing about what is inside the folders it contains, which is the entire point of
 * the verb - the alternative is a walk of the whole tree to draw its first level.
 *
 * **`hasChildren` is why an expander can be drawn at all.** It rides beside the rows because a row
 * may be a primitive and a row with its own `hasChildren` field would otherwise be overwritten. A
 * viewer has to decide whether to offer an expander *before* anyone expands; without the flag the
 * choice is an arrow on every row, half of which open onto nothing, or a request per row to find
 * out - which is the fan-out this whole arrangement avoids.
 */

/** One branch's question. Absent `parentId` asks for the roots, which is a different question. */
export type BranchQuestion = (resource: readonly string[], parentId: string | undefined, page: number, pageSize: number) => RpcQuestion

/** One row's question, for opening it on its own. `getOne`, where a resource answers that verb. */
export type RowQuestion = (resource: readonly string[], id: string) => RpcQuestion

interface Branch {
    readonly ids: readonly string[]
    readonly data: readonly unknown[]
    readonly hasChildren?: readonly boolean[]
    readonly total?: number
}

const field = (row: unknown, name: string): unknown => (row && typeof row === 'object' ? (row as Record<string, unknown>)[name] : undefined)

/**
 * The object a row stands for, when it stands for one.
 *
 * A grouping node - a folder, a topic, a workflow state - carries no reference, and that absence is
 * the signal rather than an omission: there is nothing to open, because the provider has no object
 * by that name. Drawing it as openable would promise something nobody can deliver.
 */
const refOf = (row: unknown): Ref | undefined => {
    const ref = field(row, 'ref') as Ref | undefined
    return ref && typeof ref.id === 'string' && ref.provider ? ref : undefined
}

/** What to call a row: what the resource says to show first, then the obvious names, then its id. */
const labelOf = (row: unknown, id: string, columns: readonly string[]): string => {
    for (const column of [...columns, 'title', 'name', 'label']) {
        const value = field(row, column)
        if (typeof value === 'string' && value) return value
    }
    return id
}

/**
 * The fields drawn beside the label.
 *
 * `presentation.defaultColumns` decides, and it is advice rather than a schema: a path the row does
 * not have is simply not drawn. Every other field is still there to be read by opening the row -
 * this chooses what is shown first, never what may be shown, which is the line the hint is drawn on.
 */
const detailsOf = (row: unknown, columns: readonly string[], label: string): [string, string][] =>
    columns
        .map((column) => [column, field(row, column)] as const)
        .filter(([, value]) => value !== undefined && value !== null && value !== '' && String(value) !== label)
        .map(([column, value]) => [column, Array.isArray(value) ? value.join(', ') : String(value)] as [string, string])

/** A cell. Objects and arrays are flattened rather than dropped, as they are beside a tree row. */
const cell = (value: unknown): string =>
    value === undefined || value === null ? '' : Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)

const Node = ({
    id,
    row,
    depth,
    expandable,
    resource,
    columns,
    cache,
    branchQuestion,
    period,
    pageSize,
    selected,
    onSelect,
    onPickRow,
    branchesOnly,
    actions,
    onAction
}: {
    id: string
    row: unknown
    depth: number
    expandable: boolean
    resource: readonly string[]
    columns: readonly string[]
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize: number
    selected?: string
    onSelect?: (ref: Ref, occurrenceId: string) => void
    /**
     * A row was picked, by its id.
     *
     * A second prop rather than a widened `onSelect`, because that one hands over a `Ref` - a peer,
     * an instance and an object id - which is what an aspect provider's `openObject` needs and what
     * only an aspect provider can produce. A resource that merely answers `getOne` has an id and
     * nothing else, and pretending it had a reference would mean inventing two thirds of one.
     *
     * What picking *means* belongs to the host: with leaves in the tree it opens the row, and with
     * only branches drawn it chooses the branch whose children are tabulated beside it. One gesture
     * on one row, so one prop.
     */
    onPickRow?: (id: string) => void
    /**
     * Draw only the rows that have children.
     *
     * The tree as *scope* rather than as the whole thing: the branches say which set of rows is
     * being looked at, and the rows themselves are read across in a table beside it. Filtered here
     * rather than asked for, because `hasChildren` already arrived with the branch - a resource has
     * no verb for "the branches only", and inventing one would be a second question per branch.
     */
    branchesOnly?: boolean
    /** What may be done to a row of this resource, as methods the component already declares. */
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
}) => {
    const [open, setOpen] = useState(false)
    const ref = refOf(row)
    /**
     * What an action is about: the **object**, not the placement.
     *
     * A row's id here is its occurrence id - where a thing sits in one arrangement - because that is
     * what a caller passes back as the parent of the next branch, and one object may legitimately be
     * several rows. The object's own id travels beside it, in the reference. An action taking the
     * occurrence would name a position in a tree: `delete` against it would remove a document's place
     * in a folder and report that it had deleted the document.
     *
     * Where a row carries no reference there is no such distinction to get wrong - the resource's
     * key is the thing itself - so the row id is right and is what is used.
     */
    const subject = ref?.id ?? id
    /**
     * The actions this row is the right kind of thing for.
     *
     * Read from `hasChildren`, which the branch already carried positionally, so this costs nothing
     * on the wire. A row with children is a branch; one without is a leaf; and an action says which
     * it is about, or says nothing and means leaves.
     */
    const offered = (actions ?? []).filter((action) => (action.appliesTo ?? 'leaves') === 'all' || (action.appliesTo ?? 'leaves') === (expandable ? 'branches' : 'leaves'))
    const label = labelOf(row, id, columns)
    const details = detailsOf(row, columns, label)

    return (
        <>
            <div className="tree-row" style={{ paddingLeft: `${depth * 1.1}rem` }}>
                {expandable ? (
                    <button className="tree-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'collapse' : 'expand'}>
                        {open ? '▾' : '▸'}
                    </button>
                ) : (
                    <span className="tree-toggle tree-leaf" />
                )}
                {/* Openable two ways, and by whichever the row actually supports: an aspect
                    reference goes to the object panel with its content and links, and a bare id
                    goes to the record panel. Same button, because to a reader they are the same
                    gesture - open this row. */}
                {ref && onSelect ? (
                    <button className={`tree-label tree-openable${selected === id ? ' tree-selected' : ''}`} onClick={() => onSelect(ref, id)} title={`open ${ref.id}`}>
                        {label}
                    </button>
                ) : onPickRow ? (
                    <button className={`tree-label tree-openable${selected === id ? ' tree-selected' : ''}`} onClick={() => onPickRow(id)} title={id}>
                        {label}
                    </button>
                ) : (
                    <span className="tree-label" title={id}>
                        {label}
                    </span>
                )}
                {details.map(([column, value]) => (
                    <span className="tree-detail" key={column}>
                        <span className="muted">{column}</span> {value}
                    </span>
                ))}
                {/* Named calls, not verbs of ours: what is committed is the component's own method,
                    and the button exists because the component said that method is about this row.
                    The same rule the grid's rows follow, arriving in the half of the pane that
                    could not draw them. */}
                {offered.length ? (
                    <span className="row-actions">
                        {offered.map((action) => (
                            <button key={action.method} className="toggle" title={`calls ${action.method}(${subject})`} onClick={() => onAction?.(action, subject, resource)}>
                                {action.label ?? action.method}
                            </button>
                        ))}
                    </span>
                ) : null}
            </div>
            {/* Mounted only while open, so a closed branch is not merely hidden - it is not asked
                for, and the watch that would keep it current is not open either. */}
            {open && (
                <BranchRows
                    parentId={id}
                    depth={depth + 1}
                    resource={resource}
                    columns={columns}
                    cache={cache}
                    branchQuestion={branchQuestion}
                    period={period}
                    pageSize={pageSize}
                    selected={selected}
                    onSelect={onSelect}
                    onPickRow={onPickRow}
                    branchesOnly={branchesOnly}
                    actions={actions}
                    onAction={onAction}
                />
            )}
        </>
    )
}

const BranchRows = ({
    parentId,
    depth,
    resource,
    columns,
    cache,
    branchQuestion,
    period,
    pageSize,
    selected,
    onSelect,
    onPickRow,
    branchesOnly,
    actions,
    onAction
}: {
    parentId: string | undefined
    depth: number
    resource: readonly string[]
    columns: readonly string[]
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize: number
    selected?: string
    onSelect?: (ref: Ref, occurrenceId: string) => void
    /**
     * A row was picked, by its id.
     *
     * A second prop rather than a widened `onSelect`, because that one hands over a `Ref` - a peer,
     * an instance and an object id - which is what an aspect provider's `openObject` needs and what
     * only an aspect provider can produce. A resource that merely answers `getOne` has an id and
     * nothing else, and pretending it had a reference would mean inventing two thirds of one.
     *
     * What picking *means* belongs to the host: with leaves in the tree it opens the row, and with
     * only branches drawn it chooses the branch whose children are tabulated beside it. One gesture
     * on one row, so one prop.
     */
    onPickRow?: (id: string) => void
    /**
     * Draw only the rows that have children.
     *
     * The tree as *scope* rather than as the whole thing: the branches say which set of rows is
     * being looked at, and the rows themselves are read across in a table beside it. Filtered here
     * rather than asked for, because `hasChildren` already arrived with the branch - a resource has
     * no verb for "the branches only", and inventing one would be a second question per branch.
     */
    branchesOnly?: boolean
    /** What may be done to a row of this resource, as methods the component already declares. */
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
}) => {
    const [page, setPage] = useState(0)
    const question = useMemo(() => branchQuestion(resource, parentId, page, pageSize), [branchQuestion, resource, parentId, page, pageSize])
    const { data, error, fetching } = useRpcData(cache, question, period)
    const branch = data as Branch | undefined

    if (error) return <p className="tree-note error" style={{ paddingLeft: `${depth * 1.1}rem` }}>{String(error)}</p>
    if (!branch) return fetching ? <p className="tree-note muted" style={{ paddingLeft: `${depth * 1.1}rem` }}>reading…</p> : null
    if (!branch.ids.length) return <p className="tree-note muted" style={{ paddingLeft: `${depth * 1.1}rem` }}>nothing here</p>

    const shown = (page + 1) * pageSize
    // Filtered after the answer rather than asked for. `hasChildren` came with the branch, so the
    // branches are already known here; a "branches only" verb would be a second question about a
    // set the node has just described.
    const drawn = branch.ids.map((id, index) => [id, index] as const).filter(([, index]) => !branchesOnly || branch.hasChildren?.[index] === true)
    if (branchesOnly && !drawn.length) return null
    return (
        <>
            {drawn.map(([id, index]) => (
                <Node
                    key={id}
                    id={id}
                    row={branch.data[index]}
                    depth={depth}
                    // The flag the peer sent, and nothing inferred: a row it did not speak for gets
                    // no expander rather than one that might open onto nothing.
                    expandable={branch.hasChildren?.[index] === true}
                    resource={resource}
                    columns={columns}
                    cache={cache}
                    branchQuestion={branchQuestion}
                    period={period}
                    pageSize={pageSize}
                    selected={selected}
                    onSelect={onSelect}
                    onPickRow={onPickRow}
                    branchesOnly={branchesOnly}
                    actions={actions}
                    onAction={onAction}
                />
            ))}
            {/* A branch is paged like anything else. A folder of four thousand files is exactly the
                case where drawing all of it is the failure, and "more" is one further question. */}
            {branch.total !== undefined && branch.total > shown && (
                <button className="tree-more" style={{ marginLeft: `${depth * 1.1}rem` }} onClick={() => setPage(page + 1)}>
                    {branch.total - shown} more
                </button>
            )}
        </>
    )
}

/**
 * One branch's children, read across instead of down.
 *
 * The same verb, the same rows and the same declared columns as the tree beside it - what differs is
 * that these are *aligned*, and alignment is the whole point where a branch's children are the same
 * kind of thing as each other. A rack of ports has one number worth reading down a column, and in a
 * tree it sits after a label of whatever length the port happened to have.
 *
 * Which is why this is not a better tree. Where the children of a branch differ from one another -
 * a folder holding documents and other folders, an address space holding objects and variables - a
 * table is four columns of blanks and the tree is right. Both arrangements are drawn from the same
 * answer, and which one opens is a fact about the data rather than a preference of this file.
 */
export const BranchTable = ({
    resource,
    columns,
    parentId,
    cache,
    branchQuestion,
    period,
    pageSize = 100,
    selected,
    onPickRow,
    actions,
    onAction
}: {
    resource: readonly string[]
    columns: readonly string[]
    /** The branch being tabulated. Absent asks for the roots, as everywhere else. */
    parentId: string | undefined
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize?: number
    selected?: string
    onPickRow?: (id: string) => void
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
}) => {
    const [page, setPage] = useState(0)
    const question = useMemo(() => branchQuestion(resource, parentId, page, pageSize), [branchQuestion, resource, parentId, page, pageSize])
    const { data, error, fetching } = useRpcData(cache, question, period)
    const branch = data as Branch | undefined

    if (error) return <p className="tree-note error">{String(error)}</p>
    if (!branch) return fetching ? <p className="tree-note muted">reading…</p> : null
    if (!branch.ids.length) return <p className="tree-note muted">nothing here</p>

    /**
     * A level that is entirely branches is scope, not content.
     *
     * The columns a resource names describe its *rows* - `port`, `baudrate`, `status`, `errors` -
     * and the cabinets at the root of a rack have none of them. Tabulating those draws the header
     * over four columns of blanks, which is the exact failure the arrangement exists to avoid,
     * arriving at the one moment nobody has chosen anything yet.
     *
     * Read from `hasChildren`, which came with the branch, so this is what the node said rather than
     * a guess about depth: where every row of a level has children, the tree beside this is the
     * right way to read them, and the table says so instead of drawing an empty grid. Where any row
     * is a leaf, the level holds rows and is tabulated.
     */
    if (branch.hasChildren?.length === branch.ids.length && branch.hasChildren.every(Boolean))
        return <p className="tree-note muted">pick a branch on the left to list what is in it</p>

    const shown = (page + 1) * pageSize
    // A column for the label even when the resource named none: a table of ids and nothing else is
    // still a table, and it is what a resource that declared no `defaultColumns` honestly has.
    const headings = columns.length ? columns : ['id']

    return (
        <div className="branch-table-wrap">
            <table className="branch-table">
                <thead>
                    <tr>
                        {headings.map((column) => (
                            <th key={column}>{column}</th>
                        ))}
                        {actions?.length ? <th className="branch-actions-head" /> : null}
                    </tr>
                </thead>
                <tbody>
                    {branch.ids.map((id, index) => {
                        const row = branch.data[index]
                        const isBranch = branch.hasChildren?.[index] === true
                        // The object, not the placement - the same rule the tree rows follow, and
                        // for the same reason: an action against an occurrence names a position.
                        const subject = refOf(row)?.id ?? id
                        const offered = (actions ?? []).filter(
                            (action) => (action.appliesTo ?? 'leaves') === 'all' || (action.appliesTo ?? 'leaves') === (isBranch ? 'branches' : 'leaves')
                        )
                        return (
                            <tr key={id} className={selected === id ? 'on' : undefined} onClick={onPickRow ? () => onPickRow(id) : undefined}>
                                {headings.map((column) => (
                                    <td key={column}>{cell(column === 'id' ? id : field(row, column))}</td>
                                ))}
                                {actions?.length ? (
                                    <td className="branch-actions">
                                        {offered.map((action) => (
                                            <button
                                                key={action.method}
                                                className="toggle"
                                                title={`calls ${action.method}(${subject})`}
                                                // The row opens on a click; a button in it must not
                                                // also open the row behind it.
                                                onClick={(event) => {
                                                    event.stopPropagation()
                                                    onAction?.(action, subject, resource)
                                                }}
                                            >
                                                {action.label ?? action.method}
                                            </button>
                                        ))}
                                    </td>
                                ) : null}
                            </tr>
                        )
                    })}
                </tbody>
            </table>
            {branch.total !== undefined && branch.total > shown && (
                <button className="tree-more" onClick={() => setPage(page + 1)}>
                    {branch.total - shown} more
                </button>
            )}
        </div>
    )
}

export const ResourceTree = ({
    resource,
    cache,
    branchQuestion,
    period,
    pageSize = 100,
    selected,
    onSelect,
    onPickRow,
    branchesOnly,
    actions,
    onAction
}: {
    resource: DescribedResource
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize?: number
    /** The occurrence currently open, so the row it came from can say so. */
    selected?: string
    /** Absent leaves every row inert, which is right for a tree with nothing behind its rows. */
    onSelect?: (ref: Ref, occurrenceId: string) => void
    /**
     * A row was picked, by its id.
     *
     * A second prop rather than a widened `onSelect`, because that one hands over a `Ref` - a peer,
     * an instance and an object id - which is what an aspect provider's `openObject` needs and what
     * only an aspect provider can produce. A resource that merely answers `getOne` has an id and
     * nothing else, and pretending it had a reference would mean inventing two thirds of one.
     *
     * What picking *means* belongs to the host: with leaves in the tree it opens the row, and with
     * only branches drawn it chooses the branch whose children are tabulated beside it. One gesture
     * on one row, so one prop.
     */
    onPickRow?: (id: string) => void
    /**
     * Draw only the rows that have children.
     *
     * The tree as *scope* rather than as the whole thing: the branches say which set of rows is
     * being looked at, and the rows themselves are read across in a table beside it. Filtered here
     * rather than asked for, because `hasChildren` already arrived with the branch - a resource has
     * no verb for "the branches only", and inventing one would be a second question per branch.
     */
    branchesOnly?: boolean
    /** What may be done to a row of this resource, as methods the component already declares. */
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string, resource: readonly string[]) => void
}) => {
    const columns = resource.presentation?.defaultColumns ?? []
    return (
        <div className="collection">
            <div className="collection-head">
                <strong>{resource.label ?? resource.path.join('.')}</strong>
                <span className="muted"> — a branch at a time</span>
            </div>
            <BranchRows parentId={undefined} depth={0} resource={resource.path} columns={columns} cache={cache} branchQuestion={branchQuestion} period={period} pageSize={pageSize} selected={selected} onSelect={onSelect} onPickRow={onPickRow} branchesOnly={branchesOnly} actions={actions} onAction={onAction} />
        </div>
    )
}
