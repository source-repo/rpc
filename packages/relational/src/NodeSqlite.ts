import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
    CompiledQuery,
    SqliteAdapter,
    SqliteIntrospector,
    SqliteQueryCompiler,
    type DatabaseConnection,
    type DatabaseIntrospector,
    type Dialect,
    type Driver,
    type Kysely,
    type QueryCompiler,
    type QueryResult
} from 'kysely'

/**
 * A Kysely dialect over Node's built-in `node:sqlite`.
 *
 * It exists so that this package can be developed, tested and demonstrated with **no database
 * server and no native module**. Kysely's own SQLite dialect is written against `better-sqlite3`,
 * which compiles on install; that is a perfectly reasonable dependency for an application and a bad
 * one for a package whose test suite is meant to run wherever Node does - including in the CI that
 * has to prove the conformance suite (DEV-440) rather than skip it.
 *
 * It is also the smallest possible proof that the flavour split is real: a dialect is a driver, a
 * compiler, an adapter and an introspector, three of which Kysely already ships for SQLite. What is
 * left is this file.
 *
 * `node:sqlite` arrived in Node 22.5 and is imported dynamically below rather than at module load,
 * so an installation that only ever talks to Postgres is never asked whether its Node has it.
 */

export interface NodeSqliteDialectOptions {
    /** A path, or `:memory:`. */
    readonly filename: string
    /** Open without the ability to write. Worth setting for a node that only ever serves reads. */
    readonly readOnly?: boolean
}

export class NodeSqliteDialect implements Dialect {
    constructor(private readonly options: NodeSqliteDialectOptions) {}

    createAdapter() {
        return new SqliteAdapter()
    }

    createDriver(): Driver {
        return new NodeSqliteDriver(this.options)
    }

    createQueryCompiler(): QueryCompiler {
        return new SqliteQueryCompiler()
    }

    createIntrospector(db: Kysely<never>): DatabaseIntrospector {
        return new SqliteIntrospector(db)
    }
}

class NodeSqliteDriver implements Driver {
    #database?: DatabaseSync
    #connection?: NodeSqliteConnection
    /**
     * One connection, handed out one caller at a time.
     *
     * `DatabaseSync` is synchronous and single-threaded, so a query cannot interleave with another
     * query - but a *transaction* is three separate statements with awaits between them, and two of
     * those overlapping would commit half of each. Serialising the handle is the same thing
     * Kysely's better-sqlite3 dialect does, for the same reason.
     */
    #queue: Promise<void> = Promise.resolve()

    constructor(private readonly options: NodeSqliteDialectOptions) {}

    async init(): Promise<void> {
        const { DatabaseSync } = await import('node:sqlite')
        this.#database = new DatabaseSync(this.options.filename, { readOnly: this.options.readOnly ?? false })
        this.#connection = new NodeSqliteConnection(this.#database)
    }

    async acquireConnection(): Promise<DatabaseConnection> {
        let release = () => {}
        const held = this.#queue
        this.#queue = new Promise<void>((resolve) => {
            release = resolve
        })
        await held
        this.#connection!.onRelease = release
        return this.#connection!
    }

    async releaseConnection(connection: DatabaseConnection): Promise<void> {
        const held = connection as NodeSqliteConnection
        const release = held.onRelease
        held.onRelease = () => {}
        release()
    }

    async beginTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('begin'))
    }

    async commitTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('commit'))
    }

    async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        await connection.executeQuery(CompiledQuery.raw('rollback'))
    }

    async destroy(): Promise<void> {
        this.#database?.close()
        this.#database = undefined
        this.#connection = undefined
    }
}

class NodeSqliteConnection implements DatabaseConnection {
    onRelease: () => void = () => {}

    constructor(private readonly database: DatabaseSync) {}

    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const statement: StatementSync = this.database.prepare(compiled.sql)
        const parameters = compiled.parameters.map(toSqliteValue)
        // Which of `all` and `run` to call is read off the query's own node kind rather than
        // guessed from the SQL text, because a statement beginning with `with` may be either and
        // the first word of a raw fragment says nothing at all.
        if (writes(compiled)) {
            const outcome = statement.run(...parameters)
            return {
                rows: [],
                numAffectedRows: BigInt(outcome.changes),
                insertId: BigInt(outcome.lastInsertRowid)
            }
        }
        return { rows: statement.all(...parameters) as R[] }
    }

    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
        // `DatabaseSync` iterates a statement without an async boundary, so streaming here would be
        // the same work with a different shape and none of the benefit - the whole result is
        // already in this process's memory by the time anything could be yielded. Refused rather
        // than faked, so a caller that needs real streaming finds out here instead of in production.
        throw new Error('node:sqlite does not stream; use a paged query')
    }
}

const WRITING = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode'])

const writes = (compiled: CompiledQuery): boolean => WRITING.has(compiled.query.kind)

/**
 * A value as `node:sqlite` will take it.
 *
 * It accepts null, numbers, bigints, strings and `Uint8Array`, and throws on anything else - so the
 * two conversions here are the two things SQLite has no type for. A boolean becomes 1 or 0, which
 * is how SQLite stores one anyway; a Date becomes an ISO 8601 string, which sorts and compares
 * correctly as text and is what a `text` date column in SQLite holds by convention.
 */
const toSqliteValue = (value: unknown): null | number | bigint | string | Uint8Array => {
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
    if (value instanceof Uint8Array) return value
    throw new Error(`node:sqlite cannot bind a ${typeof value}`)
}
