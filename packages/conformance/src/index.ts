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
        asks: 'contains, folded, which is what a search box actually needs',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'contains', operand: 'borg', fold: true } },
        ids: ['2', '3'],
        because:
            'the same question one line up, asked the other way: a filter is case-sensitive because two rows differ by case, and a person typing borg means both of them. Four implementations reach it differently - lower() on two engines, dropped binary casts on MySQL, $options i on Mongo - and this is the only thing that says they agree'
    },
    {
        asks: 'startsWith, folded',
        collection: 'customers',
        params: { filter: { field: 'name', op: 'startsWith', operand: 'ACME', fold: true } },
        ids: ['1'],
        because: 'folding is on both sides, so a shouted operand finds a row that is not shouting'
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

/**
 * What a declared reference has to mean, wherever it is declared.
 *
 * `RpcDataReference` makes one promise and it is exact: **the field holds the target's row id**, so
 * a caller may take the values out of a page and hand them to `getMany` on the target. Everything a
 * viewer does with a reference stands on that - drawing the name instead of the number, batching
 * fifty rows into one round trip, offering to open the thing referred to - and all of it fails the
 * same silent way if the promise does not hold: ids that resolve to nothing, drawn as blanks.
 *
 * The promise is the same sentence over SQL, where it is derived from a foreign key the database
 * declares, and over a document store, where nothing declares it and a deployment says so by hand.
 * That is exactly the pair this package exists for: one word, two implementations, and no way to
 * notice them parting company except by asking both.
 *
 * Given the rows of a page and what `getMany` answered for the ids in them, this returns the first
 * disagreement or undefined. It checks the promise rather than the plumbing - an id that named no
 * row is the failure, and it does not care how either store found the ones that did.
 */
export const referencesResolve = (
    field: string,
    rows: readonly unknown[],
    answered: readonly string[]
): string | undefined => {
    const wanted = new Set<string>()
    for (const row of rows) {
        const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[field] : undefined
        // A null reference is a row that refers to nothing, which is ordinary and not a failure.
        // Everything else is an id, whatever the store spells it as - a SQL key is usually a number
        // and a Mongo one is a string, and `getMany` takes the string either way.
        if (value !== null && value !== undefined) wanted.add(String(value))
    }
    const found = new Set(answered.map(String))
    for (const id of [...wanted].sort()) if (!found.has(id)) return `'${field}' holds ${id}, which the target has no row for`
    return undefined
}

/**
 * The reference every backend must publish for the orders fixture, and why it is that one.
 *
 * `orders.customer_id` names a customer, which is the only relationship in these rows - and it is
 * deliberately a **number** pointing at a numeric key, because that is where the two stores differ
 * most in how they hold it and least in what it means.
 */
export const ORDER_REFERENCE = { field: 'customer_id', target: 'customers' } as const

/**
 * The write side of the same claim, and the reason it belongs here rather than in either node.
 *
 * Reading the same rows the same way was the first half; **changing them under the same
 * precondition is the second**, and it is the half where a divergence is destructive rather than
 * merely confusing. A stamp that means one thing over SQL and another over Mongo would be a
 * compare-and-set that holds on one backend and does not on the other, and the symptom is a lost
 * update - which leaves no trace anywhere for anybody to find afterwards. So the questions are asked
 * once, of every backend, and the answers are compared.
 *
 * **`create` is deliberately not among them, and that is worth saying rather than discovering.**
 * What a store does about a key it was not given is genuinely its own business - Postgres names the
 * row in the insert, MySQL and SQLite report the key they generated, Mongo mints an ObjectId - and
 * a shared question about it would either pin down three different mechanisms or assert nothing.
 * Each package tests its own. What is shared is everything downstream of a row existing, which is
 * where the semantics live.
 */

/**
 * The permission document every write-side suite uses.
 *
 * Shared because it is what makes a stamp comparable at all: a stamp covers the fields a rule
 * permits, so two suites with different rules would produce different digests of the same row and
 * neither would be wrong. The columns are named identically on both backends and the key is
 * deliberately absent from all of them - `id` over SQL and `_id` over Mongo are the one field the
 * two genuinely spell differently, and a question that included it would be asking them different
 * things while looking like one question.
 */
export const WRITE_PERMISSIONS = {
    customers: { verbs: ['update', 'delete'] as const, columns: ['name', 'city', 'active', 'balance'] },
    sites: { verbs: ['update'] as const, columns: ['label'] }
}

/**
 * What a row's stamp must be a digest of: the fields the rule permits, taken from the row **as the
 * node published it**.
 *
 * A rule rather than a table of expected values, and the difference is the whole of it. The obvious
 * shape - a constant per fixture row - would have asserted something subtly wrong, because two
 * backends already publish one of these columns differently and are right to: MySQL's `boolean` is
 * an alias for `tinyint(1)` with the width gone by the time an introspector sees it, so that node
 * honestly declares a number where the others declare a boolean. A shared constant would have made
 * this fixture a second, contradictory opinion about that declaration.
 *
 * And cross-node stamp equality is not the claim anybody needs. A stamp is only ever compared with
 * one taken from the same node, so what has to hold everywhere is the *relationship*: a node stamps
 * exactly the permitted fields, over the values it publishes, in the shared encoding. Stamp the
 * driver's answer instead of the published one and this fails on SQLite, where a boolean column
 * comes back as 1 and the resource says boolean - which is the mistake worth catching, because its
 * only symptom in production is a precondition that never holds.
 *
 * A suite therefore reads a row through `$data`, hands it here, and checks the node's stamp against
 * `rowStamp(itsOwnPhysicalName, id, …)` - which also survives the run-suffixed table names each SQL
 * suite creates.
 *
 * Whether the *encoding* itself is stable is a different question, pinned with literal digests in
 * the library's own `DataWrites.test.ts`, where the scope is fixed and a change shows up as a
 * changed constant in a diff.
 */
export const stampedFields = (collection: ConformanceCollection, published: { readonly [field: string]: unknown }): readonly (readonly [string, unknown])[] => {
    const rule = (WRITE_PERMISSIONS as { readonly [name: string]: { readonly columns: readonly string[] } })[collection]
    if (!rule) throw new Error(`${collection} has no write rule in the shared permission document, so nothing is stamped over it`)
    // Read out of the published row rather than out of the fixture, so an absent field arrives as
    // `undefined` - which the stamp treats as null, because a field a store did not return and a
    // field it returned as null are the same state and every backend spells that differently.
    return rule.columns.map((field) => [field, published[field]] as const)
}

/**
 * Which stamp a step is made under.
 *
 * `held` is the one the whole design exists for: the stamp read before the question began, used
 * after something else has already changed the row. `fresh` reads one immediately before acting,
 * which is the ordinary path. `other` is a perfectly valid stamp belonging to a different row, which
 * must not satisfy a precondition on this one.
 */
export type WriteStamp = 'fresh' | 'held' | 'other'

/**
 * How a step ends: with an outcome, or with a refusal whose message must match.
 *
 * A union rather than two optional fields, so a question cannot be written that expects both or
 * neither - which is a fixture that asserts nothing while looking like it asserts something, and is
 * the failure mode a shared specification can least afford.
 */
export type WriteEnds = { readonly answers: 'ok' | 'conflict' | 'missing'; readonly refuses?: undefined } | { readonly refuses: string; readonly answers?: undefined }

export type WriteStep =
    | ({ readonly act: 'update'; readonly patch: { readonly [field: string]: unknown }; readonly using: WriteStamp } & WriteEnds)
    | ({ readonly act: 'delete'; readonly using: WriteStamp } & WriteEnds)
    /**
     * What the row must look like at this point - the assertion that a refusal changed nothing.
     *
     * Names the fields the question is about and the ones beside them that must not have moved, and
     * deliberately **not** every field. `active` is absent from all of these: MySQL's `boolean` is an
     * alias for `tinyint(1)` and that node honestly publishes a number where the others publish a
     * boolean, so asserting it here would be a second opinion about a type declaration the read
     * questions already cover - and it would fail on MySQL for a reason that has nothing to do with
     * what any write did.
     */
    | { readonly act: 'expect'; readonly row: { readonly [field: string]: unknown } }
    /** That the row is not there at all. */
    | { readonly act: 'gone' }
    /**
     * Remember the **resource** stamp as it stands now, so a later step can say whether it moved.
     *
     * A different thing from the row stamp every other step here is about, and the difference is the
     * point: a row stamp names one row and is what a precondition compares, while a resource stamp
     * names the state of the whole collection as far as writes this node served are concerned. It is
     * what lets a caching reader know its page of fifty is still the page of fifty it fetched -
     * which the component's own revision cannot say for a declared resource, because these nodes
     * move that on **reads**.
     */
    | { readonly act: 'note' }
    /**
     * Whether the resource stamp has moved since it was noted.
     *
     * The whole column, in one word. A node whose stamp does not move when the data moves is worse
     * than one publishing no stamp at all - a reader believes it and stops asking - and a node whose
     * stamp moves when nothing happened has turned a cache back into a poll.
     */
    | { readonly act: 'stamp'; readonly moved: boolean }
    /** Ask for a page, which must leave the resource stamp exactly where it was. */
    | { readonly act: 'read' }

export interface WriteQuestion {
    readonly asks: string
    readonly collection: ConformanceCollection
    /** The row every step acts on. `other` stamps are taken from whichever other row the suite picks. */
    readonly id: string
    readonly steps: readonly WriteStep[]
    /** Why this is worth asking every backend, where that is not obvious from the question. */
    readonly because?: string
    readonly except?: { readonly [backend: string]: string }
}

/**
 * The questions, in the order a suite runs them. Each is independent: a suite rebuilds the fixture
 * between them, because a question that depended on the one before it would fail in a way that named
 * the wrong question.
 *
 * The **resource stamp** steps are the exception worth stating, because they are not about the
 * fixture at all: `note` and `stamp` compare a node's own running counter, which no amount of
 * rebuilding rows resets. That is why they are always written as note-then-compare within one
 * question rather than against any absolute value - and why a backend that publishes no resource
 * stamp must **skip** these rather than read an absent one as unchanged, which would pass for the
 * wrong reason.
 */
export const WRITE_QUESTIONS: readonly WriteQuestion[] = [
    {
        asks: 'a change under a stamp just read is applied',
        collection: 'customers',
        id: '1',
        steps: [
            { act: 'update', patch: { city: 'Hamburg' }, using: 'fresh', answers: 'ok' },
            { act: 'expect', row: { name: 'Acme Ltd', city: 'Hamburg', balance: 12.5 } }
        ]
    },
    {
        asks: 'the same stamp twice is a conflict, and the second change is not applied',
        collection: 'customers',
        id: '1',
        steps: [
            { act: 'update', patch: { city: 'Hamburg' }, using: 'held', answers: 'ok' },
            { act: 'update', patch: { city: 'Bremen' }, using: 'held', answers: 'conflict' },
            { act: 'expect', row: { name: 'Acme Ltd', city: 'Hamburg', balance: 12.5 } }
        ],
        because: 'this is the whole of compare-and-set: a retry after an uncertain outcome must fail the check rather than apply twice'
    },
    {
        asks: 'a stamp belonging to another row satisfies nothing',
        collection: 'customers',
        id: '2',
        steps: [
            { act: 'update', patch: { city: 'Lund' }, using: 'other', answers: 'conflict' },
            { act: 'expect', row: { name: 'borg', city: null, balance: 3.0 } }
        ],
        because: 'the scope and the id are inside the digest, so a stamp names one row of one collection and cannot be carried'
    },
    {
        asks: 'a null is a value a change can set and clear',
        collection: 'customers',
        id: '4',
        steps: [
            { act: 'update', patch: { city: null, balance: 7.5 }, using: 'fresh', answers: 'ok' },
            { act: 'expect', row: { name: 'Cyberdyne', city: null, balance: 7.5 } }
        ],
        because: 'SQL and a document store disagree about what an absent field is, so the fixture says null explicitly and both must store one'
    },
    {
        asks: 'a field outside the rule is refused, and the rest of the patch is not applied either',
        collection: 'customers',
        id: '1',
        steps: [
            { act: 'update', patch: { city: 'Lund', nickname: 'ACME' }, using: 'fresh', refuses: 'nickname' },
            { act: 'expect', row: { name: 'Acme Ltd', city: 'Berlin', balance: 12.5 } }
        ],
        because: 'a patch half-applied and then refused leaves a row in a state nobody asked for, and the error names none of it'
    },
    {
        asks: 'a removal under a fresh stamp takes the row, and a second removal finds nothing',
        collection: 'customers',
        id: '2',
        steps: [
            { act: 'delete', using: 'fresh', answers: 'ok' },
            { act: 'gone' },
            { act: 'delete', using: 'held', answers: 'missing' }
        ],
        because: 'a row that is not there is a fact about the store rather than a fault, so it is an outcome and not an exception'
    },
    {
        asks: 'a change to a row that was removed is missing rather than a conflict',
        collection: 'customers',
        id: '2',
        steps: [
            { act: 'delete', using: 'fresh', answers: 'ok' },
            { act: 'update', patch: { city: 'Anywhere' }, using: 'held', answers: 'missing' }
        ],
        because: 'the two are different facts - one says somebody else edited it and one says there is nothing to edit - and a caller acts differently on each'
    },
    {
        asks: 'a collection keyed on something not called id is changed the same way',
        collection: 'sites',
        id: 'north',
        steps: [
            { act: 'update', patch: { label: 'North works' }, using: 'fresh', answers: 'ok' },
            { act: 'expect', row: { label: 'North works' } }
        ],
        because: 'nothing proves an id is the row’s identity rather than a column of that name on a table where the two coincide'
    },
    {
        asks: 'a write moves the resource stamp and a read leaves it alone',
        collection: 'customers',
        id: '1',
        steps: [
            { act: 'note' },
            { act: 'read' },
            { act: 'stamp', moved: false },
            { act: 'update', patch: { city: 'Hamburg' }, using: 'fresh', answers: 'ok' },
            { act: 'stamp', moved: true }
        ],
        because: 'a stamp that does not move when the data moves is worse than none, and one that moves on a read is a poll wearing a cache'
    },
    {
        asks: 'a change that was refused moves the resource stamp no more than a read does',
        collection: 'customers',
        id: '2',
        steps: [
            { act: 'note' },
            { act: 'update', patch: { city: 'Lund' }, using: 'other', answers: 'conflict' },
            { act: 'stamp', moved: false },
            { act: 'expect', row: { name: 'borg', city: null, balance: 3.0 } }
        ],
        because: 'a conflict is a change that did not happen, and telling every reader to discard its pages over one is how a precondition becomes a traffic source'
    },
    {
        asks: 'a removal moves the resource stamp like any other change',
        collection: 'customers',
        id: '2',
        steps: [
            { act: 'note' },
            { act: 'delete', using: 'fresh', answers: 'ok' },
            { act: 'stamp', moved: true },
            { act: 'note' },
            { act: 'delete', using: 'held', answers: 'missing' },
            { act: 'stamp', moved: false }
        ],
        because: 'a row that was already gone is not a second removal, and a `missing` outcome changed nothing for anybody to re-read'
    },
    {
        asks: 'a verb the rule does not offer is refused whatever the stamp says',
        collection: 'sites',
        id: 'north',
        steps: [{ act: 'delete', using: 'fresh', refuses: 'delete' }],
        because: 'the permission document is consulted before the precondition, so a valid stamp never talks a node into a verb it was not given'
    }
]
