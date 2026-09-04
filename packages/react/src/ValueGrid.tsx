import { useEffect, useState } from 'react'
import type { RpcFilter, RpcSort } from '@source-repo/rpc'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import { columnsFor, declaredResourceAt } from './scope.js'
import { rowReadMethod } from './row-preview.js'
import { BranchTable, ResourceTree, type BranchQuestion, type RowQuestion, type ScopedQuestion } from './ResourceTree.js'
import { RecordPanel } from './RecordPanel.js'
import { ScopeSummary } from './ScopeSummary.js'
import { ObjectPanel, type ObjectAccess, type Ref, type Where } from './ObjectPanel.js'
import type { DescribedAction, DescribedComponent, TypeNode } from './types.js'

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

export const ValueGrid = ({
    component,
    types,
    scope,
    cache,
    branchQuestion,
    rowQuestion,
    objectAccess,
    period,
    preview = true,
    onPreview,
    scopedQuestion,
    manyQuestion,
    editable,
    onEdit,
    onPageSize,
    onScope,
    actionsFor,
    onAction,
    onMove,
    pageSize = 50
}: {
    component: DescribedComponent
    types?: { [name: string]: TypeNode }
    /** The selected scope node, spelled from the root: `['state', 'zones']`. */
    scope: string[]
    cache: RpcDataCache
    /** How to name one branch of a tree resource. Absent leaves such a resource undrawable. */
    branchQuestion?: BranchQuestion
    /** How to name one row of a resource, for opening it. Absent leaves rows unopenable. */
    rowQuestion?: RowQuestion
    /** How to open an object a row names, and follow its links. Absent leaves rows inert. */
    objectAccess?: ObjectAccess
    period: number | undefined
    /** Whether a picked row opens beside the table. A global preference, held by the host. */
    preview?: boolean
    onPreview?: (on: boolean) => void
    /** How to ask for every leaf beneath a branch, where a resource answers for a subtree. */
    scopedQuestion?: ScopedQuestion
    onPageSize?: (size: number) => void
    /** The branch chosen as scope. Hosts may use its provider-defined id as surrounding context. */
    onScope?: (id: string | undefined) => void
    /**
     * How to ask a resource for a set of ids at once.
     *
     * `getMany` and not fifty `getOne`s, which is the whole reason the verb exists: a page of rows
     * carrying customer ids resolves in one round trip.
     */
    manyQuestion: (resource: readonly string[], ids: readonly string[]) => RpcQuestion
    /** Whether this component's write half accepts an `update` for the resource at this path. */
    editable?: (path: readonly string[]) => boolean
    /** Open the editor for one row. Absent leaves every row read-only, which is the default. */
    onEdit?: (resource: readonly string[], id: string) => void
    /** What may be done to a row of the resource at this path, if anything. */
    actionsFor: (path: string[]) => DescribedAction[] | undefined
    onAction?: (action: DescribedAction, id: string, resource: readonly string[], label?: string) => void
    /**
     * Put a row at a position, where the resource declared `move`. Absent means no arrows.
     *
     * Supplied by the host rather than derived here, for the reason every other write is: the grid
     * names questions and draws answers, and opening a link is somebody else's job.
     */
    onMove?: (id: string, position: number, resource: readonly string[]) => void
    pageSize?: number
}) => {
    // Decided before anything else in this pane, because a tree is not a page of the same thing: it
    // has no page number, its filter belongs to a branch rather than to the collection, and the
    // question it asks names a parent. Sharing the grid's machinery would mean explaining, in both
    // directions, which half of it does not apply.
    /**
     * The resource this scope names, browsable or not.
     *
     * `treeResourceAt` used to decide this, and deciding it by *shape* is what produced three
     * renderings of one idea: a real table for an address space, stacked key-and-value blocks for a
     * SQL table, and a value list for a record. They are the same arrangement - rows with columns, a
     * page under them, a panel for the row that is picked - and the only thing a tree adds is
     * something to browse on the left.
     */
    const tree = declaredResourceAt(component, scope)
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
    /**
     * The branch being tabulated, when the values arrangement is showing. Absent is the roots.
     *
     * Its own state rather than the tree's selection, because in that arrangement the two panes ask
     * different questions: what is picked on the left decides what is *listed* on the right, and
     * what is picked on the right decides what is *opened*. Two selections, two things.
     */
    const [branch, setBranch] = useState<string | undefined>()
    /** The selected branch's own provider record, separate from the leaves it scopes. */
    const [branchSummary, setBranchSummary] = useState<{ readonly label: string; readonly value: unknown } | undefined>()

    // Offered only where the resource said it answers for one row, which is what the verb list is
    // for: a viewer offers what is served and nothing else.
    const opensWith = rowReadMethod(tree)
    const opensRows = !!tree && ((opensWith === 'getOne' && !!rowQuestion) || opensWith === 'getMany')
    /**
     * Whether this resource can be *browsed*, which is the only thing a tree adds.
     *
     * Everything else about the arrangement is the same for a table, a queue and an address space:
     * rows with columns, a page under them, and a panel for the row that is picked. Asking whether a
     * resource is a tree in order to decide how to *draw* it is what produced three renderings of
     * one idea - stacked key/value blocks for a table, a value list for a record, a real table only
     * for a tree - and this is where that stops.
     */
    const browsable = !!tree && tree.shape === 'tree' && tree.verbs.includes('getChildren') && !!branchQuestion
    /** How the rows are asked for: scoped where a subtree is served, plain where there is no depth. */
    const listable = tree?.verbs.includes('getList') ? scopedQuestion : undefined
    // Closed when the reader moves to another resource. An id belongs to the resource that handed
    // it out, so carrying it across would ask the new one about a row of the old one - which it
    // answers, correctly and uselessly, with "no longer a row with this id".
    const here = scope.join('.')
    useEffect(() => {
        setOpened(undefined)
        setBranch(undefined)
        setBranchSummary(undefined)
        setWhere(undefined)
    }, [here])
    // The resource's own judgement first, then its row type - so a table that declared no columns
    // still draws its fields rather than a lone id.
    const columns = columnsFor(tree, types)
    const representation = tree?.presentation?.representation

    // A tree is the whole pane when one is selected. There is nothing else under that scope node -
    // a resource has no typed leaves of its own - so drawing the empty grid furniture around it
    // would be a filter box and a field count for something that has neither.
    if (tree)
        return (
            <div className="value-grid">
                {browsable || listable ? (
                    <>
                        {/* One arrangement, three depths of one question: which set, which row,
                            which fields. The tree is scope and holds branches only; the table holds
                            the rows of the branch that is picked; the panel holds what a row cannot
                            - a document's text, a node's attributes and bindings.
                            
                            There were two for a while, with the leaves drawn in the tree as well,
                            and a toggle between them. It did not earn the control: a leaf in a tree
                            is a row nobody can read across, and everything the second arrangement
                            was for turned out to be this one with a different pane in focus. */}
                        {/* Above the data and to the right: it is about the panes below it rather
                            than about the component, and it belongs where a control over a table
                            belongs rather than in a header row shared with the link and the clock. */}
                        {onPreview && (
                            <div className="pane-controls">
                                <label className="preview-pick" title="show the picked row beside the table">
                                    <input type="checkbox" checked={preview} onChange={(event) => onPreview(event.target.checked)} />
                                    preview
                                </label>
                            </div>
                        )}
                        {branchSummary && <ScopeSummary label={branchSummary.label} value={branchSummary.value} />}
                        <div className="tree-and-object">
                        {/* Only where there is something to browse. A flat resource has no branches,
                            so the pane is the table and the panel - the same two of the three. */}
                        {browsable && (
                        <ResourceTree
                            resource={tree}
                            cache={cache}
                            branchQuestion={branchQuestion}
                            period={period}
                            selected={branch}
                            branchesOnly
                            // Offered only where the resource answers for a subtree, because that is
                            // what makes "everything" a question it can answer: `under` absent is
                            // every leaf beneath the root. Without it, scope is a branch's own
                            // children and there is no all of them.
                            everything={tree.verbs.includes('getList') ? `all of ${tree.label ?? tree.path.join('.')}` : undefined}
                            // The tree holds branches, so a click on one means scope: it decides
                            // which rows are tabulated beside it. Opening is what the table does.
                            onPickRow={(id: string | undefined, row?: unknown, label?: string) => {
                                // A new branch is a new set of rows, so whatever was open out of the
                                // last one is not in this one.
                                setBranch(id)
                                setBranchSummary(id !== undefined && row !== undefined ? { label: label ?? id, value: row } : undefined)
                                setOpened(undefined)
                                setWhere(undefined)
                                onScope?.(id)
                            }}
                            // The rows are on the right, and so are the buttons about them.
                            onAction={onAction}
                        />
                        )}
                        <BranchTable
                                resource={tree.path}
                                columns={columns}
                                representation={representation}
                                parentId={branch}
                                cache={cache}
                                branchQuestion={branchQuestion}
                                // Offered only where the resource says it answers for a subtree.
                                // Everything else about the table is the same either way.
                                scopedQuestion={listable}
                                period={period}
                                pageSize={pageSize}
                                onPageSize={onPageSize}
                                // Either way a row can be open: through the aspects path into the
                                // object panel, or by id into the record panel. The line says so in
                                // both cases, or a document that arrived because its folder named
                                // it would be showing with nothing to say where it came from.
                                selected={where?.occurrenceId ?? opened}
                                onSelect={
                                    objectAccess
                                        ? (ref: Ref, occurrenceId: string) => {
                                              setOpened(undefined)
                                              setWhere({ target: ref, aspectId: tree.path[0], occurrenceId, inherited: false })
                                          }
                                        : undefined
                                }
                                onPickRow={
                                    opensRows
                                        ? (id: string) => {
                                              setWhere(undefined)
                                              setOpened(id)
                                          }
                                        : undefined
                                }
                                actions={actionsFor(tree.path as string[])}
                                onAction={onAction}
                                onMove={tree.verbs.includes('move') ? onMove : undefined}
                                onEdit={editable?.(tree.path) ? onEdit : undefined}
                            />
                        {/* The row is still picked when the panel is off - it is marked, and an
                            action still knows which row it is about. What is turned off is the
                            width it takes, which is the whole reason somebody turns it off. */}
                        {preview && objectAccess && where && <ObjectPanel target={where.target} access={objectAccess} where={where} onWhere={setWhere} />}
                        {/* Prefer richer `getOne` detail; fall back to one id through `getMany` for
                            resources whose row has the same shape in a page and on its own. Both are
                            declared capabilities, so the viewer still offers only what is served. */}
                        {preview && opensRows && opened !== undefined && (
                            <RecordPanel
                                cache={cache}
                                question={opensWith === 'getOne' ? rowQuestion!(tree.path, opened) : manyQuestion(tree.path, [opened])}
                                id={opened}
                                period={period}
                                columns={columns}
                                detail={tree.presentation?.detail}
                                sections={tree.presentation?.sections}
                                onClose={() => setOpened(undefined)}
                            />
                        )}
                        </div>
                    </>
                ) : (
                    <p className="muted">this pane was given no way to ask this resource for rows</p>
                )}
            </div>
        )

    return <p className="muted">this pane was given no DataProvider resource</p>
}
