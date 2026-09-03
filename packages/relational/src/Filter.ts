import type { RpcFilter, RpcFilterCondition, RpcFilterOp, RpcSort } from '@source-repo/rpc'
import { sql, type Expression, type SqlBool } from 'kysely'
import type { ColumnInfo, TableInfo } from './Catalogue.js'
import type { SqlFlavour } from './Flavour.js'

/**
 * The wire's filter language, turned into SQL.
 *
 * The translation is nearly mechanical, and that is a property of the wire language rather than
 * luck: eight comparisons, `all` and `any`, bounded depth, and operands that can only be a string,
 * a number, a boolean or null. It is a closed set of facts *about* a comparison and deliberately
 * not an expression, so there is nothing here that could arrive carrying something to run.
 *
 * Two things are not mechanical, and they are the whole of this file.
 *
 * **A field is an identifier, and identifiers are not parameterised.** Kysely binds values; a
 * column reference is a string it will build into SQL as given. So every field is resolved against
 * the catalogue first and refused if it is not a real column of the table being queried - the
 * whitelist is the defence, and quoting is only the second line behind it.
 *
 * **The in-memory implementation is normative.** Its rules are written down and argued for in the
 * library's `DataProvider.ts`, and this has to agree with them or the same question answers
 * differently depending on which peer holds the data. Two of them cost real work here: `ne` must
 * match a row whose column is NULL, which SQL's three-valued logic does not do on its own, and a
 * comparison between kinds that do not compare must not quietly produce an order.
 */

/**
 * A request this node will not serve, as opposed to one that failed while being served.
 *
 * Separate from an ordinary error because the two mean different things to whoever gets the reply:
 * this one says the question was wrong and will stay wrong, and it names what would have been
 * right. It is thrown rather than returned so that no call site can forget to check it.
 */
export class RelationalRefusal extends Error {
    override readonly name = 'RelationalRefusal'
}

const refuse = (message: string): never => {
    throw new RelationalRefusal(message)
}

/**
 * An id from the wire, as the key column will actually match it.
 *
 * The wire carries ids as strings today, so an integer key arrives as `"42"` and has to become `42`
 * or match nothing - silently, since `where id in ('42')` is a perfectly valid query that finds no
 * rows. Once DEV-437 widens an id to `string | number` this becomes a check rather than a
 * conversion, which is the point of doing it in one place.
 *
 * It lives here rather than in either service because both of them need it and they must not
 * disagree: a `getMany` that finds a row and an `update` that does not would be the two halves of
 * this package answering different questions about the same id.
 */
export const idValueFor = (id: ColumnInfo, given: string): string | number => {
    if (id.kind !== 'number') return given
    const value = Number(given)
    if (!Number.isFinite(value)) return refuse(`${given} is not an id of ${id.name}, which holds ${id.dataType}`)
    return value
}

/**
 * The column a filter or sort field names.
 *
 * `id` names the key column whatever it is actually called, which is the rule `fieldOf` already
 * applies in memory - a caller filtering on `id` means the row's identity, not a column that
 * happens to share the word. A table with a column genuinely named `id` that is not the key would
 * be shadowed by this; that is the same shadowing the in-memory implementation has, and agreeing
 * with it matters more than being independently clever.
 */
export const columnFor = (table: TableInfo, field: string | undefined, what: string): ColumnInfo => {
    if (field === undefined)
        // In memory an absent field compares the row itself, which is meaningful for a record of
        // numbers and meaningless for a table: a row here is always several columns, and there is
        // no value that "the row" could be compared to.
        return refuse(`${what} over a table names a column; there is no value to compare a whole row to`)
    if (field === 'id') return table.id ?? refuse(`${table.name} has no single-column key, so it has no id to compare`)
    if (field.includes('.'))
        // Native in Mongo, and here only meaningful inside a JSON column - which is not served yet.
        // Refusing is the point: the alternative is a dot path that quietly means something else on
        // each backend, and the same query returning different rows with no error anywhere.
        return refuse(`${what} names ${field}, and a path inside a value is not served by this node - name a column`)
    return table.byName.get(field) ?? refuse(`${what} names ${field}, which is not a column of ${table.name}`)
}

/**
 * Whether an operand can be compared to a column at all.
 *
 * The in-memory rule is that ordered comparisons need both sides to be the same kind of thing,
 * because `20 > '9'` having an answer at all is how a threshold silently stops working. Over a
 * table the same mistake is sharper: a column has exactly one type, so an operand of the wrong kind
 * is never a partial match - it is always a caller that built the query wrongly. SQL would coerce
 * it (SQLite) or raise (Postgres), and neither is the declared behaviour.
 *
 * So this refuses, which is a **declared divergence** from the in-memory path: there, a mismatched
 * comparison answers false and the row simply does not match. Refusing is louder, and louder is
 * right here, because a filter that quietly matches nothing looks exactly like a filter that worked
 * and found nothing.
 */
const accepts = (column: ColumnInfo, operand: string | number | boolean): boolean => {
    switch (column.kind) {
        // Unrecognised at introspection time, so nothing is known well enough to refuse on.
        case 'unknown':
            return true
        case 'string':
            return typeof operand === 'string'
        case 'number':
            return typeof operand === 'number'
        case 'boolean':
            return typeof operand === 'boolean'
        // A string only, read as ISO 8601. A number would have to be epoch seconds or epoch
        // milliseconds and nothing on the wire says which, so it is refused rather than guessed -
        // a threshold wrong by a factor of a thousand is a filter that silently matches everything.
        case 'date':
            return typeof operand === 'string'
        // Neither can be compared to a scalar the wire can carry. Both remain testable for NULL,
        // which is handled before this is reached.
        case 'bytes':
        case 'json':
            return false
    }
}

const PATTERN: readonly RpcFilterOp[] = ['startsWith', 'contains']

/** One condition, as SQL. */
const conditionFor = (condition: RpcFilterCondition, table: TableInfo, flavour: SqlFlavour): Expression<SqlBool> => {
    const column = columnFor(table, condition.field, 'a filter condition')
    const name = sql.id(column.name)
    const { op, operand, fold } = condition

    if (operand === null) {
        if (op === 'eq') return sql<SqlBool>`${name} is null`
        if (op === 'ne') return sql<SqlBool>`${name} is not null`
        return refuse(`${op} against null is not a comparison - use eq or ne to test for a missing value`)
    }

    // Before the general kind check, because these two carry their own and can say why in the
    // operator's own terms: "contains compares text" is what somebody typing in a search box needs
    // to read, where the generic "these do not compare" is true and unhelpful.
    if (PATTERN.includes(op)) {
        if (typeof operand !== 'string') return refuse(`${op} compares text, and ${JSON.stringify(operand)} is a ${typeof operand}`)
        if (column.kind !== 'string' && column.kind !== 'unknown')
            return refuse(`${op} compares text, and ${column.name} holds ${column.dataType}`)
        return op === 'startsWith' ? flavour.startsWith(column.name, operand, fold) : flavour.contains(column.name, operand, fold)
    }

    if (!accepts(column, operand))
        return refuse(
            `${column.name} holds ${column.dataType}, and ${JSON.stringify(operand)} is a ${typeof operand} - a comparison between them has no defined answer`
        )

    switch (op) {
        case 'eq':
            return sql<SqlBool>`${name} = ${operand}`
        // The deliberate exception, carried over from the in-memory implementation: a row that
        // lacks the field is genuinely not equal to what was named, and "not bad" means to see the
        // rows that never reported a quality at all. SQL's `<>` drops NULL rows on its own, so
        // agreeing with that rule is something this has to spend a clause on rather than inherit.
        case 'ne':
            return sql<SqlBool>`(${name} <> ${operand} or ${name} is null)`
        case 'lt':
            return sql<SqlBool>`${name} < ${operand}`
        case 'lte':
            return sql<SqlBool>`${name} <= ${operand}`
        case 'gt':
            return sql<SqlBool>`${name} > ${operand}`
        case 'gte':
            return sql<SqlBool>`${name} >= ${operand}`
        default:
            return refuse(`${String(op)} is not a comparison this node serves`)
    }
}

/** `all` and `any`, folded. Both arrive non-empty - the library refuses an empty group at the door. */
const fold = (parts: readonly Expression<SqlBool>[], joiner: 'and' | 'or'): Expression<SqlBool> =>
    parts.length === 1
        ? parts[0]
        : parts.reduce((left, right) => (joiner === 'and' ? sql<SqlBool>`(${left} and ${right})` : sql<SqlBool>`(${left} or ${right})`))

/**
 * A whole filter, as one expression.
 *
 * No depth guard here on purpose: the library already bounds a filter at eight levels and sixty-four
 * nodes before it reaches any component, and a second limit in a second place is one that drifts
 * from the first.
 */
export const whereFor = (filter: RpcFilter, table: TableInfo, flavour: SqlFlavour): Expression<SqlBool> => {
    const group = filter as { all?: readonly RpcFilter[]; any?: readonly RpcFilter[] }
    if (group.all) return fold(group.all.map((inner) => whereFor(inner, table, flavour)), 'and')
    if (group.any) return fold(group.any.map((inner) => whereFor(inner, table, flavour)), 'or')
    return conditionFor(filter as RpcFilterCondition, table, flavour)
}

export interface OrderBy {
    /** The whole column rather than its name, because placing a missing value needs its nullability. */
    readonly column: ColumnInfo
    readonly direction: 'asc' | 'desc'
}

/**
 * The order to read a page in, always ending at the id.
 *
 * The tiebreaker is not a refinement. Neither SQL nor a document store guarantees an order among
 * rows their sort cannot tell apart, so paging by offset over a non-unique sort will show the same
 * row on two pages and never show another one at all - silently, and more often the larger the
 * table. Appending the key makes the order total, which costs one index-ordered column and removes
 * the entire failure.
 */
export const orderFor = (sort: RpcSort | undefined, table: TableInfo): readonly OrderBy[] => {
    const id = table.id ?? refuse(`${table.name} has no single-column key to order by`)
    const direction = sort?.order === 'DESC' ? 'desc' : 'asc'
    if (sort?.field === undefined) return [{ column: id, direction }]
    const column = columnFor(table, sort.field, 'a sort')
    if (column.name === id.name) return [{ column, direction }]
    return [
        { column, direction },
        // Ascending regardless of the caller's direction: the tiebreaker only has to be stable, and
        // making it a total order is the point rather than which end it starts from.
        { column: id, direction: 'asc' }
    ]
}
