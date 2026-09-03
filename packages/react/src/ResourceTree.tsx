import { useEffect, useMemo, useRef, useState } from 'react'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import type { RpcFilter } from '@source-repo/rpc'
import { useRpcData } from './data.js'
import type { Ref } from './ObjectPanel.js'
import type { DescribedAction, DescribedResource } from './types.js'
import { pageControls } from './paging.js'
import { actionsOn } from './scope.js'
import { Pager } from './Pager.js'

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

/**
 * Every leaf beneath a branch: `getList` with `under`, where a resource answers that verb.
 *
 * A different question from a branch's children, and it has to be, because it is the one a filter
 * and an order are *about* - a set of rows rather than a level of them. The peer answers it and
 * nothing here walks anything.
 */
export type ScopedQuestion = (resource: readonly string[], under: string | undefined, page: number, pageSize: number, filter?: RpcFilter) => RpcQuestion

interface Branch {
    readonly ids: readonly string[]
    readonly data: readonly unknown[]
    readonly hasChildren?: readonly boolean[]
    /** Which rows are places rather than things. Absent means fall back to `hasChildren`. */
    readonly grouping?: readonly boolean[]
    readonly total?: number
    /** The child this branch says to open with it, if any. Advice, and checked before it is taken. */
    readonly defaultChild?: string
}

/**
 * Whether a row is scope rather than a row of data.
 *
 * The node's answer where it gave one, and `hasChildren` where it did not. Those are different
 * questions and the fallback is a guess - a right-often-enough one, and wrong in both directions:
 * an OPC UA Variable carrying `EngineeringUnits` has children and is still a measurement, and an
 * empty folder has none and is still a folder.
 */
const isScope = (branch: Branch, index: number): boolean => branch.grouping?.[index] ?? branch.hasChildren?.[index] === true

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

/**
 * What to call a row.
 *
 * The declared `representation` first, because it is the resource saying which field names a row
 * rather than this file guessing - and the guess was wrong in the direction that matters: `title`,
 * `name` and `label` are the fields an aspect happens to use, and a store-backed row that calls it
 * something else got its id drawn instead. The chain stays behind it for every resource that has
 * not declared one, which today is most of them.
 */
const labelOf = (row: unknown, id: string, columns: readonly string[], representation?: string): string => {
    for (const path of [...(representation ? [representation] : []), ...columns, 'title', 'name', 'label']) {
        const value = field(row, path)
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
    representation,
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
    /** The resource's own answer to "what is this row called", where it gave one. */
    representation?: string
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
    onAction?: (action: DescribedAction, id: string, resource: readonly string[], label?: string) => void
}) => {
    const [open, setOpen] = useState(false)
    /**
     * Whether opening this one showed anything, once it has been opened.
     *
     * A fallback now, and it should almost never fire. `hasChildren` is the flag a viewer draws an
     * expander from, so a provider drawing a tree of places reports whether there are *branch*
     * children - the ones this tree would show - and both providers here do. An arrow that opens
     * onto nothing is then not drawn in the first place, which is the right answer: a tree that
     * withdraws an arrow after somebody presses it is worse than one that never offered.
     *
     * This stays for a provider whose `hasChildren` means "has any children", which is a reasonable
     * reading of the name. Without it such a tree would keep a dead arrow forever; with it the arrow
     * goes after one click, which is the lesser of the two.
     */
    const [barren, setBarren] = useState(false)
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
    const offered = actionsOn(actions, { branch: expandable, kind: field(row, 'kind') })
    const label = labelOf(row, id, columns, representation)
    const details = detailsOf(row, columns, label)

    return (
        <>
            <div className={`tree-row${selected === id ? ' on' : ''}`} style={{ paddingLeft: `${depth * 1.1}rem` }}>
                {expandable && !barren ? (
                    <button className="tree-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'collapse' : 'expand'}>
                        {open ? '▾' : '▸'}
                    </button>
                ) : (
                    <span className="tree-toggle tree-leaf" />
                )}
                {/* What a click means depends on what the tree is *for*, and there are two cases.
                    
                    With the leaves drawn, it opens the row: an aspect reference goes to the object
                    panel with its content and links, a bare id to the record panel. Same gesture
                    either way, so the same button.
                    
                    With only branches drawn the tree is scope, and a click chooses which branch is
                    tabulated beside it. That has to win over opening, and it did not: every row an
                    aspect provider hands out carries a reference, so the object panel took every
                    click and the table stayed on the roots however far somebody drilled. A plain
                    component's rows have no reference, which is why it looked right there and was
                    broken everywhere else. */}
                {branchesOnly && onPickRow ? (
                    <button className={`tree-label tree-openable${selected === id ? ' tree-selected' : ''}`} onClick={() => onPickRow(id)} title={id}>
                        {label}
                    </button>
                ) : ref && onSelect ? (
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
                {/* Columns beside a branch, only where the tree is drawing the rows themselves.
                    As scope it draws places, and what kind of place `Line1` is - `nodeClass Object`
                    on every row, forever - is noise beside the one thing a reader is choosing.
                    Everything about a row is in the list, which is where a row is. */}
                {!branchesOnly &&
                    details.map(([column, value]) => (
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
                            <button key={action.method} className="toggle" title={`calls ${action.method}(${subject})`} onClick={() => onAction?.(action, subject, resource, label)}>
                                {action.label ?? action.method}
                            </button>
                        ))}
                    </span>
                ) : null}
            </div>
            {/* Mounted only while open, so a closed branch is not merely hidden - it is not asked
                for, and the watch that would keep it current is not open either. */}
            {open && !barren && (
                <BranchRows
                    onDrew={(any) => {
                        if (!any) {
                            setBarren(true)
                            setOpen(false)
                        }
                    }}
                    parentId={id}
                    depth={depth + 1}
                    resource={resource}
                    columns={columns}
                    representation={representation}
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
    representation,
    cache,
    branchQuestion,
    period,
    pageSize,
    selected,
    onSelect,
    onPickRow,
    branchesOnly,
    actions,
    onAction,
    onDrew
}: {
    parentId: string | undefined
    depth: number
    resource: readonly string[]
    columns: readonly string[]
    /** The resource's own answer to "what is this row called", where it gave one. */
    representation?: string
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
    onAction?: (action: DescribedAction, id: string, resource: readonly string[], label?: string) => void
    /** Whether this drew any rows, so a parent can stop offering to open what opens onto nothing. */
    onDrew?: (any: boolean) => void
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
    const drawn = branch.ids.map((id, index) => [id, index] as const).filter(([, index]) => !branchesOnly || isScope(branch, index))
    if (branchesOnly && !drawn.length) {
        onDrew?.(false)
        return null
    }
    return (
        <>
            {drawn.map(([id, index]) => (
                <Node
                    key={id}
                    id={id}
                    row={branch.data[index]}
                    depth={depth}
                    representation={representation}
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
    representation,
    parentId,
    cache,
    branchQuestion,
    scopedQuestion,
    period,
    pageSize = 100,
    onPageSize,
    selected,
    onSelect,
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
    /**
     * How to ask for every leaf beneath the branch, where the resource answers for a subtree.
     *
     * Absent falls back to the branch's own children - a smaller screen and not a broken one: a
     * reader scopes level by level instead of by subtree, and everything else is the same.
     */
    scopedQuestion?: ScopedQuestion
    /** The resource's own answer to "what is this row called", where it gave one. */
    representation?: string
    period: number | undefined
    pageSize?: number
    /** Absent leaves the size fixed, which is right where the host decides it. */
    onPageSize?: (size: number) => void
    selected?: string
    /**
     * Open a row. The same two paths the tree has, and for the same reason.
     *
     * A row an aspect provider handed out carries a reference and opens through `openObject`; a row
     * from a plain resource has an id and opens through `getOne`. A table whose rows could only be
     * opened the second way left every aspect provider's rows inert - which is most of them.
     */
    onSelect?: (ref: Ref, id: string) => void
    onPickRow?: (id: string) => void
    actions?: DescribedAction[]
    onAction?: (action: DescribedAction, id: string, resource: readonly string[], label?: string) => void
}) => {
    const [page, setPage] = useState(0)
    /**
     * The one kind of thing being listed, where the reader has picked one.
     *
     * Asked of the peer rather than sifted here, which is the rule the whole scoped list follows:
     * a page of fifty Variables is fifty Variables, and filtering what arrived would give a page of
     * fifty *rows* of which some are Variables, with a pager counting the wrong set.
     */
    const [kind, setKind] = useState<string | undefined>()
    const filter = useMemo(() => (kind ? ({ field: 'kind', op: 'eq', operand: kind } as RpcFilter) : undefined), [kind])
    // A subtree where the resource answers for one, a level where it does not. Only the first can
    // be narrowed: a level is a level, and there is nowhere to push a filter to.
    const question = useMemo(
        () => (scopedQuestion ? scopedQuestion(resource, parentId, page, pageSize, filter) : branchQuestion(resource, parentId, page, pageSize)),
        [scopedQuestion, branchQuestion, resource, parentId, page, pageSize, filter]
    )
    const { data, error, fetching } = useRpcData(cache, question, period)
    const branch = data as Branch | undefined
    // Back to the first page when the branch changes: page four of one branch is not page four of
    // the next, and staying put would land somebody past the end of a list they never scrolled.
    useEffect(() => setPage(0), [parentId, scopedQuestion, filter])
    // A branch is a different set of things, so which kinds are in it is a different question.
    useEffect(() => setKind(undefined), [parentId])

    /**
     * Open one on arrival: what the branch named, or failing that the first row.
     *
     * Two reasons, and the second is the one that decided it. A folder of documentation whose first
     * business is its `README` is what `defaultChild` is for, and the node is what knows that - the
     * console has no idea which of a hundred filing conventions it is looking at. Where a branch
     * names nothing, the first row is still better than an empty panel beside a full table: it puts
     * something in the third pane, and it shows a reader that a row is a thing you can pick, which
     * a table of unmarked rows does not say anywhere.
     *
     * Only into an empty seat, and only once per branch. Arriving somewhere and having the document
     * you were reading replaced is worse than one more click, and a suggestion re-applied on every
     * refresh would drag a reader back to the top of a list they had moved down.
     *
     * And only for an id this branch actually answered with, because `defaultChild` arrived from a
     * peer and advice from a peer is input.
     */
    /**
     * The rows this table lists: the things, never the places.
     *
     * A branch belongs in the tree, where picking it decides what is listed here. Drawing it here as
     * well would put the same node in two panes meaning two different things, and would mix a row
     * that has columns with one that has none of them.
     *
     * Computed before the early returns below rather than after, because hooks run either way: with
     * this after them, the panel opened the first *branch* while the table beside it was saying to
     * pick one.
     */
    const listed = branch ? branch.ids.map((id, index) => [id, index] as const).filter(([, index]) => !isScope(branch, index)) : []

    /**
     * What kinds this branch holds, tallied from the last answer that was not already narrowed.
     *
     * Held rather than derived from whatever is on screen, because once a kind is picked the page
     * is all of that kind and can no longer say what else was there - and a set of chips that
     * collapsed to the one you chose would take away the way back to the others.
     */
    const [seen, setSeen] = useState<[string, number][]>([])
    useEffect(() => {
        if (filter || !branch) return
        const tally = new Map<string, number>()
        for (const [, index] of listed) {
            const named = field(branch.data[index], 'kind')
            if (typeof named === 'string' && named) tally.set(named, (tally.get(named) ?? 0) + 1)
        }
        const next = [...tally.entries()].sort(([a], [b]) => a.localeCompare(b))
        setSeen((held) => (JSON.stringify(held) === JSON.stringify(next) ? held : next))
    }, [branch, filter, listed])
    const suggested = branch && listed.length ? (listed.some(([id]) => id === branch.defaultChild) ? branch.defaultChild : listed[0][0]) : undefined
    const opening = `${parentId ?? ''}\u0000${suggested ?? ''}`
    const taken = useRef<string | undefined>(undefined)
    useEffect(() => {
        // Not while the next branch is on its way. For a moment after a branch is picked, `parentId`
        // is the new one and `branch` is still the old one's rows - and opening the first of those
        // under the new key reopened the row somebody had just navigated away from, into a panel
        // beside a table that was saying to pick a branch.
        if (fetching || !branch || !suggested || selected !== undefined || taken.current === opening) return
        const at = branch.ids.indexOf(suggested)
        if (at < 0) return
        taken.current = opening
        const reference = refOf(branch.data[at])
        if (reference && onSelect) onSelect(reference, suggested)
        else if (onPickRow) onPickRow(suggested)
    }, [fetching, branch, suggested, opening, selected, onSelect, onPickRow])

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
    // Nothing here is a thing to list - it is all scope, and the tree beside this is how it is read.
    if (!listed.length) return <p className="tree-note muted">pick a branch on the left to list what is in it</p>

    const controls = pageControls(page, pageSize, branch, filter !== undefined)
    // A column for the label even when the resource named none: a table of ids and nothing else is
    // still a table, and it is what a resource that declared no `defaultColumns` honestly has.
    const headings = columns.length ? columns : ['id']

    return (
        <div className="branch-table-wrap">
            {/* Which kinds of thing are in here, where there is more than one.
             *
             * An address space lists Variables beside Methods and both are leaves; a reader looking
             * for a reading does not want the fourteen methods in the way. The kinds come from the
             * rows that arrived and the counts are counts *of this page* - said in the label,
             * because a number next to a name reads as how many there are, and the peer has not
             * been asked that. Picking one asks the peer for that kind, so the page that comes back
             * is a full page of them rather than what was left after sifting. */}
            {(seen.length > 1 || kind) && (
                <div className="kind-chips">
                    <button className={kind === undefined ? 'toggle on' : 'toggle'} onClick={() => setKind(undefined)}>
                        all
                    </button>
                    {seen.map(([name, count]) => (
                        <button key={name} className={kind === name ? 'toggle on' : 'toggle'} onClick={() => setKind(kind === name ? undefined : name)} title={name}>
                            {name.split('.').pop()}
                            {/* Only while nothing is picked. The tally is of the page that arrived,
                                and once a kind is asked for the peer answers with all of them - so
                                `method 3` beside fourteen rows of methods would be a number
                                contradicting the list under it. After picking, the pager is the
                                one that can count, and it does. */}
                            {!kind && <span className="muted"> {count}</span>}
                        </button>
                    ))}
                    {!kind && <span className="muted">on this page</span>}
                </div>
            )}
            {/* The rows scroll inside this, and the pager below stays put. One element rather than
                none, because a pager that scrolls away with a hundred rows is a pager somebody has
                to reach the bottom of the page to press - which is the position they were using it
                to leave. */}
            <div className="branch-table-scroll">
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
                        {listed.map(([id, index]) => {
                            const row = branch.data[index]
                            // The object, not the placement - the same rule the tree rows follow, and
                            // for the same reason: an action against an occurrence names a position.
                            const reference = refOf(row)
                            const subject = reference?.id ?? id
                            // Everything here is a leaf by construction now, so an action for branches
                            // has nothing in this table to be about - it belongs on a tree row.
                            const offered = actionsOn(actions, { branch: false, kind: field(row, 'kind') })
                            return (
                                <tr
                                    key={id}
                                    className={selected === id ? 'on' : undefined}
                                    onClick={
                                        reference && onSelect ? () => onSelect(reference, id) : onPickRow ? () => onPickRow(id) : undefined
                                    }
                                >
                                    {headings.map((column) => {
                                        const shown = cell(column === 'id' ? id : field(row, column))
                                        // The whole value on the cell, because the column shows as much
                                        // of it as fits and a reader should not have to open a row to
                                        // find out what was cut.
                                        return (
                                            <td key={column} title={shown}>
                                                {shown}
                                            </td>
                                        )
                                    })}
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
                                                        onAction?.(action, subject, resource, labelOf(row, id, columns, representation))
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
            </div>
            {/* A pager rather than a "more" button, because this list has a size, a place in a set
                and sometimes a count of pages - and where the peer could not afford a count it says
                so by leaving the denominator off rather than by having no pager. */}
            <div className="table-pager">
                <Pager page={page} pageSize={pageSize} controls={controls} onPage={setPage} onPageSize={onPageSize} />
            </div>
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
    everything,
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
    onPickRow?: (id: string | undefined) => void
    /**
     * What to call the row that means *everything*, where the host offers one.
     *
     * Its presence is the signal, because only the host knows whether scope means a subtree: a
     * resource that answers `getList` can be asked for every leaf beneath the root, and one that
     * cannot has no such thing as all of them.
     */
    everything?: string
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
    onAction?: (action: DescribedAction, id: string, resource: readonly string[], label?: string) => void
}) => {
    const columns = resource.presentation?.defaultColumns ?? []
    const representation = resource.presentation?.representation
    return (
        <div className="collection">
            <div className="collection-head">
                <strong>{resource.label ?? resource.path.join('.')}</strong>
                <span className="muted"> — a branch at a time</span>
            </div>
            {/*
             * Everything, as a row above the branches.
             *
             * The scoped list has always been able to answer it - `under` absent means every leaf
             * beneath the root, and that is what the resource is asked when nothing is picked - but
             * there was no way to *say* it. A reader could scope to `Line1` or to `Server` and never
             * back out to the whole address space without reloading the page, which made the widest
             * question the one question the tree could not ask.
             *
             * It matters more the more there is to do with a scope. A filter, a kind chip and a page
             * of a hundred rows are all worth pointing at everything, and each of them arrived after
             * the tree had settled into "pick one of these".
             *
             * Only where the resource answers for a subtree: without that, scope means a branch's own
             * children and there is no such thing as all of them.
             */}
            {onPickRow && everything && (
                <div className={`tree-row${selected === undefined ? ' on' : ''}`}>
                    <button className="tree-label tree-openable" onClick={() => onPickRow(undefined)} title="every row this resource has, from the top">
                        {everything}
                    </button>
                </div>
            )}
            <BranchRows parentId={undefined} depth={0} resource={resource.path} columns={columns} representation={representation} cache={cache} branchQuestion={branchQuestion} period={period} pageSize={pageSize} selected={selected} onSelect={onSelect} onPickRow={onPickRow} branchesOnly={branchesOnly} actions={actions} onAction={onAction} />
        </div>
    )
}
