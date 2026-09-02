import { useMemo } from 'react'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import { useRpcData } from './data'
import type { DescribedResource } from './types'

/**
 * What the ids in a page of rows actually refer to.
 *
 * A row holding `customer_id: 38271` is a row nobody can read. The resource says that column is a
 * `customers`, the target resource says a customer is named by its `representation`, and between
 * the two a viewer can draw `Acme Ltd` - which is the entire point of declaring a reference, and is
 * information no viewer could have worked out for itself.
 *
 * ## One question per reference, never one per row
 *
 * `getMany` exists precisely so that fifty rows carrying a customer id are one round trip. That is
 * the reason the resolution happens here, over a whole page, rather than in the cell that draws it:
 * a hook per cell would be fifty questions and would arrive fifty times, which is the fan-out the
 * verb was added to avoid. The ids are deduplicated and sorted before they become a question, so a
 * page whose fifty rows name three customers asks for three - and so that two pages naming the same
 * three ask the *same* question and the second is answered from cache rather than from the peer.
 *
 * ## What it does not do
 *
 * It does not fetch what it cannot use. A reference whose target this component does not serve was
 * already reported at describe time and is skipped here; a target that declares no `representation`
 * is skipped too, because the only thing to draw would be the id that is already on screen.
 */

export interface ResolvedReference {
    /** The field of the row that holds the id. */
    readonly field: string
    /** The resource the id names, for a viewer that offers to open it. */
    readonly target: readonly string[]
    /** What each id is called, by id. Absent for an id the target did not answer for. */
    readonly named: ReadonlyMap<string, string>
}

/** The ids one reference's field holds across a page, deduplicated and in a stable order. */
const idsIn = (rows: readonly unknown[], field: string): string[] => {
    const found = new Set<string>()
    for (const row of rows) {
        const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[field] : undefined
        // Numbers are ids too - a SQL key usually is one - and the wire carries whatever the store
        // holds. Anything else is not an id and is left as it is rather than stringified into one.
        if (typeof value === 'string' && value) found.add(value)
        else if (typeof value === 'number') found.add(String(value))
    }
    return [...found].sort()
}

const nameOf = (row: unknown, representation?: string): string | undefined => {
    if (!representation || !row || typeof row !== 'object') return undefined
    const value = (row as Record<string, unknown>)[representation]
    return typeof value === 'string' && value ? value : undefined
}

/**
 * One reference of one page, resolved.
 *
 * A hook per reference rather than a loop inside one, because hooks cannot be called in a loop whose
 * length changes - and the number of references a resource declares is a property of the resource,
 * which changes when a reader moves between them. The caller therefore renders one of these per
 * declared reference, which React can see.
 */
export const useReference = (
    cache: RpcDataCache,
    rows: readonly unknown[],
    reference: { field: string; target: readonly string[] },
    target: DescribedResource | undefined,
    manyQuestion: (resource: readonly string[], ids: readonly string[]) => RpcQuestion,
    period: number | undefined
): ResolvedReference | undefined => {
    const representation = target?.presentation?.representation
    const ids = useMemo(() => (representation ? idsIn(rows, reference.field) : []), [rows, reference.field, representation])
    // A question is asked whatever happens, because a hook cannot be skipped - so an empty set asks
    // for nothing, which the cache answers without a round trip.
    const question = useMemo(() => manyQuestion(reference.target, ids), [manyQuestion, reference.target, ids])
    const { data } = useRpcData(cache, question, ids.length ? period : undefined)

    return useMemo(() => {
        if (!representation || !ids.length) return undefined
        const answer = data as { ids?: readonly string[]; data?: readonly unknown[] } | undefined
        const named = new Map<string, string>()
        answer?.ids?.forEach((id, at) => {
            const name = nameOf(answer.data?.[at], representation)
            if (name) named.set(String(id), name)
        })
        return { field: reference.field, target: reference.target, named }
    }, [data, representation, ids, reference.field, reference.target])
}

/**
 * What one row refers to, named, drawn beside it.
 *
 * A component per reference rather than a loop inside one, for the reason `useReference` gives: a
 * hook cannot be called in a loop whose length varies, and how many references a resource declares
 * varies as a reader moves between resources. One component each makes the change a remount, which
 * React can see.
 *
 * Every instance asks the *page's* question - all of the ids, not this row's - so fifty rows are one
 * request rather than fifty. They are identical questions, and the cache answers identical
 * questions once; asking per row would be the fan-out `getMany` exists to prevent.
 */
export const RowReference = ({
    cache,
    rows,
    row,
    reference,
    target,
    manyQuestion,
    period
}: {
    cache: RpcDataCache
    /** The whole page, because that is what makes this one question instead of one per row. */
    rows: readonly unknown[]
    row: unknown
    reference: { field: string; target: readonly string[] }
    target: DescribedResource | undefined
    manyQuestion: (resource: readonly string[], ids: readonly string[]) => RpcQuestion
    period: number | undefined
}) => {
    const resolved = useReference(cache, rows, reference, target, manyQuestion, period)
    const held = row && typeof row === 'object' ? (row as Record<string, unknown>)[reference.field] : undefined
    const id = typeof held === 'string' || typeof held === 'number' ? String(held) : undefined
    const name = id === undefined ? undefined : resolved?.named.get(id)
    // Nothing where the id names nothing: a row whose reference is null, or one the target did not
    // answer for. The id itself is already on the row, so there is nothing to add by repeating it.
    if (!name) return null
    return (
        <span className="row-reference" title={`${reference.field} = ${id} in ${reference.target.join('.')}`}>
            <span className="muted">{target?.label ?? reference.target.join('.')}</span> {name}
        </span>
    )
}
