import {
    CUSTOMERS,
    DATA_QUESTIONS,
    ORDER_REFERENCE,
    referencesResolve,
    ORDERS,
    rowsAgainstDeclaration,
    SITES,
    stampedFields,
    WRITE_PERMISSIONS,
    WRITE_QUESTIONS,
    type ConformanceCollection,
    type WriteEnds
} from '@source-repo/conformance'
import { rowStamp, RpcResourceStamps, type RpcGetListParams, type RpcGetListResult, type RpcGetManyResult, type RpcWritePermissions } from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { RelationalDatabase, SqlFlavour } from './Flavour.js'
import { NodeSqliteDialect } from './NodeSqlite.js'
import { RelationalService } from './Service.js'
import { RelationalWriteService } from './WriteService.js'

/**
 * The shared questions, asked of every SQL database there is a server for.
 *
 * The questions and the rows live in `@source-repo/conformance` rather than here, because they are
 * the specification rather than this package's tests: the document node asks the same ones, and a
 * copy in each suite is how two implementations drift while both stay green. What is local to this
 * file is only how each engine spells a table.
 *
 * SQLite always runs - it needs no server, so this file is never entirely skipped. Postgres and
 * MySQL run when `docker compose -f docker-compose/docker-compose.yml up -d` has them, and are
 * skipped with the reason otherwise, which is right on a laptop and wrong in CI. So
 * `SOURCE_RPC_REQUIRE_SQL` turns the skip into a failure, the same way `SOURCE_RPC_REQUIRE_BROKER`
 * does for the broker.
 */

const POSTGRES_URL = process.env.MSGRPC_TEST_POSTGRES ?? 'postgres://test:test@localhost:5432/test'
const MYSQL_URL = process.env.MSGRPC_TEST_MYSQL ?? 'mysql://test:test@localhost:3306/test'

/** Unique per run, so two of these at once - or a container somebody forgot - cannot collide. */
const run = randomUUID().replace(/-/g, '').slice(0, 10)
const TABLE: { readonly [collection in ConformanceCollection]: string } = {
    customers: `customers_${run}`,
    orders: `orders_${run}`,
    sites: `sites_${run}`
}

/**
 * A second copy of the same tables, for the questions that change rows.
 *
 * Separate rather than restored between tests, and the reason is ava rather than SQL: tests in one
 * file run concurrently, so a write question rolling a row back is doing it while a read question is
 * counting that row. Two sets of tables is the only arrangement where neither half has to know the
 * other exists - and the alternative, marking every write question serial, would still leave the
 * fixture altered underneath whichever concurrent test ran last.
 */
const WRITTEN: { readonly [collection in ConformanceCollection]: string } = {
    customers: `wcustomers_${run}`,
    orders: `worders_${run}`,
    sites: `wsites_${run}`
}

interface Backend {
    readonly name: string
    readonly flavour: SqlFlavour['name']
    readonly where: string
    open(): Kysely<RelationalDatabase>
    /** The same three tables, spelled as each engine spells them. */
    readonly ddl: readonly string[]
}

const BACKENDS: readonly Backend[] = [
    {
        name: 'sqlite',
        flavour: 'sqlite',
        where: 'node:sqlite, in memory',
        open: () => new Kysely<RelationalDatabase>({ dialect: new NodeSqliteDialect({ filename: ':memory:' }) }),
        ddl: [
            `create table ${TABLE.customers} (id integer primary key, name text not null, city text, active boolean, balance real)`,
            `create table ${TABLE.orders} (id integer primary key, customer_id integer not null references ${TABLE.customers}(id), total real)`,
            `create table ${TABLE.sites} (site_id text primary key, label text)`,
            `create table ${WRITTEN.customers} (id integer primary key, name text not null, city text, active boolean, balance real)`,
            `create table ${WRITTEN.sites} (site_id text primary key, label text)`
        ]
    },
    {
        name: 'postgres',
        flavour: 'postgres',
        where: POSTGRES_URL,
        open: () => new Kysely<RelationalDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: POSTGRES_URL, max: 4 }) }) }),
        ddl: [
            `create table ${TABLE.customers} (id integer primary key, name text not null, city text, active boolean, balance double precision)`,
            `create table ${TABLE.orders} (id integer primary key, customer_id integer not null references ${TABLE.customers}(id), total double precision)`,
            `create table ${TABLE.sites} (site_id text primary key, label text)`,
            `create table ${WRITTEN.customers} (id integer primary key, name text not null, city text, active boolean, balance double precision)`,
            `create table ${WRITTEN.sites} (site_id text primary key, label text)`
        ]
    },
    {
        name: 'mysql',
        flavour: 'mysql',
        where: MYSQL_URL,
        open: () => new Kysely<RelationalDatabase>({ dialect: new MysqlDialect({ pool: createPool({ uri: MYSQL_URL, connectionLimit: 4 }) }) }),
        ddl: [
            `create table ${TABLE.customers} (id int primary key, name varchar(80) not null, city varchar(80), active boolean, balance double)`,
            `create table ${TABLE.orders} (id int primary key, customer_id int not null, total double, foreign key (customer_id) references ${TABLE.customers}(id))`,
            `create table ${TABLE.sites} (site_id varchar(40) primary key, label varchar(80))`,
            `create table ${WRITTEN.customers} (id int primary key, name varchar(80) not null, city varchar(80), active boolean, balance double)`,
            `create table ${WRITTEN.sites} (site_id varchar(40) primary key, label varchar(80))`
        ]
    }
]

/**
 * The write rules, keyed by the name each run spells a table with.
 *
 * The rules themselves are the shared ones, so what a stamp covers is the same question here as it
 * is over Mongo; only the table's physical name is local, exactly as it is for the read questions.
 */
const WRITE_RULES = {
    [WRITTEN.customers]: WRITE_PERMISSIONS.customers,
    [WRITTEN.sites]: WRITE_PERMISSIONS.sites
} as unknown as RpcWritePermissions

/**
 * The resource stamp off an answer, whichever verb produced it.
 *
 * Read through a helper rather than inline, so the one place a suite could accidentally read an
 * *absent* stamp as "unchanged" is the one place it is written - which is exactly how this column
 * would pass for the wrong reason on a node that publishes nothing.
 */
const resourceStampOf = (answer: RpcGetListResult | RpcGetManyResult | unknown) => (answer as RpcGetListResult).stamp

/** A row of the same collection that the question is not about, for the "somebody else's stamp" step. */
const OTHER: { readonly [collection in ConformanceCollection]: string } = { customers: '3', orders: '11', sites: 'south' }

interface Context {
    readonly live: { backend: Backend; service: RelationalService; writer: RelationalWriteService; db: Kysely<RelationalDatabase> }[]
    /** Carrying why, because "skipped: mysql" and "skipped: mysql, connection refused" are not the
     * same message to somebody who believes their container is up. */
    readonly skipped: { name: string; why: string }[]
}
const test = anyTest as TestFn<Context>

const raise = async (backend: Backend) => {
    const db = backend.open()
    // Probed by running the DDL rather than by opening a socket: a server that accepts connections
    // and refuses to create a table is not one these tests can use, and finding that out here
    // reports it once instead of fifteen times.
    for (const statement of backend.ddl) await sql.raw(statement).execute(db)
    // Inserted from the shared rows rather than from SQL written out here, so the data cannot drift
    // from what the document node is asked about.
    await db.insertInto(TABLE.customers).values(CUSTOMERS as unknown as Record<string, unknown>[]).execute()
    await db.insertInto(TABLE.orders).values(ORDERS as unknown as Record<string, unknown>[]).execute()
    await db.insertInto(TABLE.sites).values(SITES as unknown as Record<string, unknown>[]).execute()
    // One registry handed to both halves, which is the whole arrangement: the writer claims what it
    // may write and moves a stamp when a write lands, and the reader publishes whatever the writer
    // claimed. Given to only one of the two, a node publishes no stamps rather than stamps that
    // never move - which is the failure this cannot afford to make quiet.
    const stamps = new RpcResourceStamps(`${backend.name}-${run}`)
    const service = new RelationalService({ db, flavour: backend.flavour, catalogue: { tables: (name) => name.endsWith(run) }, stamps })
    await service.refresh()
    await db.insertInto(WRITTEN.customers).values(CUSTOMERS as unknown as Record<string, unknown>[]).execute()
    await db.insertInto(WRITTEN.sites).values(SITES as unknown as Record<string, unknown>[]).execute()
    const writer = new RelationalWriteService({ db, flavour: backend.flavour, writes: WRITE_RULES, catalogue: { tables: (name) => name.endsWith(run) }, stamps })
    await writer.refresh()
    return { backend, service, writer, db }
}

/**
 * The rows put back as the fixture had them.
 *
 * Between questions rather than once, because each write question is independent by design: one that
 * depended on the one before it would fail in a way that named the wrong question, and with nine of
 * them running against three engines that is a long way from where the fault is.
 */
const restore = async (db: Kysely<RelationalDatabase>) => {
    await db.deleteFrom(WRITTEN.customers).execute()
    await db.deleteFrom(WRITTEN.sites).execute()
    await db.insertInto(WRITTEN.customers).values(CUSTOMERS as unknown as Record<string, unknown>[]).execute()
    await db.insertInto(WRITTEN.sites).values(SITES as unknown as Record<string, unknown>[]).execute()
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
                throw new Error(`SOURCE_RPC_REQUIRE_SQL is set, but ${backend.name} at ${backend.where} could not be prepared - these tests must not be skipped here`, {
                    cause: failure
                })
        }
    }
    t.context = { live, skipped }
})

test.after.always(async (t) => {
    for (const { db } of t.context?.live ?? []) {
        // Dropped rather than left: these are not tmpfs on everybody's machine, and a run-suffixed
        // table nobody removes is litter that accumulates one run at a time.
        for (const table of [...Object.values(TABLE), ...Object.values(WRITTEN)]) await sql.raw(`drop table if exists ${table}`).execute(db).catch(() => undefined)
        await db.destroy().catch(() => undefined)
    }
})

test('every backend answers the same question the same way', async (t) => {
    t.true(t.context.live.length >= 1, 'SQLite needs no server, so at least one backend is always here')
    t.log(`ran against: ${t.context.live.map(({ backend }) => backend.name).join(', ')}`)
    for (const { name, why } of t.context.skipped)
        t.log(`skipped ${name}: ${why} - start it with docker compose -f docker-compose/docker-compose.yml up -d`)

    for (const { backend, service } of t.context.live)
        for (const question of DATA_QUESTIONS) {
            const excepted = question.except?.[backend.name]
            if (excepted) {
                t.log(`${backend.name} declines "${question.asks}": ${excepted}`)
                continue
            }
            const answer = (await service.dataRequest(question.method ?? 'getList', [TABLE[question.collection]], question.params as RpcGetListParams)) as RpcGetListResult
            t.deepEqual([...answer.ids], [...question.ids], `${backend.name}: ${question.asks}${question.because ? ` - ${question.because}` : ''}`)
            t.is(answer.total, question.total ?? question.ids.length, `${backend.name}: the count of ${question.asks} is of the matched set, not of the page`)
            // And that the rows look like what this backend said they would - the same check the
            // document suite makes, so a shape that drifts from its own data fails identically
            // wherever it happens.
            const declared = service.dataResources().find((resource) => resource.path[0] === TABLE[question.collection])?.row
            t.is(rowsAgainstDeclaration(answer.data, declared), undefined, `${backend.name}: the rows of ${question.asks} match the published shape`)
        }
})

test('a declared reference resolves, on every engine that declares one', async (t) => {
    for (const { backend, service } of t.context.live) {
        const orders = service.dataResources().find((resource) => resource.path[0] === TABLE.orders)
        const declared = orders?.references?.find((reference) => reference.field === ORDER_REFERENCE.field)
        t.truthy(declared, `${backend.name}: the foreign key on ${TABLE.orders} is published as a reference`)
        t.deepEqual([...(declared?.target ?? [])], [TABLE[ORDER_REFERENCE.target]], `${backend.name}: and it names the resource the key points at`)

        // The promise itself, checked against the data rather than against the declaration: take
        // the ids out of a page and ask the target for them. A reference that resolves to nothing
        // is drawn as a blank by every viewer, which is the silent failure this exists to catch.
        const page = (await service.dataRequest('getList', [TABLE.orders], {} as RpcGetListParams)) as RpcGetListResult
        const ids = [...new Set(page.data.map((row) => String((row as Record<string, unknown>)[ORDER_REFERENCE.field])))]
        const targets = (await service.dataRequest('getMany', [TABLE[ORDER_REFERENCE.target]], { ids } as never)) as RpcGetListResult
        t.is(referencesResolve(ORDER_REFERENCE.field, page.data, targets.ids), undefined, `${backend.name}: every id it holds names a row of ${TABLE[ORDER_REFERENCE.target]}`)
    }
})

test('the row a backend publishes is the row it answers with', async (t) => {
    // The construction guard, run against each engine's own type names. A boolean is the one that
    // moves: SQLite has no boolean type and answers 1 and 0, and the service corrects that because
    // its own declaration says boolean. If the two ever disagree, this is where it shows.
    for (const { backend, service } of t.context.live) {
        const resource = service.dataResources().find((declared) => declared.path[0] === TABLE.customers)
        const row = resource?.row as { kind: 'object'; fields: Record<string, { type: { kind: string; options?: { kind: string }[] } }> }
        const kindOf = (field: string) => {
            const type = row.fields[field].type
            return type.kind === 'union' ? (type.options ?? []).map((option) => option.kind).join('|') : type.kind
        }

        t.is(kindOf('name'), 'string', `${backend.name}: a not-null text column`)
        t.is(kindOf('city'), 'string|null', `${backend.name}: and a nullable one is a union, since the key is there with a null in it`)
        // Never a union, on any of them: SQLite's `integer primary key` reports notnull = 0, and a
        // key that could be null would be one contract on SQLite and another on Postgres.
        t.is(kindOf('id'), 'number', `${backend.name}: an integer key`)

        const answer = (await service.dataRequest('getList', [TABLE.customers], { filter: { field: 'id', op: 'lte', operand: 4 } })) as RpcGetListResult
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

/**
 * The same write questions, asked of every SQL database there is a server for.
 *
 * The read half proves that three engines answer one question with the same rows. This proves the
 * harder claim: that they refuse the same changes for the same reasons, and that a precondition
 * means the same thing on each. A divergence here is worse than a divergence in a filter, because a
 * filter that quietly matches the wrong rows can at least be seen on a screen, and a compare-and-set
 * that quietly holds when it should not leaves nothing behind but a value somebody else wrote.
 */
// Serial, because these change rows: ava runs the tests in a file concurrently, and a question
// rolling a row back while another counts it is a race with no fixed answer. Serial tests run
// one at a time and before the concurrent ones, so nothing here overlaps anything.
test.serial('every backend refuses the same changes for the same reasons', async (t) => {
    for (const { backend, service, writer, db } of t.context.live)
        for (const question of WRITE_QUESTIONS) {
            const excepted = question.except?.[backend.name]
            if (excepted) {
                t.log(`${backend.name} declines "${question.asks}": ${excepted}`)
                continue
            }
            await restore(db)
            const table = WRITTEN[question.collection]
            const where = `${backend.name}: ${question.asks}${question.because ? ` - ${question.because}` : ''}`

            // Taken before the first step, which is what makes `held` mean anything: it is the stamp
            // a caller was holding while somebody else changed the row underneath it.
            const opening = await writer.getOne(table, question.id)
            const held = opening.status === 'ok' ? opening.stamp : ''
            const elsewhere = await writer.getOne(table, OTHER[question.collection])

            // The resource stamp as it stood when the question last noted it. Compared rather than
            // asserted absolutely, because it is the node's own running counter and no amount of
            // rebuilding rows between questions resets it.
            let noted: string | undefined
            for (const step of question.steps) {
                if (step.act === 'note') {
                    noted = resourceStampOf(await service.dataRequest('getList', [table], { pagination: { page: 0, pageSize: 1 } }))
                    t.truthy(noted, `${where}: this node publishes a resource stamp for a table it can write`)
                    continue
                }
                if (step.act === 'read') {
                    await service.dataRequest('getList', [table], { pagination: { page: 0, pageSize: 50 } })
                    continue
                }
                if (step.act === 'stamp') {
                    const now = resourceStampOf(await service.dataRequest('getList', [table], { pagination: { page: 0, pageSize: 1 } }))
                    t.is(now !== noted, step.moved, `${where}: the resource stamp ${step.moved ? 'moved' : 'did not move'}`)
                    continue
                }
                if (step.act === 'expect') {
                    const row = await writer.getOne(table, question.id)
                    t.is(row.status, 'ok', `${where}: the row is still there`)
                    if (row.status === 'ok') for (const [field, value] of Object.entries(step.row)) t.is((row.row as Record<string, unknown>)[field], value, `${where}: ${field}`)
                    continue
                }
                if (step.act === 'gone') {
                    t.is((await writer.getOne(table, question.id)).status, 'missing', `${where}: the row is gone`)
                    continue
                }
                const current = await writer.getOne(table, question.id)
                const stamp =
                    step.using === 'held'
                        ? held
                        : step.using === 'other'
                          ? elsewhere.status === 'ok'
                              ? elsewhere.stamp
                              : ''
                          : // `fresh` reads one immediately before acting, which is the ordinary path -
                            // and against a row that is not there it has nothing to read, so the step
                            // is made with the held one and the node answers `missing` rather than
                            // being asked a question about a stamp.
                            current.status === 'ok'
                            ? current.stamp
                            : held
                const act = step.act === 'delete' ? writer.delete(table, question.id, stamp) : writer.update(table, question.id, step.patch, stamp)
                // Narrowed through the union rather than off the step, so a question carrying both
                // an outcome and a refusal - or neither - does not compile here either.
                const ends: WriteEnds = step
                if (ends.refuses !== undefined) {
                    const refusal = await t.throwsAsync(act, undefined, `${where}: refused`)
                    t.regex(refusal!.message, new RegExp(ends.refuses), where)
                    continue
                }
                t.is((await act).status, ends.answers, where)
            }
        }
})

test.serial('every backend stamps the fields its rule permits, over the row it published', async (t) => {
    // The one cross-backend claim about the stamp itself, and it is a relationship rather than a
    // constant: the node must digest exactly the permitted fields, taken from the row as it publishes
    // it. Stamp what the driver returned instead and this fails on SQLite, where a boolean column
    // comes back as 1 and the resource says boolean - which in production shows up only as a
    // precondition that never holds, with nothing anywhere to say why.
    for (const { backend, service, writer, db } of t.context.live) {
        await restore(db)
        const table = WRITTEN.customers
        const page = (await service.dataRequest('getMany', [table], { ids: ['1'] })) as { data: readonly unknown[] }
        const published = page.data[0] as Record<string, unknown>
        const read = await writer.getOne(table, '1')
        t.is(read.status, 'ok')
        if (read.status !== 'ok') continue
        t.is(read.stamp, await rowStamp(table, '1', stampedFields('customers', published)), `${backend.name}: the stamp is a digest of the published row`)
        // And it covers the permitted fields only: `id` is outside the shared rule, so changing
        // nothing but the rule's own columns is what can move it.
        t.deepEqual([...WRITE_PERMISSIONS.customers.columns], ['name', 'city', 'active', 'balance'])
    }
})
