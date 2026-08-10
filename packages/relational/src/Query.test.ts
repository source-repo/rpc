import type { RpcGetListResult, RpcGetManyResult } from '@source-repo/rpc'
import test from 'ava'
import { readCatalogue } from './Catalogue.js'
import { orderFor, RelationalRefusal } from './Filter.js'
import { fixture } from './Fixture.js'
import { flavours } from './Flavour.js'
import { RelationalService } from './Service.js'

/**
 * The translation, judged against the in-memory implementation rather than against SQL.
 *
 * That is the whole standard here: the library's own `DataProvider.ts` already rules on what an
 * absent field matches, what `ne` means, and what happens when two things that do not compare are
 * compared - with the reasoning written down. Those rules are normative, and where SQL disagrees
 * with them by default it is SQL that gives way, because the alternative is one question answered
 * differently depending on which peer happens to hold the data.
 */

const serving = async () => {
    const db = await fixture()
    const service = new RelationalService({ db, flavour: 'sqlite' })
    await service.refresh()
    return { db, service }
}

const list = (service: RelationalService, table: string, params: Parameters<RelationalService['dataRequest']>[2] = {}) =>
    service.dataRequest('getList', [table], params) as Promise<RpcGetListResult>

test('a page costs a page, and the count is reported apart from it', async (t) => {
    const { db, service } = await serving()

    const page = await list(service, 'customers', { pagination: { page: 0, pageSize: 2 } })
    t.is(page.data.length, 2, 'the page asked for, and not the extra row fetched to learn hasMore')
    t.is(page.total, 4, 'and how many there are to page through')
    t.true(page.hasMore)
    t.deepEqual(page.ids, ['1', '2'])
    t.true(typeof page.queryMs === 'number' && typeof page.countMs === 'number', 'timed apart, because they are two questions over a table')

    const second = await list(service, 'customers', { pagination: { page: 1, pageSize: 2 } })
    t.deepEqual(second.ids, ['3', '4'], 'zero-based, so page times pageSize needs no adjustment')
    t.false(second.hasMore, 'and the last page says so')

    // The cheapest question there is: no rows, one number.
    const counted = await list(service, 'customers', { pagination: { page: 0, pageSize: 0 } })
    t.is(counted.data.length, 0)
    t.is(counted.total, 4)

    const everything = await list(service, 'customers')
    t.is(everything.data.length, 4)
    t.false(everything.hasMore, 'no pageSize asked for the whole matched set, so nothing follows it')

    await db.destroy()
})

test('a table that cannot afford a count pages on hasMore alone', async (t) => {
    const db = await fixture()
    // `COUNT(*)` over a filtered predicate walks it, which on a large table is most of the request.
    // Turned off, the count is *absent* rather than zero - the distinction the whole optional
    // `total` exists for, since past the end the two would otherwise be indistinguishable.
    const service = new RelationalService({ db, flavour: 'sqlite', count: false })
    await service.refresh()

    const first = await list(service, 'customers', { pagination: { page: 0, pageSize: 3 } })
    t.is(first.total, undefined, 'unknown, and saying zero here is what would read as "nothing matches"')
    t.is(first.countMs, undefined, 'and no time was spent finding out')
    t.true(first.hasMore)
    t.is(first.data.length, 3)

    const last = await list(service, 'customers', { pagination: { page: 1, pageSize: 3 } })
    t.deepEqual(last.ids, ['4'])
    t.false(last.hasMore)

    // The case that decided the shape: page past the end of an uncounted set. Nothing here can be
    // read as "the collection is empty", which `total: 0` would have been.
    const past = await list(service, 'customers', { pagination: { page: 5, pageSize: 3 } })
    t.is(past.data.length, 0)
    t.is(past.total, undefined)
    t.false(past.hasMore)

    await db.destroy()
})

test('ne matches a row that has no value, which SQL does not do on its own', async (t) => {
    const { db, service } = await serving()

    // `city <> 'Berlin'` alone would answer Malmo and drop the null - and the in-memory rule is
    // explicit that an operator asking for "not Berlin" means to see the rows that never reported a
    // city at all. That extra clause is the whole of the divergence, and it is silent without this.
    const notBerlin = await list(service, 'customers', { filter: { field: 'city', op: 'ne', operand: 'Berlin' } })
    t.deepEqual(notBerlin.ids, ['2', '3'], 'the null city is not Berlin')

    // The other half of the same rule: every other operator leaves a missing value unmatched, which
    // SQL's three-valued logic already does.
    const startsWith = await list(service, 'customers', { filter: { field: 'city', op: 'startsWith', operand: 'B' } })
    t.deepEqual(startsWith.ids, ['1', '4'], 'a row with no city does not start with anything')

    const isNull = await list(service, 'customers', { filter: { field: 'city', op: 'eq', operand: null } })
    t.deepEqual(isNull.ids, ['2'])
    const isNotNull = await list(service, 'customers', { filter: { field: 'city', op: 'ne', operand: null } })
    t.deepEqual(isNotNull.ids, ['1', '3', '4'])

    await db.destroy()
})

test('matching text is case-sensitive, whatever the database would have done', async (t) => {
    const { db, service } = await serving()

    // SQLite's LIKE folds ASCII case and would answer both. `instr` is byte-wise, so it agrees with
    // String.prototype.includes - which is what the in-memory path uses and therefore what a search
    // box has to mean on every backend.
    const contains = await list(service, 'customers', { filter: { field: 'name', op: 'contains', operand: 'Borg' } })
    t.deepEqual(contains.ids, ['3'], 'and not the row spelled borg')

    const starts = await list(service, 'customers', { filter: { field: 'name', op: 'startsWith', operand: 'B' } })
    t.deepEqual(starts.ids, ['3'])

    // Nothing was escaped on the way in, and nothing needed to be: `%` is a character to `instr`,
    // where LIKE would have read it as "anything".
    const wildcard = await list(service, 'customers', { filter: { field: 'name', op: 'contains', operand: '%' } })
    t.deepEqual(wildcard.ids, [], 'a percent sign is a character somebody typed, not a wildcard')

    await db.destroy()
})

test('a field that is not a column is refused, rather than reaching the SQL as an identifier', async (t) => {
    const { db, service } = await serving()

    const unknown = await t.throwsAsync(list(service, 'customers', { filter: { field: 'nope', op: 'eq', operand: 'x' } }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(unknown?.message), /nope, which is not a column of customers/)

    // The injection shape, stated as a test: Kysely binds values and does not bind identifiers, so
    // this is the check that matters. It never reaches quoting.
    const injected = await t.throwsAsync(
        list(service, 'customers', { filter: { field: 'name" from customers; drop table customers --', op: 'eq', operand: 'x' } }),
        { instanceOf: RelationalRefusal }
    )
    t.regex(String(injected?.message), /is not a column of customers/)
    const survived = await list(service, 'customers')
    t.is(survived.total, 4, 'and the table is still there')

    const path = await t.throwsAsync(list(service, 'customers', { filter: { field: 'address.city', op: 'eq', operand: 'x' } }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(path?.message), /a path inside a value is not served/, 'a dot path means something different on every backend')

    const whole = await t.throwsAsync(list(service, 'customers', { filter: { op: 'eq', operand: 'x' } }), { instanceOf: RelationalRefusal })
    t.regex(String(whole?.message), /names a column/, 'there is no value a whole row could be compared to')

    await db.destroy()
})

test('a comparison between kinds that do not compare is refused, not coerced', async (t) => {
    const { db, service } = await serving()

    // In memory this answers false, because `20 > '9'` having an answer at all is how a threshold
    // silently stops working. Over a table the same mistake is sharper - a column has one type, so
    // a mismatched operand is never a partial match - and SQLite would happily coerce. Refusing is
    // the declared divergence, and it is louder in the direction that helps.
    const mistyped = await t.throwsAsync(list(service, 'customers', { filter: { field: 'name', op: 'gt', operand: 20 } }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(mistyped?.message), /has no defined answer/)

    const pattern = await t.throwsAsync(list(service, 'customers', { filter: { field: 'balance', op: 'contains', operand: '1' } }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(pattern?.message), /compares text/)

    const ordered = await t.throwsAsync(list(service, 'customers', { filter: { field: 'city', op: 'gt', operand: null } }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(ordered?.message), /use eq or ne/)

    await db.destroy()
})

test('id names the key column whatever it is called', async (t) => {
    const { db, service } = await serving()

    const one = await list(service, 'sites', { filter: { field: 'id', op: 'eq', operand: 'north' } })
    t.deepEqual(one.ids, ['north'], 'the key is site_id, and the caller does not have to know that')

    const rows = one.data as { site_id: string; label: string }[]
    t.is(rows[0].label, 'North plant')

    await db.destroy()
})

test('every order ends at the id, so a page cannot show one row twice', async (t) => {
    const db = await fixture()
    const catalogue = await readCatalogue(db, flavours.sqlite)
    const customers = catalogue.byName.get('customers')!

    // Two rows share a city. Without a tiebreaker the engine may return them in either order, so
    // paging by offset over that sort would show one of them on two pages and the other on none -
    // silently, and more often the larger the table.
    t.deepEqual(orderFor({ field: 'city' }, customers), [
        { column: 'city', direction: 'asc' },
        { column: 'id', direction: 'asc' }
    ])
    t.deepEqual(orderFor({ field: 'city', order: 'DESC' }, customers), [
        { column: 'city', direction: 'desc' },
        // Ascending regardless: the tiebreaker only has to make the order total.
        { column: 'id', direction: 'asc' }
    ])
    t.deepEqual(orderFor(undefined, customers), [{ column: 'id', direction: 'asc' }], 'an absent sort is the id, which is already an order')
    t.deepEqual(orderFor({ field: 'id', order: 'DESC' }, customers), [{ column: 'id', direction: 'desc' }], 'and the id needs no tiebreaker')

    await db.destroy()
})

test('getMany answers in the order it was asked, and says nothing about ids that are not there', async (t) => {
    const { db, service } = await serving()

    const found = (await service.dataRequest('getMany', ['customers'], { ids: ['3', '1'] })) as RpcGetManyResult
    t.deepEqual(found.ids, ['3', '1'], 'positional, because a page of reference fields matches answers to questions by position')
    t.is((found.data[0] as { name: string }).name, 'Borg AB')

    const partial = (await service.dataRequest('getMany', ['customers'], { ids: ['99', '1'] })) as RpcGetManyResult
    t.deepEqual(partial.ids, ['1'], 'a foreign key pointing at a deleted row is simply absent')
    t.is(partial.data.length, 1)

    // The wire carries ids as strings today, so an integer key arrives as "1" and has to become 1 -
    // `where id in ('1')` is valid SQL that finds nothing, which is the silent failure this avoids.
    const notAnId = await t.throwsAsync(service.dataRequest('getMany', ['customers'], { ids: ['not-a-number'] }), {
        instanceOf: RelationalRefusal
    })
    t.regex(String(notAnId?.message), /is not an id of id/)

    await db.destroy()
})

test('getManyReference is a list with one condition already applied', async (t) => {
    const { db, service } = await serving()

    const mine = (await service.dataRequest('getManyReference', ['orders'], {
        target: 'customer_id',
        id: 1,
        pagination: { page: 0, pageSize: 2 },
        sort: { field: 'total', order: 'DESC' }
    })) as RpcGetListResult
    t.is(mine.total, 3, 'the count is of the matched set, not of the table')
    t.deepEqual(mine.ids, ['13', '10'], 'sorted and paged after the reference was applied, not before')

    // The caller's own filter is combined with the reference rather than replacing it, or a
    // one-to-many under a record would quietly widen to the whole table the moment somebody typed
    // in the filter box.
    const filtered = (await service.dataRequest('getManyReference', ['orders'], {
        target: 'customer_id',
        id: 1,
        filter: { field: 'total', op: 'lt', operand: 100 }
    })) as RpcGetListResult
    t.deepEqual(filtered.ids, ['11'])

    await db.destroy()
})

test('a row goes on the wire as the type this node published', async (t) => {
    const { db, service } = await serving()

    const page = await list(service, 'customers', { filter: { field: 'id', op: 'lte', operand: 4 } })
    const rows = page.data as { id: number; active: boolean | null; balance: number | null }[]

    // SQLite has no boolean type and answers 1 and 0. The row type this node publishes says
    // boolean, so the answer is corrected rather than the declaration weakened - otherwise the same
    // column reads as a number here and a boolean on Postgres.
    t.is(rows[0].active, true)
    t.is(rows[1].active, false)
    t.is(rows[3].active, null, 'and a null stays null rather than becoming false')
    t.is(rows[3].balance, null)

    await db.destroy()
})

test('a resource this node does not serve is refused by name', async (t) => {
    const { db, service } = await serving()

    const missing = await t.throwsAsync(list(service, 'tags'), { instanceOf: RelationalRefusal })
    t.regex(String(missing?.message), /not a table this node serves/, 'the composite-key table is refused where it is asked for, too')

    const nested = await t.throwsAsync(service.dataRequest('getList', ['state', 'customers'], {}), { instanceOf: RelationalRefusal })
    t.regex(String(nested?.message), /a resource here is one name/)

    // Refusals are counted apart from failures, because one is a caller holding it wrong and the
    // other is the database having a bad day, and a node that cannot tell them apart cannot be
    // diagnosed from a console.
    t.is(service.state.refusals, 2)
    t.is(service.state.failures, 0)

    await db.destroy()
})
