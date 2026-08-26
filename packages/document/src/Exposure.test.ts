import { RpcClient, RpcServer, type Introspection, type RpcGetListParams, type RpcGetListResult, type RpcGetManyParams, type RpcGetManyResult } from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { randomUUID } from 'node:crypto'
import { fixture, MONGO_URL, type MongoFixture } from './Fixture.js'
import { exposeDocument } from './Service.js'

/**
 * A document database as an ordinary peer.
 *
 * Everything else in this package calls the service directly, which is the right way to test a
 * translation. This one goes over a real link, because the claim that makes the package worth
 * having is not that it can query MongoDB - it is that **nothing between the console and the
 * collection knows this is MongoDB.** The verb is `$data`, the same one a component's own record
 * answers and the same one the SQL node answers, and the collections arrive in `describe()` the way
 * any other declared resource does.
 *
 * `validateResults` is on, and it does more here than it does over SQL. There, a row type is built
 * from column types the database states; here it may be **inferred from a sample**, and this is the
 * only thing anywhere that checks an inference against the documents it was drawn from. A sampled
 * shape that does not describe its own collection is exactly the failure the labelling exists to
 * warn about - and a check is better than a warning.
 */

const run = randomUUID().replace(/-/g, '').slice(0, 10)
const peer = (name: string) => `${name}-${run}`

interface DataProxy {
    $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult>
    $data(method: 'getMany', resource: readonly string[], params: RpcGetManyParams): Promise<RpcGetManyResult>
}

interface Context {
    held?: MongoFixture
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    try {
        t.context = { held: await fixture(run), skipped: false }
    } catch (failure) {
        if (process.env.SOURCE_RPC_REQUIRE_MONGO)
            throw new Error(`SOURCE_RPC_REQUIRE_MONGO is set, but no MongoDB answered at ${MONGO_URL} - these tests must not be skipped here`, { cause: failure })
        t.context = { skipped: true }
    }
})

test.after.always(async (t) => {
    await t.context?.held?.close()
})

test('a document database is browsed over the wire with the verb a record already answers', async (t) => {
    if (t.context.skipped) {
        t.pass('no MongoDB reachable, skipped - docker compose -f docker-compose/docker-compose.yml up -d mongo')
        return
    }
    const held = t.context.held!

    const server = new RpcServer({
        name: peer('docs3949'),
        transports: [{ port: 3949, host: '127.0.0.1' }],
        exposeIntrospection: true,
        // Every row of every page checked against the shape this node published - which for a
        // sampled collection is an inference being checked against its own evidence.
        validateResults: true
    })
    const service = await exposeDocument(server, 'docs', { db: held.db })
    await server.ready()

    const client = new RpcClient('http://localhost:3949', { name: peer('asker3949'), defaultTarget: peer('docs3949') })
    // Torn down here rather than at the end, so a failing assertion closes the listener instead of
    // leaving the suite hanging on an open socket - which reports as a timeout naming the file
    // rather than as the assertion that actually failed.
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    // The collections arrive as resources with a row shape, which is what lets a console draw
    // columns for a collection nobody wrote a contract for. Never a document: describe() says what
    // exists and what shape it is, and values are asked for separately.
    const description = await (await client.proxy<Introspection>('msgrpc')).describe()
    const docs = description.namespaces?.find((namespace) => namespace.name === 'docs')
    t.deepEqual(
        docs?.component?.resources?.map((resource) => resource.path.join('.')).sort(),
        ['customers', 'orders', 'sites']
    )
    const customers = docs?.component?.resources?.find((resource) => resource.path[0] === 'customers')
    t.is(customers?.row?.kind, 'object')
    t.deepEqual([...(customers?.verbs ?? [])].sort(), ['getList', 'getMany', 'getManyReference'])

    // Where each shape came from travels with the component rather than being something a viewer has
    // to assume. Over SQL this would say nothing interesting; here it is the difference between a
    // declaration and twenty documents' worth of evidence.
    t.deepEqual(
        service.props.shapes.map(({ name, from }) => `${name}:${from}`).sort(),
        ['customers:sampled', 'orders:sampled', 'sites:sampled']
    )

    const proxy = await client.proxy<DataProxy>('docs')

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
    const refused = await t.throwsAsync(proxy.$data('getList', ['customers'], { filter: { field: '$where', op: 'eq', operand: 'x' } }))
    t.regex(String(refused?.message), /an operator rather than a field/)

    // A mistyped collection is an error rather than an empty collection, because this node's
    // resources are a closed published list - the library refuses it before the node is reached.
    const typo = await t.throwsAsync(proxy.$data('getList', ['custmers']))
    t.regex(String(typo?.message), /custmers is not a resource of docs/)
    // Named in whatever order `listCollections` gives them, which is natural order rather than
    // alphabetical - so what is asserted is that each one is there, not the sequence.
    for (const served of ['customers', 'orders', 'sites']) t.regex(String(typo?.message), new RegExp(served))
})

test('a sampled shape is checked against the documents it was inferred from', async (t) => {
    if (t.context.skipped) {
        t.pass('no MongoDB reachable, skipped')
        return
    }
    // **Its own database, not the shared one.** This test adds a collection, and the test beside it
    // asserts exactly which collections the node serves - two things ava runs concurrently, and a
    // race with no fixed answer: whichever ran second was right about a different database than the
    // one it was looking at. Cheap to isolate, since a fixture is already one database per name.
    const held = await fixture(`${run}drift`)

    // The check this package needs more than the SQL one does. A column type is a statement the
    // database makes about every row it will ever hold; a sampled shape is evidence about the
    // documents that happened to be read, and the twenty-first document owes it nothing. So the
    // sample is drawn from part of a collection and the whole of it is then served through the
    // check - which is the shape of the real failure, not a contrived one.
    await held.db.collection('drifting').insertMany([
        { _id: 'a' as unknown as never, label: 'one' },
        { _id: 'b' as unknown as never, label: 'two' },
        // Beyond the sample, and disagreeing with what it will have concluded: `label` is a number
        // here, where the first two documents made it look like a string.
        { _id: 'c' as unknown as never, label: 3 }
    ])

    const server = new RpcServer({ name: peer('drift3950'), transports: [{ port: 3950, host: '127.0.0.1' }], validateResults: true })
    // Two documents of evidence about a collection of three.
    const service = await exposeDocument(server, 'drifted', { db: held.db, catalogue: { sample: 2, collections: (name) => name === 'drifting' } })
    await server.ready()

    const client = new RpcClient('http://localhost:3950', { name: peer('asker3950'), defaultTarget: peer('drift3950') })
    t.teardown(async () => {
        await client.close()
        await server.close()
        await held.close()
    })
    const proxy = await client.proxy<DataProxy>('drifted')

    const row = service.dataResources()[0].row as { kind: 'object'; fields: Record<string, { type: { kind: string } }> }
    t.is(row.fields.label.type.kind, 'string', 'which is what two documents said')

    // The page that reaches the third document is refused rather than served, and the refusal names
    // the row and the field. Without this the console would draw a text column and render a number
    // into it, and nothing anywhere would say the shape was a guess that turned out wrong.
    const caught = await t.throwsAsync(proxy.$data('getList', ['drifting']))
    t.regex(String(caught?.message), /drifting served a row its own declared type forbids/, 'and it names the resource')
    t.regex(String(caught?.message), /\(row 2\)/, 'and which row, since a page of fifty is a search rather than a diagnosis')
    t.regex(String(caught?.message), /label: expected string, got number/, 'and which field, and what it should have been')

    // And the page that stays inside the evidence is served, so the check is about the disagreement
    // rather than about sampling at all.
    const inside = await proxy.$data('getList', ['drifting'], { pagination: { page: 0, pageSize: 2 } })
    t.deepEqual(inside.ids, ['a', 'b'])
})
