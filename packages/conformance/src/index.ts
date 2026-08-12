import { validateValue, type RpcGetListParams, type TypeNode } from '@source-repo/rpc'

/**
 * The questions every store-backed node has to answer the same way, and the rows to ask them of.
 *
 * **This package is the specification, not a test helper.** DEV-349's claim is that a store served
 * by SQLite on a bench and Postgres in a plant is the same capability to every caller, and the only
 * thing that can turn that from a claim into a fact is one fixture, asked of every backend, with
 * the answers compared. Copying the questions into each node's own suite is exactly how two
 * implementations drift while both of their suites stay green.
 *
 * Private and never published: it exists for the repository's own workspaces, and a published
 * conformance kit would be a compatibility promise nobody has agreed to make yet.
 *
 * **The expected answers are the in-memory implementation's**, not any database's. Those rules are
 * written down and argued for in the library's `DataProvider.ts` - an absent field never matches,
 * `ne` is the deliberate exception, an order is made total by the key - and where a backend
 * disagrees by default it is the backend that gives way. Three of the questions below fail on at
 * least one engine's defaults, which is the entire reason for asking them three times.
 */

/**
 * The rows, chosen for the disagreements rather than for realism.
 *
 * `borg` and `Borg AB` differ only in case, because case folding is what silently changes what a
 * search box finds. One city is missing, because `ne` matching a row that never had a value is the
 * rule SQL does not follow on its own. Two rows share a city, so an order over it has a tie that
 * only the key can break. And every value here is portable - no dates, no decimals with opinions -
 * so anything that differs downstream is the translation rather than the data.
 */
export interface CustomerRow {
    readonly id: number
    readonly name: string
    readonly city: string | null
    readonly active: boolean | null
    readonly balance: number | null
}

export const CUSTOMERS: readonly CustomerRow[] = [
    { id: 1, name: 'Acme Ltd', city: 'Berlin', active: true, balance: 12.5 },
    { id: 2, name: 'borg', city: null, active: false, balance: 3.0 },
    { id: 3, name: 'Borg AB', city: 'Malmo', active: true, balance: 40.0 },
    { id: 4, name: 'Cyberdyne', city: 'Berlin', active: null, balance: null }
]

export interface OrderRow {
    readonly id: number
    readonly customer_id: number
    readonly total: number
}

export const ORDERS: readonly OrderRow[] = [
    { id: 10, customer_id: 1, total: 120.0 },
    { id: 11, customer_id: 1, total: 40.0 },
    { id: 12, customer_id: 2, total: 90.0 },
    { id: 13, customer_id: 1, total: 250.0 }
]

/** A key that is not called `id`, because `field: 'id'` means the row's identity rather than a
 * column of that name - and nothing proves that on a table where the two happen to coincide. */
export interface SiteRow {
    readonly site_id: string
    readonly label: string
}

export const SITES: readonly SiteRow[] = [
    { site_id: 'north', label: 'North plant' },
    { site_id: 'south', label: 'South plant' }
]

export type ConformanceCollection = 'customers' | 'orders' | 'sites'

export interface DataQuestion {
    readonly asks: string
    readonly collection: ConformanceCollection
    readonly method?: 'getList' | 'getManyReference'
    readonly params: RpcGetListParams
    /** The normative answer: what the library's in-memory implementation would say, as ids. */
    readonly ids: readonly string[]
    /**
     * How many rows match, where that is not the length of the page above.
     *
     * The count is of the matched set and the ids are of the page cut from it, so they part company
     * exactly when a question pages - which is the distinction "3 of 47" is made of.
     */
    readonly total?: number
    /** Why this is worth asking every backend, where that is not obvious from the question. */
    readonly because?: string
    /**
     * Backends that cannot comply, named with the reason.
     *
     * A divergence that survives is acceptable **only** as a declared capability with an argument
     * attached - never as a skipped assertion, which reads identically to a passing one in a
     * summary. Keyed by the backend name its suite uses.
     */
    readonly except?: { readonly [backend: string]: string }
}

export const DATA_QUESTIONS: readonly DataQuestion[] = [
    { asks: 'everything', collection: 'customers', params: {}, ids: ['1', '2', '3', '4'] },
    {
        asks: 'ne against a field that is missing on one row',
        collection: 'customers',
        params: { filter: { field: 'city', op: 'ne', operand: 'Berlin' } },
        ids: ['2', '3'],
        because: "SQL's <> drops NULL rows on its own and the in-memory rule keeps them - \"not Berlin\" means to see the row that never said"
    },
    {
        asks: 'every other operator against that same missing value',
        collection: 'customers',
        params: { filter: { field: 'city', op: 'startsWith', operand: 'B' } },
        ids: ['1', '4'],
        because: 'a missing value matches nothing except under ne'
    },
    { asks: 'is null', collection: 'customers', params: { filter: { field: 'city', op: 'eq', operand: null } }, ids: ['2'] },
    { asks: 'is not null', collection: 'customers', params: { filter: { field: 'city', op: 'ne', operand: null } }, ids: ['1', '3', '4'] },
    {
        asks: 'contains, which an operator types into a search box',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'contains', operand: 'Borg' } },
        ids: ['3'],
        because: "case folding differs per engine and per collation, and 'borg' must not match"
    },
    {
        asks: 'startsWith',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'startsWith', operand: 'B' } },
        ids: ['3'],
        because: 'the same, at the front of the string'
    },
    {
        asks: 'a percent sign somebody typed',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'contains', operand: '%' } },
        ids: [],
        because: 'LIKE would read it as a wildcard and match every row'
    },
    {
        asks: 'a regex metacharacter somebody typed',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'contains', operand: '.*' } },
        ids: [],
        because: 'and an unescaped $regex would read it as "anything", which is the same failure from the other side'
    },
    {
        asks: 'an order over a field missing on one row, ascending',
        collection: 'customers',
        params: { sort: { field: 'city', order: 'ASC' } },
        ids: ['1', '4', '3', '2'],
        because: 'missing is the greatest value by the in-memory rule, and SQLite, MySQL and Mongo all call it the smallest'
    },
    {
        asks: 'the same, descending',
        collection: 'customers',
        params: { sort: { field: 'city', order: 'DESC' } },
        ids: ['2', '3', '1', '4'],
        because: 'and the tie on Berlin is still broken by the key ascending, in both directions'
    },
    {
        asks: 'a page after an order',
        collection: 'customers',
        params: { sort: { field: 'name', order: 'ASC' }, pagination: { page: 1, pageSize: 2 } },
        ids: ['4', '2'],
        total: 4,
        because: 'ordering is by byte too, so it reads Acme Ltd, Borg AB, Cyberdyne, borg - MySQL would order it case-insensitively left alone'
    },
    {
        asks: 'a count with no rows, which is the cheapest question there is',
        collection: 'customers',
        params: { pagination: { page: 0, pageSize: 0 } },
        ids: [],
        total: 4
    },
    {
        asks: 'a key that is not called id',
        collection: 'sites',
        params: { filter: { field: 'id', op: 'eq', operand: 'north' } },
        ids: ['north']
    },
    {
        asks: 'one-to-many with the caller filtering it further',
        collection: 'orders',
        method: 'getManyReference',
        params: { target: 'customer_id', id: 1, filter: { field: 'total', op: 'lt', operand: 200 } } as RpcGetListParams,
        ids: ['10', '11'],
        because: 'the reference is combined with the caller\'s filter rather than replaced by it'
    }
]

/**
 * Whether the rows a backend just served match the shape it published for them.
 *
 * The same comparison `validateResults` makes at the dispatch level, available to a suite that
 * calls a service directly - which every conformance suite here does, because a translation is best
 * tested without a socket in front of it. Without this, the questions above check *which* rows come
 * back and nothing at all about whether they look like what the resource claims they look like.
 *
 * It belongs in this package rather than in either node's tests for the reason everything else here
 * does: it is a rule the contract makes, not a convenience one implementation happens to want. And
 * it is worth more against a document store than against a table - a column type is a statement the
 * database makes about every row it will ever hold, while a sampled shape is evidence about the
 * documents that happened to be read, and the next one owes it nothing.
 *
 * Returns the first disagreement, naming the row and the field, or undefined where they all agree.
 * A resource that publishes no row shape at all cannot disagree with one, and answers undefined.
 */
export const rowsAgainstDeclaration = (rows: readonly unknown[], declared: TypeNode | undefined): string | undefined => {
    if (!declared) return undefined
    for (const [at, row] of rows.entries()) {
        const failure = validateValue(row, declared, {}, `row ${at}`)
        if (failure) return failure
    }
    return undefined
}
