import type { RpcDataMethod, RpcDataResource, TypeNode } from '@source-repo/rpc'
import type { Kysely } from 'kysely'
import type { RelationalDatabase, SqlFlavour } from './Flavour.js'

/**
 * What the database says it holds, read once and kept, because everything else here needs it.
 *
 * This is the catalogue in the sense the whole package turns on: **a database's tables are not
 * known when the component is written**, so they cannot be extracted from source the way a
 * contract is, and they arrive at runtime as data. That is exactly the boundary `dataResources()`
 * exists for - the contract says this component *serves* collections, and only the component knows
 * which.
 *
 * It is also the whitelist. Every column name that reaches a query has been checked against what is
 * here, which is the one defence that matters: Kysely parameterises values and does not
 * parameterise identifiers, so a column reference is a string that becomes SQL. A field arriving
 * off the network is compared against this catalogue and refused if it is not in it, and only then
 * quoted.
 */

/**
 * What kind of thing a column holds, coarsely - which is all that is needed to decide whether an
 * operand can sensibly be compared to it.
 *
 * Deliberately not the database's own type name, which is `int4` here, `INTEGER` there and `int`
 * somewhere else for the same declaration. Nothing above this cares about the difference, and a
 * comparison rule written against dialect spellings would be wrong on the next dialect.
 */
export type ColumnKind = 'string' | 'number' | 'boolean' | 'date' | 'bytes' | 'json' | 'unknown'

export interface ColumnInfo {
    readonly name: string
    readonly kind: ColumnKind
    readonly nullable: boolean
    /** What the database called it, kept for the row type and for anyone debugging a refusal. */
    readonly dataType: string
}

export interface TableInfo {
    readonly name: string
    readonly schema?: string
    readonly isView: boolean
    readonly columns: readonly ColumnInfo[]
    readonly byName: ReadonlyMap<string, ColumnInfo>
    /** The primary key's columns in key order. Empty where the table declares none. */
    readonly key: readonly string[]
    /** The id column, present only where the key is exactly one column. */
    readonly id?: ColumnInfo
}

/** A table that exists and is not served, and why - so its absence is reported rather than silent. */
export interface UnservedTable {
    readonly name: string
    readonly reason: string
}

export interface Catalogue {
    readonly tables: readonly TableInfo[]
    readonly unserved: readonly UnservedTable[]
    readonly byName: ReadonlyMap<string, TableInfo>
}

export interface CatalogueOptions {
    /** Restrict to one schema. Absent means whichever schema the connection is already in. */
    readonly schema?: string
    /**
     * Which tables to serve at all, by name. A database node points at a database somebody else
     * owns, and "serve everything you can see" is rarely what its operator meant.
     */
    readonly tables?: (name: string, table: { readonly isView: boolean }) => boolean
    /** Include views. Off by default: a view is often a join nobody wants paged over. */
    readonly views?: boolean
    /**
     * The id column for a table, by name, overriding whatever the database's key says.
     *
     * Two things need this. A **view** has no primary key at all - it is a query, and no engine
     * will claim one for it - so without a way to say "this column identifies a row" a view could
     * never be served and the `views` option above would be a lie. And a **table whose key is
     * composite** can still be addressable if its owner knows some other column is unique; the
     * database cannot know that, and the person deploying the node does.
     *
     * Declared by whoever runs the node rather than inferred, because being wrong here is not a
     * rendering glitch: an id that is not unique makes `getMany` answer one row for a question about
     * another, and nothing downstream can detect it.
     */
    readonly ids?: { readonly [table: string]: string }
}

/**
 * Read the database's shape into the form the rest of this package uses.
 *
 * The primary key comes from the flavour rather than from Kysely, because Kysely's introspection
 * reports columns, nullability and defaults and says nothing about keys - and a table whose id
 * cannot be named cannot answer `getMany`, so this is not an optional refinement.
 */
export const readCatalogue = async (
    db: Kysely<RelationalDatabase>,
    flavour: SqlFlavour,
    options: CatalogueOptions = {}
): Promise<Catalogue> => {
    const metadata = await db.introspection.getTables()
    const tables: TableInfo[] = []
    const unserved: UnservedTable[] = []

    for (const found of metadata) {
        if (options.schema !== undefined && found.schema !== undefined && found.schema !== options.schema) continue
        if (found.isView && !options.views) {
            unserved.push({ name: found.name, reason: 'a view, and views are not served unless asked for' })
            continue
        }
        if (options.tables && !options.tables(found.name, { isView: found.isView })) continue

        const columns = found.columns.map(
            (column): ColumnInfo => ({
                name: column.name,
                kind: classify(column.dataType),
                nullable: column.isNullable,
                dataType: column.dataType
            })
        )
        const byName = new Map(columns.map((column) => [column.name, column]))
        const declared = options.ids?.[found.name]
        if (declared !== undefined && !byName.has(declared)) {
            unserved.push({ name: found.name, reason: `its id was declared as ${declared}, which is not one of its columns` })
            continue
        }
        // A declared id wins over the database's own key, and a view is asked about only when one
        // was declared - `pragma_table_info` and `information_schema` both report no key for a view,
        // so asking would cost a query to be told nothing.
        const key = declared !== undefined ? [declared] : found.isView ? [] : await flavour.primaryKey(db, found.name, options.schema ?? found.schema)

        // A single-column key is the only thing that can become the `id` this protocol carries, and
        // without one a row cannot be named - not by `getMany`, and not even in `getList`, whose
        // result carries an id per row positionally. Composite and keyless tables are therefore
        // reported as unserved rather than served with an id invented for them: a synthesised key
        // is stable only until somebody changes a value inside it, and a row that silently renames
        // itself is worse than a table that is honestly missing. (DEV-437 is where a declared
        // composite encoding would land, at which point these become servable.)
        if (key.length === 0) {
            unserved.push({
                name: found.name,
                reason: found.isView
                    ? 'a view has no key, so its id must be declared before it can be served'
                    : 'no primary key, so a row cannot be addressed'
            })
            continue
        }
        if (key.length > 1) {
            unserved.push({ name: found.name, reason: `a composite primary key (${key.join(', ')}), which has no single id` })
            continue
        }
        const declaredId = byName.get(key[0])
        if (!declaredId) {
            unserved.push({ name: found.name, reason: `the primary key names ${key[0]}, which is not among its columns` })
            continue
        }
        // A key is never null, whatever the introspector says - and one of them says otherwise.
        // SQLite's `integer primary key` is an alias for the rowid and reports `notnull = 0`, so the
        // same table would publish `id: number` on Postgres and `id: number | null` on SQLite: one
        // schema, two contracts, for a column that cannot hold a null in either. Corrected here
        // rather than in the flavour, because it is a fact about keys rather than about engines.
        const id: ColumnInfo = declaredId.nullable ? { ...declaredId, nullable: false } : declaredId
        const withId = columns.map((column) => (column.name === id.name ? id : column))

        tables.push({
            name: found.name,
            schema: found.schema,
            isView: found.isView,
            columns: withId,
            byName: new Map(withId.map((column) => [column.name, column])),
            key,
            id
        })
    }

    return { tables, unserved, byName: new Map(tables.map((table) => [table.name, table])) }
}

/**
 * The database's own type name, reduced to a kind.
 *
 * Substring matching, and that is a deliberate simplification rather than sloppiness: the same
 * declaration comes back as `int4`, `INTEGER`, `int`, `integer unsigned` and `bigint` across three
 * dialects and their options, and enumerating those spellings is a list that is wrong the moment a
 * dialect is added. Anything unrecognised is `unknown`, which is permissive at comparison time -
 * the alternative, refusing to filter on a column whose type this file has not heard of, would make
 * an unfamiliar type an unusable one.
 */
export const classify = (dataType: string): ColumnKind => {
    // The type's own name and nothing after it. `numeric(10,2)`, `character varying`, `timestamp
    // with time zone` and `geography(Point,4326)` all carry parameters or qualifiers that say
    // nothing about what the column holds - and matching inside them is how the last of those gets
    // read as a number, because "point" contains "int". Found by a test that expected `unknown`.
    const type = dataType.toLowerCase().split(/[\s(]/)[0]
    // Two that contain a word they are not. An interval is a duration and a point is a pair, and
    // comparing either to a number off the wire has no defined answer - which is what `unknown`
    // would have meant anyway had the substring rule below not claimed them first.
    if (type === 'interval' || type === 'point') return 'unknown'
    if (type.includes('json')) return 'json'
    if (type.includes('bool')) return 'boolean'
    // Before the numeric check, because `timestamp` and `date` carry no digits but `time` types on
    // some dialects arrive as `timestamp(6)`, and before the string check because `datetime`
    // contains no `char` but `character` does.
    if (type.includes('date') || type.includes('time')) return 'date'
    if (
        type.includes('int') ||
        type.includes('serial') ||
        type.includes('numeric') ||
        type.includes('decimal') ||
        type.includes('real') ||
        type.includes('double') ||
        type.includes('float') ||
        type.includes('money')
    )
        return 'number'
    if (type.includes('blob') || type.includes('binary') || type.includes('bytea')) return 'bytes'
    if (type.includes('char') || type.includes('text') || type.includes('uuid') || type.includes('enum') || type.includes('name')) return 'string'
    return 'unknown'
}

/** What a viewer draws a column from. A nullable column is a union rather than an optional field,
 * because the key is present in every row and its value is `null` - absent and null are different
 * answers and a grid that conflates them will show a blank where it should show "no value". */
export const typeOfColumn = (column: ColumnInfo): TypeNode => {
    const base: TypeNode =
        column.kind === 'string'
            ? { kind: 'string' }
            : column.kind === 'number'
              ? { kind: 'number' }
              : column.kind === 'boolean'
                ? { kind: 'boolean' }
                : column.kind === 'date'
                  ? { kind: 'date' }
                  : column.kind === 'bytes'
                    ? { kind: 'bytes' }
                    : { kind: 'any' }
    return column.nullable ? { kind: 'union', options: [base, { kind: 'null' }] } : base
}

/** Which verbs a table answers. All three of the served ones, since every table here has an id. */
const VERBS: readonly RpcDataMethod[] = ['getList', 'getMany', 'getManyReference']

/**
 * One table as the resource a viewer sees.
 *
 * The row type is drawn from the schema rather than written by hand, which is the whole economic
 * argument for a SQL node over a bespoke one: `packages/queue` maintains its row type in a comment
 * that has to be kept in step with an interface above it, and calls that "a real cost of this
 * interface". Here the database already knows, so nothing is written twice and nothing drifts.
 */
export const resourceOf = (table: TableInfo): RpcDataResource => ({
    path: [table.name],
    verbs: VERBS,
    shape: 'list',
    row: {
        kind: 'object',
        fields: Object.fromEntries(table.columns.map((column) => [column.name, { type: typeOfColumn(column) }]))
    }
})
