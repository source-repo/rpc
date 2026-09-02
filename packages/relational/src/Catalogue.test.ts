import test from 'ava'
import { Kysely, sql } from 'kysely'
import { classify, readCatalogue, resourceOf } from './Catalogue.js'
import { fixture } from './Fixture.js'
import { flavours, type RelationalDatabase } from './Flavour.js'
import { NodeSqliteDialect } from './NodeSqlite.js'

/**
 * What the database says it holds, and what this node will admit to serving.
 *
 * The interesting half is the refusals. A table that cannot be addressed is not served, and the
 * reason travels with it - because a table missing from a scope tree is otherwise indistinguishable
 * from a table that does not exist, and "why can I not see `tags`" is the first question anybody
 * asks.
 */

test('tables become resources, with row types drawn from the schema rather than written by hand', async (t) => {
    const db = await fixture()
    const catalogue = await readCatalogue(db, flavours.sqlite)

    t.deepEqual(
        catalogue.tables.map((table) => table.name).sort(),
        ['customers', 'orders', 'sites'],
        'the three tables with a single-column key'
    )

    const customers = catalogue.byName.get('customers')!
    t.deepEqual(customers.key, ['id'], 'the primary key came from the flavour, since Kysely does not report one')
    t.is(customers.id?.name, 'id')
    t.deepEqual(
        customers.columns.map((column) => `${column.name}:${column.kind}`),
        ['id:number', 'name:string', 'city:string', 'active:boolean', 'balance:number'],
        'every declared type reduced to a kind the comparison rules can use'
    )

    const resource = resourceOf(customers)
    t.deepEqual(resource.path, ['customers'])
    t.deepEqual([...resource.verbs].sort(), ['getList', 'getMany', 'getManyReference'])
    const row = resource.row as { kind: 'object'; fields: Record<string, { type: { kind: string } }> }
    t.is(row.fields.name.type.kind, 'string', 'a not-null column is its type')
    // Nullable is a union with null rather than an optional field: the key is present in every row
    // and its value is null, and a grid that conflates absent with null shows a blank where it
    // should show "no value".
    t.is(row.fields.city.type.kind, 'union')

    await db.destroy()
})

test('a table that cannot be addressed is refused by name, not silently missing', async (t) => {
    const db = await fixture()
    const catalogue = await readCatalogue(db, flavours.sqlite)

    const reasons = new Map(catalogue.unserved.map((entry) => [entry.name, entry.reason]))
    t.regex(String(reasons.get('tags')), /composite primary key/, 'a composite key has no single id')
    t.regex(String(reasons.get('notes')), /no primary key/, 'and a table with no key cannot name a row at all')
    t.regex(String(reasons.get('active_customers')), /view/, 'a view is not served unless it is asked for')
    t.false(catalogue.byName.has('tags'))
    t.false(catalogue.byName.has('notes'))

    await db.destroy()
})

test('a view needs its id declared, because no engine will claim a key for a query', async (t) => {
    const db = await fixture()

    const asked = await readCatalogue(db, flavours.sqlite, { views: true })
    t.false(asked.byName.has('active_customers'), 'admitted as a view, and still unaddressable')
    t.regex(String(asked.unserved.find((entry) => entry.name === 'active_customers')?.reason), /id must be declared/)

    const declared = await readCatalogue(db, flavours.sqlite, { views: true, ids: { active_customers: 'id' } })
    t.is(declared.byName.get('active_customers')?.id?.name, 'id', 'and served once somebody says which column identifies a row')

    const wrong = await readCatalogue(db, flavours.sqlite, { views: true, ids: { active_customers: 'nope' } })
    t.regex(String(wrong.unserved.find((entry) => entry.name === 'active_customers')?.reason), /not one of its columns/)

    await db.destroy()
})

test('a table filter is applied before anything else, since a node points at somebody else’s database', async (t) => {
    const db = await fixture()
    const catalogue = await readCatalogue(db, flavours.sqlite, { tables: (name) => name === 'customers' })
    t.deepEqual(
        catalogue.tables.map((table) => table.name),
        ['customers']
    )
    await db.destroy()
})

test('type names reduce to kinds across dialect spellings', (t) => {
    // The same declaration comes back differently from every dialect, which is the whole reason
    // this reduces to a kind rather than matching names.
    for (const spelling of ['int4', 'INTEGER', 'int', 'bigint', 'numeric(10,2)', 'double precision', 'serial'])
        t.is(classify(spelling), 'number', spelling)
    for (const spelling of ['text', 'varchar(80)', 'character varying', 'uuid', 'TEXT']) t.is(classify(spelling), 'string', spelling)
    for (const spelling of ['bool', 'BOOLEAN', 'tinyint(1) unsigned zerofill'.replace('tinyint', 'bool')]) t.is(classify(spelling), 'boolean', spelling)
    for (const spelling of ['date', 'timestamptz', 'datetime', 'TIMESTAMP(6)']) t.is(classify(spelling), 'date', spelling)
    for (const spelling of ['bytea', 'blob', 'varbinary(16)']) t.is(classify(spelling), 'bytes', spelling)
    t.is(classify('jsonb'), 'json')
    // Unrecognised is permissive rather than refused: refusing to filter a column whose type this
    // file has not heard of would make an unfamiliar type an unusable one.
    t.is(classify('geography(Point,4326)'), 'unknown', 'and not a number, though "point" contains "int"')
    t.is(classify('interval'), 'unknown', 'a duration is not a number off the wire')
    t.is(classify('bit varying'), 'unknown')
})

/**
 * A schema whose foreign keys are each a different answer, built here rather than added to the
 * shared fixture so that forty-three assertions about that one do not move to test this.
 */
const referring = async () => {
    const db = new Kysely<RelationalDatabase>({ dialect: new NodeSqliteDialect({ filename: ':memory:' }) })
    await sql`create table customers (id integer primary key, name text not null unique)`.execute(db)
    await sql`create table notes (body text)`.execute(db)
    await sql`create table tags (customer_id integer not null, tag text not null, primary key (customer_id, tag))`.execute(db)
    await sql`create table orders (
        id integer primary key,
        customer_id integer not null references customers(id),
        parent_id integer references orders(id),
        by_name text references customers(name),
        note_body text references notes(body),
        tag_customer integer,
        tag_name text,
        foreign key (tag_customer, tag_name) references tags(customer_id, tag)
    )`.execute(db)
    return db
}

test('a foreign key becomes a reference only where it can keep the promise one makes', async (t) => {
    const catalogue = await readCatalogue(await referring(), flavours.sqlite)
    const orders = catalogue.byName.get('orders')!

    t.deepEqual(
        [...orders.references].sort((a, b) => a.field.localeCompare(b.field)),
        [
            // A tree in a table is an ordinary shape, and following one is meaningful.
            { field: 'customer_id', target: 'customers' },
            { field: 'parent_id', target: 'orders' }
        ],
        'the single-column keys pointing at a served table\'s id, and those only'
    )

    // Each of the four that were dropped, named, because "it did not appear" is the same symptom
    // for all of them and they are dropped for different reasons.
    const fields = orders.references.map((reference) => reference.field)
    t.false(fields.includes('by_name'), 'a key pointing at a unique column that is not the id: getMany takes ids')
    t.false(fields.includes('note_body'), 'a key pointing at a table with no key, which this catalogue does not serve')
    t.false(fields.includes('tag_customer'), 'half of a composite key, which is not a field holding an id')
    t.false(fields.includes('tag_name'))

    // And the resource carries them in the shape the contract declares, addressed the way `$data`
    // addresses a resource rather than the way SQL names a table.
    const resource = resourceOf(orders)
    t.deepEqual(resource.references?.find((reference) => reference.field === 'customer_id'), { field: 'customer_id', target: ['customers'] })
    t.is(resourceOf(catalogue.byName.get('customers')!).references, undefined, 'a table that refers to nothing declares nothing')
})

test('a table can be told which column names a row, and is not guessed at', async (t) => {
    const db = await referring()
    const named = await readCatalogue(db, flavours.sqlite, { names: { customers: 'name' } })
    t.is(resourceOf(named.byName.get('customers')!).presentation?.representation, 'name')
    t.is(resourceOf(named.byName.get('orders')!).presentation?.representation, undefined, 'and a table nobody spoke for says nothing')

    // A column the table does not have is dropped, not honoured approximately - a representation
    // naming nothing would put an empty sentence wherever a name was promised.
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const wrong = await readCatalogue(await referring(), flavours.sqlite, { names: { customers: 'nickname' } })
        t.is(resourceOf(wrong.byName.get('customers')!).presentation?.representation, undefined)
    } finally {
        console.warn = warn
    }
    t.regex(String(said.find((line) => line.includes('nickname'))), /named by their id instead/)
})
