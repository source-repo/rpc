import type { RpcGetListParams, RpcGetListResult } from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { RelationalDatabase, SqlFlavour } from './Flavour.js'
import { NodeSqliteDialect } from './NodeSqlite.js'
import { RelationalService } from './Service.js'

/**
 * The same questions, against every SQL database there is a server for.
 *
 * This is the beginning of the conformance suite (DEV-440) and its whole argument in one file: one
 * contract over many backends is a claim, and until something asks all of them the same thing and
 * compares the answers it stays a claim. The failure it exists to catch is quiet - the same filter
 * returning different rows on two engines, with no error anywhere, because a null comparison or a
 * collation or a sort order meant something slightly different on each.
 *
 * **The in-memory implementation is normative**, so the expected answers below are not "what SQL
 * does". They are what `DataProvider.ts` already ruled on, with the reasoning written down there,
 * and each backend has to agree with them or say plainly that it cannot. Three of the eleven
 * questions here fail on at least one engine's defaults, which is the point of asking.
 *
 * SQLite always runs: it needs no server, so this file is never entirely skipped. Postgres and
 * MySQL run when `docker compose -f docker-compose/docker-compose.yml up -d` has them, and are
 * skipped otherwise - which is right on a laptop and wrong in CI, so `SOURCE_RPC_REQUIRE_SQL`
 * turns the skip into a failure the same way `SOURCE_RPC_REQUIRE_BROKER` does for the broker.
 */

const POSTGRES_URL = process.env.MSGRPC_TEST_POSTGRES ?? 'postgres://test:test@localhost:5432/test'
const MYSQL_URL = process.env.MSGRPC_TEST_MYSQL ?? 'mysql://test:test@localhost:3306/test'

/** Unique per run, so two of these at once - or a container somebody forgot - cannot collide. */
const run = randomUUID().replace(/-/g, '').slice(0, 10)
const CUSTOMERS = `customers_${run}`
const ORDERS = `orders_${run}`
const SITES = `sites_${run}`

interface Backend {
    readonly name: string
    readonly flavour: SqlFlavour['name']
    readonly where: string
    open(): Kysely<RelationalDatabase>
    /** The same tables, spelled as each engine spells them. */
    readonly ddl: readonly string[]
}

const BACKENDS: readonly Backend[] = [
    {
        name: 'sqlite',
        flavour: 'sqlite',
        where: 'node:sqlite, in memory',
        open: () => new Kysely<RelationalDatabase>({ dialect: new NodeSqliteDialect({ filename: ':memory:' }) }),
        ddl: [
            `create table ${CUSTOMERS} (id integer primary key, name text not null, city text, active boolean, balance real)`,
            `create table ${ORDERS} (id integer primary key, customer_id integer not null, total real)`,
            `create table ${SITES} (site_id text primary key, label text)`
        ]
    },
    {
        name: 'postgres',
        flavour: 'postgres',
        where: POSTGRES_URL,
        open: () => new Kysely<RelationalDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: POSTGRES_URL, max: 4 }) }) }),
        ddl: [
            `create table ${CUSTOMERS} (id integer primary key, name text not null, city text, active boolean, balance double precision)`,
            `create table ${ORDERS} (id integer primary key, customer_id integer not null, total double precision)`,
            `create table ${SITES} (site_id text primary key, label text)`
        ]
    },
    {
        name: 'mysql',
        flavour: 'mysql',
        where: MYSQL_URL,
        open: () => new Kysely<RelationalDatabase>({ dialect: new MysqlDialect({ pool: createPool({ uri: MYSQL_URL, connectionLimit: 4 }) }) }),
        ddl: [
            `create table ${CUSTOMERS} (id int primary key, name varchar(80) not null, city varchar(80), active boolean, balance double)`,
            `create table ${ORDERS} (id int primary key, customer_id int not null, total double)`,
            `create table ${SITES} (site_id varchar(40) primary key, label varchar(80))`
        ]
    }
]

/**
 * The rows, chosen for the disagreements rather than for realism.
 *
 * `borg` and `Borg AB` differ only in case. One city is null. Two rows share a city, so an order
 * over it has a tie that only the key can break. Portable literals throughout - every engine reads
 * these the same way, so anything that differs downstream is the translation rather than the data.
 */
const ROWS = {
    customers: `insert into ${CUSTOMERS} (id, name, city, active, balance) values
        (1, 'Acme Ltd', 'Berlin', true, 12.5),
        (2, 'borg', null, false, 3.0),
        (3, 'Borg AB', 'Malmo', true, 40.0),
        (4, 'Cyberdyne', 'Berlin', null, null)`,
    orders: `insert into ${ORDERS} (id, customer_id, total) values (10, 1, 120.0), (11, 1, 40.0), (12, 2, 90.0), (13, 1, 250.0)`,
    sites: `insert into ${SITES} (site_id, label) values ('north', 'North plant'), ('south', 'South plant')`
}

interface Question {
    readonly asks: string
    readonly table: string
    readonly params: RpcGetListParams
    readonly method?: 'getList' | 'getManyReference'
    /** The normative answer: what the library's in-memory implementation would say. */
    readonly ids: readonly string[]
    /**
     * How many rows match, where that is not the length of the page above.
     *
     * The count is of the matched set and the ids are of the page cut from it, so they part company
     * exactly when a question pages - which is the distinction "3 of 47" is made of, and worth
     * asserting rather than assuming.
     */
    readonly total?: number
    /** Why this one is worth asking three times, where that is not obvious. */
    readonly because?: string
}

const QUESTIONS: readonly Question[] = [
    { asks: 'everything', table: CUSTOMERS, params: {}, ids: ['1', '2', '3', '4'] },
    {
        asks: 'ne against a column that is null on one row',
        table: CUSTOMERS,
        params: { filter: { field: 'city', op: 'ne', operand: 'Berlin' } },
        ids: ['2', '3'],
        because: 'SQL <> drops NULL rows on its own, and the in-memory rule keeps them - "not Berlin" means to see the row that never said'
    },
    {
        asks: 'every other operator against that same null',
        table: CUSTOMERS,
        params: { filter: { field: 'city', op: 'startsWith', operand: 'B' } },
        ids: ['1', '4'],
        because: 'a missing value matches nothing except under ne, which three-valued logic already gives'
    },
    { asks: 'is null', table: CUSTOMERS, params: { filter: { field: 'city', op: 'eq', operand: null } }, ids: ['2'] },
    { asks: 'is not null', table: CUSTOMERS, params: { filter: { field: 'city', op: 'ne', operand: null } }, ids: ['1', '3', '4'] },
    {
        asks: 'contains, which an operator types into a search box',
        table: CUSTOMERS,
        params: { filter: { field: 'name', op: 'contains', operand: 'Borg' } },
        ids: ['3'],
        because: "case folding differs per engine and per collation, and 'borg' must not match"
    },
    {
        asks: 'startsWith',
        table: CUSTOMERS,
        params: { filter: { field: 'name', op: 'startsWith', operand: 'B' } },
        ids: ['3'],
        because: 'the same, at the front of the string'
    },
    {
        asks: 'a percent sign somebody typed',
        table: CUSTOMERS,
        params: { filter: { field: 'name', op: 'contains', operand: '%' } },
        ids: [],
        because: 'LIKE would read it as a wildcard and match everything; none of these three use LIKE'
    },
    {
        asks: 'an order over a column that is null on one row, ascending',
        table: CUSTOMERS,
        params: { sort: { field: 'city', order: 'ASC' } },
        ids: ['1', '4', '3', '2'],
        because: 'missing is the greatest value by the in-memory rule, and SQLite and MySQL both call NULL the smallest'
    },
    {
        asks: 'the same, descending',
        table: CUSTOMERS,
        params: { sort: { field: 'city', order: 'DESC' } },
        ids: ['2', '3', '1', '4'],
        because: 'and the tie on Berlin is still broken by the key, ascending, in both directions'
    },
    {
        asks: 'a page after an order',
        table: CUSTOMERS,
        params: { sort: { field: 'name', order: 'ASC' }, pagination: { page: 1, pageSize: 2 } },
        ids: ['4', '2'],
        total: 4,
        because: 'ordering is by byte too, so it reads Acme Ltd, Borg AB, Cyberdyne, borg - and MySQL would order it case-insensitively left alone'
    },
    {
        asks: 'a key that is not called id',
        table: SITES,
        params: { filter: { field: 'id', op: 'eq', operand: 'north' } },
        ids: ['north']
    },
    {
        asks: 'one-to-many with the caller filtering it further',
        table: ORDERS,
        method: 'getManyReference',
        params: { target: 'customer_id', id: 1, filter: { field: 'total', op: 'lt', operand: 200 } } as RpcGetListParams,
        ids: ['10', '11']
    }
]

interface Context {
    readonly live: { backend: Backend; service: RelationalService; db: Kysely<RelationalDatabase> }[]
    /** Carrying why, because "skipped: mysql" and "skipped: mysql, connection refused" are not the
     * same message to somebody who believes their container is up. */
    readonly skipped: { name: string; why: string }[]
}
const test = anyTest as TestFn<Context>

const raise = async (backend: Backend) => {
    const db = backend.open()
    // Probed by running the DDL rather than by opening a socket: a server that accepts connections
    // and refuses to create a table is not a server these tests can use, and finding that out here
    // reports it once instead of eleven times.
    for (const statement of backend.ddl) await sql.raw(statement).execute(db)
    for (const rows of Object.values(ROWS)) await sql.raw(rows).execute(db)
    const service = new RelationalService({ db, flavour: backend.flavour, catalogue: { tables: (name) => name.endsWith(run) } })
    await service.refresh()
    return { backend, service, db }
}

test.before(async (t) => {
    const live: Context['live'] = []
    const skipped: Context['skipped'] = []
    for (const backend of BACKENDS) {
        try {
            live.push(await raise(backend))
        } catch (failure) {
            skipped.push({ name: backend.name, why: failure instanceof Error ? failure.message : String(failure) })
            // Skipping is right on a laptop with no server and wrong everywhere it matters: a suite
            // reporting itself green having quietly run one of its three backends is the run
            // somebody trusts. CI sets this, so the skip cannot happen unnoticed.
            if (process.env.SOURCE_RPC_REQUIRE_SQL)
                throw new Error(
                    `SOURCE_RPC_REQUIRE_SQL is set, but ${backend.name} at ${backend.where} could not be prepared - these tests must not be skipped here`,
                    { cause: failure }
                )
        }
    }
    t.context = { live, skipped }
})

test.after.always(async (t) => {
    for (const { db, backend } of t.context?.live ?? []) {
        // Dropped rather than left: Postgres and MySQL here are not tmpfs on everybody's machine,
        // and a run-suffixed table nobody removes is litter that accumulates one run at a time.
        for (const table of [CUSTOMERS, ORDERS, SITES]) await sql.raw(`drop table if exists ${table}`).execute(db).catch(() => undefined)
        await db.destroy().catch(() => undefined)
        void backend
    }
})

test('every backend answers the same question the same way', async (t) => {
    t.true(t.context.live.length >= 1, 'SQLite needs no server, so at least one backend is always here')
    t.log(`ran against: ${t.context.live.map(({ backend }) => backend.name).join(', ')}`)
    for (const { name, why } of t.context.skipped)
        t.log(`skipped ${name}: ${why} - start it with docker compose -f docker-compose/docker-compose.yml up -d`)

    for (const { backend, service } of t.context.live)
        for (const question of QUESTIONS) {
            const answer = (await service.dataRequest(question.method ?? 'getList', [question.table], question.params)) as RpcGetListResult
            t.deepEqual(
                [...answer.ids],
                [...question.ids],
                `${backend.name}: ${question.asks}${question.because ? ` - ${question.because}` : ''}`
            )
            t.is(answer.total, question.total ?? question.ids.length, `${backend.name}: the count of ${question.asks} is of the matched set, not of the page`)
        }
})

test('the row a backend publishes is the row it answers with', async (t) => {
    // The construction guard, run against each engine's own type names. A boolean is the one that
    // moves: SQLite has no boolean type and answers 1 and 0, and the service corrects that because
    // its own declaration says boolean. If the two ever disagree, this is where it shows.
    for (const { backend, service } of t.context.live) {
        const resource = service.dataResources().find((declared) => declared.path[0] === CUSTOMERS)
        const row = resource?.row as { kind: 'object'; fields: Record<string, { type: { kind: string; options?: { kind: string }[] } }> }
        const kindOf = (field: string) => {
            const type = row.fields[field].type
            return type.kind === 'union' ? (type.options ?? []).map((option) => option.kind).join('|') : type.kind
        }

        t.is(kindOf('name'), 'string', `${backend.name}: a not-null text column`)
        t.is(kindOf('city'), 'string|null', `${backend.name}: and a nullable one is a union, since the key is there with a null in it`)
        t.is(kindOf('id'), 'number', `${backend.name}: an integer key`)

        const answer = (await service.dataRequest('getList', [CUSTOMERS], { filter: { field: 'id', op: 'lte', operand: 4 } })) as RpcGetListResult
        const rows = answer.data as { active: unknown; balance: unknown }[]

        // MySQL is the declared divergence: `boolean` there is an alias for `tinyint(1)`, and the
        // introspector reports `tinyint` with the width already lost - so nothing at this level can
        // tell a flag from a small number, and the column is honestly a number rather than
        // dishonestly a boolean. Said here rather than discovered later.
        if (backend.name === 'mysql') {
            t.is(kindOf('active'), 'number|null', 'mysql: boolean is tinyint, and the width is gone by the time we see it')
            t.is(rows[0].active, 1)
        } else {
            t.is(kindOf('active'), 'boolean|null', `${backend.name}: a real boolean type`)
            t.is(rows[0].active, true, `${backend.name}: and SQLite's 1 is corrected to match what was published`)
            t.is(rows[1].active, false)
        }
        t.is(rows[3].active, null, `${backend.name}: a null stays null rather than becoming false`)
        t.is(rows[0].balance, 12.5, `${backend.name}: a float survives the round trip`)
    }
})
