import { componentSnapshot, projectionKeyOrder, type RpcComponentData } from './Component.js'

/**
 * Paging and filtering a collection by *asking*, rather than by subscribing to it.
 *
 * A component whose state carries three hundred tags cannot be browsed through the snapshot: the
 * whole thing is eighty seconds at 1200 baud, and a screen showing fifty rows should cost fifty
 * rows. The projection answers half of that - name the paths, receive those - and stops where the
 * question turns into "which fifty?", because **a record's keys are data, not type**, so a caller
 * cannot name them without first receiving everything.
 *
 * The shape this takes is react-admin's **DataProvider**, deliberately and not by coincidence. It
 * is the interface several hundred backends already implement, so a component that serves it can be
 * browsed by anything that speaks it, and the parts not built here - reference fields resolving ids
 * to values, one-to-many under a record, drop-downs filled from a related resource - arrive as the
 * same verbs pointed at a second resource rather than as features to be designed.
 *
 * **Pull, not push, and that is the decision the rest follows from.** A projection is re-applied per
 * subscriber on every publish, so a predicate living there would make every commit a query on a peer
 * that may be a small computer running a process; and a filtered, paged set is unstable under push,
 * because matches depend on values and values change - one tag going bad-quality enters the match
 * and silently renumbers every row beneath it. A request is answered once, when somebody asks, with
 * a deadline and an `authorize()` check on it. Values stay current because the caller asks again, on
 * a period it chooses - which is also the only rate control a subscriber has on a slow link, since a
 * subscription's rate belongs to the component.
 *
 * What is here is the first cut: `getList` over a record in a component's own state, served from the
 * contract without the author writing anything. `getOne`, `getMany` and the relational verbs come
 * next, and a component that has its own store - a database, a document collection, a queue - serves
 * them itself instead.
 */

/** What a caller may ask for. Only `getList` is served today; the rest are named so a refusal can say so. */
export type RpcDataMethod = 'getList' | 'getOne' | 'getMany' | 'getManyReference'

const served: readonly RpcDataMethod[] = ['getList']

/**
 * What a condition may do. A closed set, and deliberately not an expression.
 *
 * This is evaluated on the peer that holds the data, which may be a small computer with a process
 * attached to it, and it is evaluated again every time somebody asks. A predicate language with an
 * evaluator in it - a regular expression most obviously - hands whoever can reach the console a way
 * to spend that machine's time. The old provider this design came from compiled an operator's search
 * box straight into `new RegExp`, which is safe in a browser against an in-memory store and is a
 * stall on a plant server. So the wire carries facts about a comparison and nothing that runs.
 */
export type RpcFilterOp = 'startsWith' | 'contains' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

const OPS: readonly RpcFilterOp[] = ['startsWith', 'contains', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte']

export interface RpcFilterCondition {
    /**
     * What to compare. `id` is the row's key; a dot path names a field inside the row; absent means
     * the row itself, which is the only thing there is to compare in a record of numbers.
     */
    readonly field?: string
    readonly op: RpcFilterOp
    readonly operand: string | number | boolean | null
}

/** A condition, or all of these, or any of these. Closed, so it can be checked rather than trusted. */
export type RpcFilter = RpcFilterCondition | { readonly all: readonly RpcFilter[] } | { readonly any: readonly RpcFilter[] }

/**
 * Bounds on the shape rather than on the cost, which is the only thing checkable before running it.
 * Deep nesting and a thousand conditions are both a caller holding it wrong, and both are cheaper to
 * refuse than to serve.
 */
const MAX_FILTER_DEPTH = 8
const MAX_FILTER_NODES = 64

export interface RpcSort {
    /** The same naming as a filter's `field`. Absent sorts by id, which is the order keys already have. */
    readonly field?: string
    readonly order?: 'ASC' | 'DESC'
}

export interface RpcGetListParams {
    /**
     * Zero-based, so `page * pageSize` needs no adjustment anywhere. Absent means the whole
     * collection, which is the right default for a small one and is what a caller with no pager
     * means; the console always sends it.
     */
    readonly pagination?: { readonly page?: number; readonly pageSize?: number }
    /**
     * Applied before the page is cut, which is the entire point: **a filter matching nothing
     * transfers nothing.** No amount of client-side filtering can have that property, because
     * finding out that nothing matched is exactly what it has to receive everything to discover.
     */
    readonly filter?: RpcFilter
    /** Applied to the filtered set, before paging - an order over the page alone would mean nothing. */
    readonly sort?: RpcSort
}

export interface RpcGetListResult {
    /** The rows of this page, in key order. */
    readonly data: readonly unknown[]
    /**
     * The id of each row, positionally. Carried beside the rows rather than merged into them,
     * because a row may be a primitive - a record of numbers is a perfectly good resource - and
     * because a row that already had an `id` field would otherwise be quietly overwritten.
     */
    readonly ids: readonly string[]
    /**
     * How many rows **match**, which with no filter is how many the resource holds. That is what a
     * pager needs and what "3 of 47" means: the count of the set this page was cut from, not the
     * size of the collection behind it.
     *
     * Reported because it is the only thing a caller cannot work out for itself, and optional in the
     * interface because `COUNT(*)` over a filtered table is not free - a record held in memory can
     * always afford it, so it is always present here.
     */
    readonly total: number
    /** Which epoch and revision this page was drawn from, so a caller can tell a restart from an update. */
    readonly epoch: string
    readonly revision: number
}

/**
 * Where a resource lives: a path from `props` or `state`, spelled as every other path here is.
 *
 * A component's own state is addressed the way `sets` and a projection address it, so nothing new
 * has to be learned to name one. A component serving an external store publishes resource names
 * instead, and those arrive here as a single-segment path.
 */
export type RpcResource = readonly string[]

/**
 * Check the request before it is served, refusing rather than clamping.
 *
 * A negative or fractional page is a caller holding it wrong, and quietly reading it as zero
 * produces a page nobody asked for with no way to notice - the same judgement the projection slice
 * makes about its bounds, and for the same reason.
 *
 * A `pageSize` of zero is deliberately **allowed**: it asks for no rows and answers the total, which
 * is how a caller learns the number of pages before deciding to fetch any. That costs one number
 * rather than a record, and it is worth having as a stated feature rather than as something that
 * happens to fall out of the arithmetic.
 */
export const readDataRequest = (method: unknown, resource: unknown, params: unknown): Error | { method: RpcDataMethod; resource: RpcResource; params: RpcGetListParams } => {
    if (typeof method !== 'string' || !served.includes(method as RpcDataMethod))
        return new Error(`$data: ${String(method)} is not served here - this component answers ${served.join(', ')}`)
    if (!Array.isArray(resource) || !resource.length || !resource.every((segment) => typeof segment === 'string'))
        return new Error('$data: a resource is a non-empty path of string segments, such as ["state","tags"]')
    const given = (params ?? {}) as RpcGetListParams
    if (typeof given !== 'object') return new Error('$data: params is an object, or absent')
    const pagination = given.pagination
    if (pagination !== undefined) {
        if (typeof pagination !== 'object' || pagination === null) return new Error('$data: pagination is { page, pageSize }')
        for (const [name, value] of [
            ['page', pagination.page],
            ['pageSize', pagination.pageSize]
        ] as const)
            if (value !== undefined && (!Number.isInteger(value) || value < 0)) return new Error(`$data: pagination.${name} must be a non-negative integer, not ${String(value)}`)
        // A page number means nothing without a page to measure it in, and answering the whole
        // collection to something that asked for page 2 is the failure this exists to prevent.
        if (pagination.page !== undefined && pagination.pageSize === undefined) return new Error('$data: pagination.page needs a pageSize - a page number alone does not say how big a page is')
    }
    if (given.filter !== undefined) {
        const bad = readFilter(given.filter, 1, { nodes: 0 })
        if (bad) return bad
    }
    if (given.sort !== undefined) {
        const sort = given.sort
        if (typeof sort !== 'object' || sort === null) return new Error('$data: sort is { field, order }')
        if (sort.field !== undefined && (typeof sort.field !== 'string' || !sort.field)) return new Error('$data: sort.field is a non-empty string, or absent for the id')
        if (sort.order !== undefined && sort.order !== 'ASC' && sort.order !== 'DESC') return new Error(`$data: sort.order is ASC or DESC, not ${String(sort.order)}`)
    }
    return { method: method as RpcDataMethod, resource: resource as RpcResource, params: given }
}

/**
 * Check a filter, all the way down, before any of it runs.
 *
 * Checked rather than coerced, for the same reason the bounds are: an operand that arrived as an
 * object is a caller that built its query wrongly, and quietly comparing it to everything and
 * matching nothing looks exactly like a filter that worked and found no rows.
 */
const readFilter = (filter: unknown, depth: number, count: { nodes: number }): Error | undefined => {
    if (depth > MAX_FILTER_DEPTH) return new Error(`$data: a filter nested deeper than ${MAX_FILTER_DEPTH} is refused`)
    if (++count.nodes > MAX_FILTER_NODES) return new Error(`$data: a filter of more than ${MAX_FILTER_NODES} conditions is refused`)
    if (typeof filter !== 'object' || filter === null) return new Error('$data: a filter is a condition, or { all: [...] }, or { any: [...] }')
    const group = filter as { all?: unknown; any?: unknown }
    for (const key of ['all', 'any'] as const) {
        if (group[key] === undefined) continue
        if (!Array.isArray(group[key]) || !group[key].length) return new Error(`$data: ${key} is a non-empty array of filters`)
        for (const inner of group[key] as unknown[]) {
            const bad = readFilter(inner, depth + 1, count)
            if (bad) return bad
        }
        return undefined
    }
    const condition = filter as RpcFilterCondition
    if (!OPS.includes(condition.op)) return new Error(`$data: ${String(condition.op)} is not a comparison - one of ${OPS.join(', ')}`)
    if (condition.field !== undefined && (typeof condition.field !== 'string' || !condition.field))
        return new Error('$data: a condition field is a non-empty string, or absent to compare the row itself')
    const operand = condition.operand
    if (operand !== null && typeof operand !== 'string' && typeof operand !== 'number' && typeof operand !== 'boolean')
        return new Error('$data: an operand is a string, number, boolean or null')
    return undefined
}

/** Walk to whatever a path names, or undefined where it reaches nothing. */
const resolvePath = (from: RpcComponentData, path: readonly string[]): unknown => {
    let at: unknown = from
    for (const step of path) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as { [key: string]: unknown })[step]
    }
    return at
}

/**
 * The collection a resource names, or nothing.
 *
 * A path reaching something that is not a plain object answers an **empty list** rather than an
 * error, which follows the rule the projection already set: state is data, and a record a caller
 * expects may simply not have been populated yet. Refusing the request because a collection is
 * currently absent would make this less robust than the whole snapshot it replaces. A caller that
 * named the wrong path sees `total: 0`, which reads as an empty table rather than as data lost.
 */
const collectionAt = (snapshot: { props: RpcComponentData; state: RpcComponentData }, resource: RpcResource): RpcComponentData | undefined => {
    const [root, ...rest] = resource
    const from = root === 'props' ? snapshot.props : root === 'state' ? snapshot.state : undefined
    if (!from) return undefined
    const at = resolvePath(from, rest)
    return at !== null && typeof at === 'object' && !Array.isArray(at) ? (at as RpcComponentData) : undefined
}

/**
 * What a condition compares: the key, a field inside the row, or the row itself.
 *
 * A record of numbers has no fields at all, and filtering one is a perfectly ordinary thing to want,
 * so an absent `field` compares the row - which is the only reading that makes sense and the only
 * one that leaves such a collection filterable.
 */
const fieldOf = (row: unknown, id: string, field?: string): unknown => {
    if (field === undefined) return row
    if (field === 'id') return id
    let at: unknown = row
    for (const step of field.split('.')) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as { [key: string]: unknown })[step]
    }
    return at
}

/**
 * Whether one value satisfies one condition.
 *
 * A field that is not there never matches, rather than matching as `undefined` - "quality contains
 * bad" must not be true of a row that has no quality, and stringifying an absent value would make
 * `contains: 'undef'` find every one of them. `ne` is the deliberate exception: a row that lacks the
 * field is genuinely not equal to what was named, and an operator asking for "not bad" means to see
 * the rows that never reported a quality at all.
 *
 * Ordered comparisons need both sides to be the same kind of thing. Numbers compare numerically and
 * strings lexicographically; anything else answers false rather than inventing an order, because
 * `20 > '9'` having an answer at all is how a threshold silently stops working.
 */
const satisfies = (value: unknown, { op, operand }: RpcFilterCondition): boolean => {
    if (op === 'ne') return value !== operand
    if (value === undefined) return false
    switch (op) {
        case 'eq':
            return value === operand
        case 'startsWith':
        case 'contains': {
            const text = typeof value === 'string' ? value : String(value)
            const needle = String(operand)
            return op === 'startsWith' ? text.startsWith(needle) : text.includes(needle)
        }
        default: {
            const comparable = (typeof value === 'number' && typeof operand === 'number') || (typeof value === 'string' && typeof operand === 'string')
            if (!comparable) return false
            const order = value < operand ? -1 : value > operand ? 1 : 0
            return op === 'lt' ? order < 0 : op === 'lte' ? order <= 0 : op === 'gt' ? order > 0 : order >= 0
        }
    }
}

/**
 * Whether one row satisfies a filter.
 *
 * Exported because a caller may hold part of a set already and have no reason to ask for it. The
 * console is the case: a component's typed leaves are bounded by the contract, so it subscribes to
 * them and filters them here, while the record beside them is paged and filtered on the peer. Those
 * are one search box to whoever is reading the screen, and a search that meant two different things
 * either side of the same pane would be worse than no search at all - so both ends call this rather
 * than each having a version of it.
 */
export const matchesFilter = (filter: RpcFilter, row: unknown, id: string): boolean => {
    const group = filter as { all?: readonly RpcFilter[]; any?: readonly RpcFilter[] }
    if (group.all) return group.all.every((inner) => matchesFilter(inner, row, id))
    if (group.any) return group.any.some((inner) => matchesFilter(inner, row, id))
    const condition = filter as RpcFilterCondition
    return satisfies(fieldOf(row, id, condition.field), condition)
}

/** Undefined sorts last in both directions: "no reading" is not the smallest reading. */
const compare = (a: unknown, b: unknown): number => {
    if (a === b) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * One page of a collection, with the count that tells a caller how many matched.
 *
 * **Filter, then order, then cut the page** - in that order, and none of them is interchangeable. A
 * filter applied after paging would be a filter over fifty rows pretending to be one over three
 * hundred; an order applied to the page alone would be an order over nothing.
 *
 * Which is also where the whole design earns itself: the filter runs where the data is, so a search
 * that matches nothing sends nothing. No amount of client-side filtering can do that, because
 * discovering that nothing matched is exactly what it must receive everything to find out.
 *
 * Keys are sorted, contractually, for the reason `projectionKeyOrder` exists: insertion order is a
 * property of how the component happened to build its state, so after a restart page 2 could hold
 * something else entirely and a paging caller would see one entry twice and another never, with
 * nothing to indicate it. A named sort replaces that order and is stable within it - ties keep key
 * order - so paging stays coherent when half the rows report the same quality.
 *
 * A page past the end answers empty with the true total. That sits beside the refusal of a negative
 * page above and only looks inconsistent: a malformed bound is a caller holding it wrong, while a
 * page that has run off the end is a **race the caller cannot avoid** - the set is data, and a page
 * that was valid when the operator clicked may be past the end by the time the request lands.
 * Erroring on that would make a link fail more the slower it got. A filter makes that ordinary
 * rather than exotic: typing one more letter can empty a page the operator was reading.
 *
 * A store-backed component should do all of this as a query. In particular a `startsWith` on `id`
 * over sorted keys is a contiguous range rather than a scan, which is what makes this affordable on
 * something larger than a record held in memory.
 */
export const getList = (component: object, resource: RpcResource, params: RpcGetListParams): RpcGetListResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const keys = projectionKeyOrder(collection)
    const matched = params.filter ? keys.filter((id) => matchesFilter(params.filter as RpcFilter, collection[id], id)) : keys
    const ordered = params.sort
        ? [...matched].sort((a, b) => {
              const by = compare(fieldOf(collection[a], a, params.sort?.field), fieldOf(collection[b], b, params.sort?.field))
              // Ties fall back to key order, so a sort on a field half the rows share does not
              // shuffle between requests and hand the operator the same row on two pages.
              return (by || compare(a, b)) * (params.sort?.order === 'DESC' ? -1 : 1)
          })
        : matched
    const { page = 0, pageSize } = params.pagination ?? {}
    const from = page * (pageSize ?? 0)
    const ids = pageSize === undefined ? ordered : ordered.slice(from, from + pageSize)
    return {
        data: ids.map((id) => collection[id]),
        ids,
        total: ordered.length,
        epoch: snapshot.epoch,
        revision: snapshot.revision
    }
}
