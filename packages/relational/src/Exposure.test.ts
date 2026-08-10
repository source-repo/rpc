import { RpcClient, RpcServer, type Introspection, type RpcGetListParams, type RpcGetListResult, type RpcGetManyParams, type RpcGetManyResult } from '@source-repo/rpc'
import test from 'ava'
import { randomUUID } from 'node:crypto'
import { fixture } from './Fixture.js'
import { exposeRelational } from './Service.js'

/**
 * A database as an ordinary peer.
 *
 * Everything else in this suite calls the service directly, which is the right way to test a
 * translation. This one goes over a real link, because the claim that makes the package worth
 * having is not that it can query SQL - it is that **nothing between the console and the table
 * knows this is a database.** The verb is `$data`, the same one a component's own record answers,
 * and the tables arrive in `describe()` the way any other declared resource does.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

interface DataProxy {
    $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult>
    $data(method: 'getMany', resource: readonly string[], params: RpcGetManyParams): Promise<RpcGetManyResult>
}

test('a database is browsed over the wire with the verb a record already answers', async (t) => {
    const db = await fixture()
    // On for this package's own tests, and the cheapest guard there is on the part most likely to
    // be wrong. A row type here is *constructed* - a mapping from the database's column types to
    // TypeNodes - and every mistake in it publishes a shape the rows do not have, silently, because
    // the rows are perfectly well formed and simply are not what was advertised. This validates
    // every row of every page against what `dataResources()` declared, and it needs no contract
    // file to do it: the declaration is made at runtime, which is the whole point of the interface.
    const server = new RpcServer({
        name: peer('sql3941'),
        transports: [{ port: 3941, host: '127.0.0.1' }],
        exposeIntrospection: true,
        validateResults: true
    })
    const service = await exposeRelational(server, 'sql', { db, flavour: 'sqlite' })
    await server.ready()

    const client = new RpcClient('http://localhost:3941', { name: peer('asker3941'), defaultTarget: peer('sql3941') })
    // Torn down here rather than at the end, so a failing assertion closes the listener instead of
    // leaving the suite hanging on an open socket - which reports as a timeout naming the file
    // rather than as the assertion that actually failed.
    t.teardown(async () => {
        await client.close()
        await server.close()
        await db.destroy()
    })

    // The tables arrive as resources, with a row shape drawn from the schema - which is what lets a
    // console draw columns for a table nobody wrote a contract for. Never a row: describe() says
    // what exists and what shape it is, and values are asked for separately.
    const description = await (await client.proxy<Introspection>('msgrpc')).describe()
    const sql = description.namespaces?.find((namespace) => namespace.name === 'sql')
    t.deepEqual(
        sql?.component?.resources?.map((resource) => resource.path.join('.')).sort(),
        ['customers', 'orders', 'sites']
    )
    const customers = sql?.component?.resources?.find((resource) => resource.path[0] === 'customers')
    t.is(customers?.row?.kind, 'object')
    t.deepEqual([...(customers?.verbs ?? [])].sort(), ['getList', 'getMany', 'getManyReference'])

    // The tables that cannot be addressed are named in props rather than being quietly absent, so
    // "why can I not see `tags`" has an answer on the same screen as the question.
    t.true(String(JSON.stringify(sql?.component)).length > 0)
    t.deepEqual(
        service.props.unserved.map((entry) => entry.name).sort(),
        ['active_customers', 'notes', 'tags']
    )

    const proxy = await client.proxy<DataProxy>('sql')

    const page = await proxy.$data('getList', ['customers'], { pagination: { page: 0, pageSize: 2 }, sort: { field: 'name', order: 'ASC' } })
    t.deepEqual(page.ids, ['1', '3'], 'ordered on the peer, over the whole matched set')
    t.is(page.total, 4)
    t.true(page.hasMore)
    t.is((page.data[0] as { name: string }).name, 'Acme Ltd')
    // Filled in by the dispatcher whoever answered, so a slow query and a dead link can be told
    // apart from a browser.
    t.true(typeof page.ms === 'number')

    // A filter matching nothing transfers nothing, which is the property the pull was chosen for.
    const none = await proxy.$data('getList', ['customers'], { filter: { field: 'city', op: 'eq', operand: 'Nowhere' } })
    t.is(none.total, 0)
    t.is(none.data.length, 0)

    const some = await proxy.$data('getMany', ['customers'], { ids: ['3', '1'] })
    t.deepEqual(some.ids, ['3', '1'])

    // A refusal crosses the wire as an error naming what would have been right, rather than as an
    // empty page that reads like a filter which worked.
    const refused = await t.throwsAsync(proxy.$data('getList', ['customers'], { filter: { field: 'nope', op: 'eq', operand: 'x' } }))
    t.regex(String(refused?.message), /not a column of customers/)

    // A mistyped table is an error, not an empty table. This node's resources are a closed
    // published list, so `custmers` is definitively not one of them - and `total: 0` would have
    // rendered as a table that exists and holds nothing, which is the wrong thing to show somebody
    // who simply misspelled it.
    const typo = await t.throwsAsync(proxy.$data('getList', ['custmers']))
    t.regex(String(typo?.message), /custmers is not a resource of sql/)
    t.regex(String(typo?.message), /it serves customers, orders, sites/, 'and says what it does serve, which describe() already publishes')

    // Same for a table that exists in the database and is not served, so "why can I not see tags"
    // is answered where it is asked rather than only in props.
    const unserved = await t.throwsAsync(proxy.$data('getList', ['tags']))
    t.regex(String(unserved?.message), /is not a resource of sql/)

    // Refused by the library at the door, so the node itself never saw either of them - which is
    // why its own refusal counter is still at the one this test caused.
    t.is(service.state.refusals, 1)
})
