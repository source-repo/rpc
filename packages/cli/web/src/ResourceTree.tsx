import { useMemo, useState } from 'react'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import { useRpcData } from './data'
import type { DescribedResource } from './types'

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

interface Branch {
    readonly ids: readonly string[]
    readonly data: readonly unknown[]
    readonly hasChildren?: readonly boolean[]
    readonly total?: number
}

const field = (row: unknown, name: string): unknown => (row && typeof row === 'object' ? (row as Record<string, unknown>)[name] : undefined)

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
    pageSize
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
}) => {
    const [open, setOpen] = useState(false)
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
                <span className="tree-label" title={id}>
                    {label}
                </span>
                {details.map(([column, value]) => (
                    <span className="tree-detail" key={column}>
                        <span className="muted">{column}</span> {value}
                    </span>
                ))}
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
    pageSize
}: {
    parentId: string | undefined
    depth: number
    resource: readonly string[]
    columns: readonly string[]
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize: number
}) => {
    const [page, setPage] = useState(0)
    const question = useMemo(() => branchQuestion(resource, parentId, page, pageSize), [branchQuestion, resource, parentId, page, pageSize])
    const { data, error, fetching } = useRpcData(cache, question, period)
    const branch = data as Branch | undefined

    if (error) return <p className="tree-note error" style={{ paddingLeft: `${depth * 1.1}rem` }}>{String(error)}</p>
    if (!branch) return fetching ? <p className="tree-note muted" style={{ paddingLeft: `${depth * 1.1}rem` }}>reading…</p> : null
    if (!branch.ids.length) return <p className="tree-note muted" style={{ paddingLeft: `${depth * 1.1}rem` }}>nothing here</p>

    const shown = (page + 1) * pageSize
    return (
        <>
            {branch.ids.map((id, index) => (
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

export const ResourceTree = ({
    resource,
    cache,
    branchQuestion,
    period,
    pageSize = 100
}: {
    resource: DescribedResource
    cache: RpcDataCache
    branchQuestion: BranchQuestion
    period: number | undefined
    pageSize?: number
}) => {
    const columns = resource.presentation?.defaultColumns ?? []
    return (
        <div className="collection">
            <div className="collection-head">
                <strong>{resource.label ?? resource.path.join('.')}</strong>
                <span className="muted"> — a branch at a time</span>
            </div>
            <BranchRows parentId={undefined} depth={0} resource={resource.path} columns={columns} cache={cache} branchQuestion={branchQuestion} period={period} pageSize={pageSize} />
        </div>
    )
}
