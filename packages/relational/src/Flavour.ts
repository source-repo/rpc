import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import type { ColumnInfo } from './Catalogue.js'

/**
 * What actually differs between one SQL database and the next, reduced to the two things that
 * change an *answer* rather than the syntax around it.
 *
 * Kysely already absorbs the syntax - placeholders, quoting, `LIMIT` versus `TOP`, the shape of an
 * introspection call - and none of that is interesting, because none of it can make the same
 * question come back with different rows. These two can.
 *
 * **Matching text.** `contains` and `startsWith` are the operators an operator's search box turns
 * into, and every database disagrees about case. `LIKE` is case-sensitive on Postgres, and
 * case-*insensitive* under both SQLite's default and MySQL's usual collation - so Postgres and
 * MySQL disagree with each other before a document store is anywhere near the conversation. The
 * in-memory implementation this package has to match uses `String.prototype.includes`, which is
 * case-sensitive, so **case-sensitive is normative here** and each flavour pays whatever that costs
 * it. Left to the default, the symptom is a search box that finds different things on two plants,
 * with no error anywhere to say so.
 *
 * Each of these is also written to need **no escaping**, which is not an accident. `LIKE` would
 * work everywhere, and would mean escaping `%` and `_` out of an operand on every call - and the
 * day somebody forgets, an operator typing `%` into a filter box gets a wildcard instead of a
 * character. `instr`, `strpos` and `LOCATE` take a string and mean it.
 *
 * **Finding the primary key.** Kysely's introspection reports columns, nullability and defaults but
 * says nothing about which column is the key, and a resource that cannot name its id cannot answer
 * `getMany` at all. SQLite has `pragma_table_info`; Postgres and MySQL both have
 * `information_schema`, so those two share one implementation and disagree only about how to spell
 * "the schema I am currently in".
 */
export interface SqlFlavour {
    readonly name: 'sqlite' | 'postgres' | 'mysql'
    /** Case-sensitive prefix match. Never matches a NULL column, which is the missing-field rule. */
    startsWith(column: string, operand: string): Expression<SqlBool>
    /** Case-sensitive substring match, with the same NULL behaviour. */
    contains(column: string, operand: string): Expression<SqlBool>
    /**
     * One column's `ORDER BY` terms, with a missing value placed where the in-memory implementation
     * puts it.
     *
     * That rule is `compare()`'s first line: an absent value sorts after everything, and descending
     * inverts the whole comparison, so **missing is always the greatest value** - last ascending,
     * first descending. Postgres already does exactly that and needs only to say so out loud, since
     * a default is a thing an installation can change. SQLite and MySQL both treat NULL as the
     * *smallest* value and disagree with the rule by default.
     *
     * The two disagree about the remedy as well. SQLite has had `NULLS FIRST`/`NULLS LAST` since
     * 3.30; MySQL has no such syntax at all, so it takes the idiom - order by the nullness first,
     * then by the column.
     *
     * Returns several terms because of that, and takes the whole column so it can return one where
     * a column cannot be null. The tiebreaker this always ends at is a primary key, and wrapping
     * one in `(id is null)` would be a pointless expression that an engine may decline to answer
     * from the index.
     *
     * **It carries the collation too**, which is the same disagreement as `contains` wearing a
     * different hat and is easy to fix in one place and forget in the other. The in-memory
     * comparator is `String(a) < String(b)`, so ordering is by UTF-16 code unit - binary, and
     * therefore case-sensitive with capitals first. SQLite's default is already that; Postgres sorts
     * by the database's locale, and MySQL's usual collation is case-insensitive, so `Borg AB` and
     * `borg` land in a different order on each. A text column is therefore ordered under an explicit
     * binary collation rather than under whichever one the server was created with.
     */
    orderTerms(column: ColumnInfo, direction: 'asc' | 'desc'): readonly Expression<unknown>[]
    /**
     * The primary key's columns in key order: one for an ordinary table, several for a composite
     * key, none for a table that has no key at all.
     */
    primaryKey(db: Kysely<RelationalDatabase>, table: string, schema?: string): Promise<readonly string[]>
}

/**
 * The database type Kysely is parameterised with here: table and column names are data, discovered
 * at runtime, so there is no generated schema to point it at. Every value read back is `unknown`
 * and is narrowed where it is used, which is the honest description of a row from a table nobody
 * declared in TypeScript.
 */
export type RelationalDatabase = Record<string, Record<string, unknown>>

/**
 * An identifier, quoted whole.
 *
 * `sql.id` rather than `sql.ref`, because `sql.ref` reads a dot as table-then-column and a column
 * genuinely named `a.b` would be split into two identifiers that do not exist. Every name reaching
 * here has already been checked against the catalogue, so the quoting is the second line of defence
 * rather than the first - but a whitelist that is bypassed once should still not produce valid SQL.
 */
const id = (name: string) => sql.id(name)

/**
 * A direction as SQL syntax rather than as a value.
 *
 * `sql.raw` is the one place in this package where a string reaches the query without being bound
 * or quoted, and it is safe for exactly one reason: the argument is not data. It comes from
 * `RpcSort['order']`, which the library has already checked is `ASC` or `DESC` and nothing else,
 * and is narrowed again to this two-member union on the way in.
 */
const direction = (order: 'asc' | 'desc') => sql.raw(order === 'desc' ? 'desc' : 'asc')

/** Missing sorts last ascending and first descending, which is the in-memory rule stated as SQL. */
const nullsAt = (order: 'asc' | 'desc') => sql.raw(order === 'desc' ? 'nulls first' : 'nulls last')

/**
 * The one order-by shape SQLite and Postgres share: an optional collation, the direction, and where
 * nulls go - the last two of which only appear when they have something to say.
 */
const collated = (column: ColumnInfo, order: 'asc' | 'desc', collation: string) => {
    const name = column.kind === 'string' ? sql`${id(column.name)} collate ${sql.raw(collation)}` : id(column.name)
    return column.nullable ? sql`${name} ${direction(order)} ${nullsAt(order)}` : sql`${name} ${direction(order)}`
}

export const sqliteFlavour: SqlFlavour = {
    name: 'sqlite',
    // `substr(col, 1, length(op)) = op` rather than `LIKE`, because SQLite's LIKE folds ASCII case
    // and its GLOB has metacharacters of its own with no ESCAPE clause to disarm them. The operand
    // is measured by SQL's `length()` rather than JavaScript's `.length`, since one counts
    // characters and the other counts UTF-16 code units - they differ the moment somebody searches
    // for an emoji.
    startsWith: (column, operand) => sql<SqlBool>`substr(${id(column)}, 1, length(${operand})) = ${operand}`,
    // `instr` is a byte-wise search, so it is case-sensitive without asking. It returns 0 for no
    // match and NULL for a NULL column, and NULL > 0 is unknown rather than true - which is exactly
    // the rule that a row missing the field never matches.
    contains: (column, operand) => sql<SqlBool>`instr(${id(column)}, ${operand}) > 0`,
    // SQLite treats NULL as the smallest value, so ascending would put missing rows first. It has
    // understood NULLS FIRST/LAST since 3.30, which is well below anything Node has shipped.
    // BINARY is already its default collation; naming it costs nothing and stops a column declared
    // `collate nocase` in somebody's schema from quietly ordering differently from the other two.
    orderTerms: (column, order) => [collated(column, order, 'binary')],
    primaryKey: async (db, table) => {
        // `pragma_table_info` as a table-valued function rather than `PRAGMA table_info(x)`, because
        // the function form takes a bound parameter and the statement form takes an identifier that
        // would have to be interpolated.
        const found = await sql<{
            name: string
        }>`select "name" from pragma_table_info(${table}) where "pk" > 0 order by "pk"`.execute(db)
        return found.rows.map((row) => row.name)
    }
}

export const postgresFlavour: SqlFlavour = {
    name: 'postgres',
    // `starts_with` and `strpos` are case-sensitive and take their needle as a value, so neither
    // needs an operand escaped. Postgres' LIKE would have been case-correct already; it is the
    // escaping that rules it out.
    startsWith: (column, operand) => sql<SqlBool>`starts_with(${id(column)}, ${operand})`,
    contains: (column, operand) => sql<SqlBool>`strpos(${id(column)}, ${operand}) > 0`,
    // Postgres already places NULL where the in-memory rule wants it - greatest, so last ascending.
    // Said out loud anyway, because a default is a thing an installation can change and a sort that
    // silently depends on one is a sort that differs between two deployments of the same node. The
    // `C` collation is the byte-order one, which is what makes ordering agree with the other two
    // rather than with whatever locale this database happened to be created under.
    orderTerms: (column, order) => [collated(column, order, '"C"')],
    primaryKey: (db, table, schema) => informationSchemaKey(db, table, schema, sql`current_schema()`)
}

export const mysqlFlavour: SqlFlavour = {
    name: 'mysql',
    // MySQL's usual collation is case-insensitive, so both sides are cast to binary to force a
    // byte-wise comparison. That makes matching accent-sensitive as well as case-sensitive, which
    // is a divergence from a collation-aware search and is declared rather than hidden: it is the
    // only reading that agrees with the in-memory implementation.
    startsWith: (column, operand) => sql<SqlBool>`locate(cast(${operand} as binary), cast(${id(column)} as binary)) = 1`,
    contains: (column, operand) => sql<SqlBool>`locate(cast(${operand} as binary), cast(${id(column)} as binary)) > 0`,
    // MySQL has no NULLS FIRST/LAST at all, so the nullness is ordered first as its own term and
    // the column follows. `(col is null)` is 0 for a value and 1 for a missing one, which under the
    // same direction puts missing last ascending and first descending - the rule, by arithmetic.
    //
    // And a cast to binary rather than a collation name, for the reason `contains` uses one: the
    // usual collation here is case-insensitive, so `Borg AB` and `borg` would come back in an order
    // neither of the other two would produce, and naming a specific `*_bin` collation would tie
    // this to one character set.
    orderTerms: (column, order) => {
        const name = column.kind === 'string' ? sql`cast(${id(column.name)} as binary)` : id(column.name)
        const term = sql`${name} ${direction(order)}`
        return column.nullable ? [sql`(${id(column.name)} is null) ${direction(order)}`, term] : [term]
    },
    primaryKey: (db, table, schema) => informationSchemaKey(db, table, schema, sql`database()`)
}

/**
 * The `information_schema` route, which Postgres and MySQL both serve and which differs between
 * them only in how the current schema is named.
 *
 * A table name alone is ambiguous - the same name may exist in several schemas - so the schema is
 * always part of the question, defaulting to whichever one the connection is already in. Answering
 * from the wrong schema would produce a key that belongs to a different table, which is worse than
 * answering none.
 */
const informationSchemaKey = async (
    db: Kysely<RelationalDatabase>,
    table: string,
    schema: string | undefined,
    currentSchema: Expression<string>
): Promise<readonly string[]> => {
    const within = schema === undefined ? currentSchema : sql`${schema}`
    const found = await sql<{ name: string }>`
        select k.column_name as name
        from information_schema.table_constraints t
        join information_schema.key_column_usage k
            on k.constraint_name = t.constraint_name
            and k.table_schema = t.table_schema
            and k.table_name = t.table_name
        where t.constraint_type = 'PRIMARY KEY'
            and t.table_name = ${table}
            and t.table_schema = ${within}
        order by k.ordinal_position
    `.execute(db)
    return found.rows.map((row) => row.name)
}

/** The flavours this package knows, by the name a caller configures. */
export const flavours: { readonly [name in SqlFlavour['name']]: SqlFlavour } = {
    sqlite: sqliteFlavour,
    postgres: postgresFlavour,
    mysql: mysqlFlavour
}
