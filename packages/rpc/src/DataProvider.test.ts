import test from 'ava'
import { randomUUID } from 'crypto'
import { pageEntries, rpc, rpcNamespace, rpcComponent, RpcClient, RpcComponent, RpcServer, type Introspection, type RpcComponentProxy, type RpcDataMethod, type RpcDataResources, type RpcGetManyParams, type RpcGetManyReferenceParams, type RpcGetListParams } from './index.js'

/**
 * Paging a collection by asking for it, which is the half a projection cannot do.
 *
 * A record's keys are data, so a caller wanting fifty of three hundred tags cannot name them: the
 * only path that reaches those entries is the record itself, and asking for everything to find out
 * what to ask for is what this exists to avoid. So the grid pulls - react-admin's DataProvider,
 * carried as `$data(type, resource, params)` - and the answer carries the ids, the rows and the one
 * number a caller cannot derive.
 *
 * These tests count what crosses the wire wherever they can, because a console that quietly fetched
 * the whole record to build a page would look exactly like the feature working, and would be
 * measurable only here.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

type FieldProps = { label: string; tags: number }
type Reading = { value: number; unit: string; quality: string }
type FieldState = { fast: number; zones: { top: { setpoint: number } }; tags: { [tag: string]: Reading } }

/** Thirty of the three hundred report bad, which is the page an operator actually goes looking for. */
@rpcNamespace('field')
class Field extends RpcComponent<FieldProps, FieldState> {
    constructor() {
        const tags: FieldState['tags'] = {}
        for (let index = 0; index < 300; index++)
            tags[`tag.${String(index).padStart(3, '0')}`] = { value: index, unit: '°C', quality: index % 10 === 0 ? 'bad' : 'good' }
        super({ label: 'f', tags: 300 }, { fast: 0, zones: { top: { setpoint: 20 } }, tags })
    }

    @rpc({ semantics: 'idempotent-command' })
    async tick() {
        this.setState((previous) => ({ fast: previous.fast + 1 }))
        return this.state.fast
    }
}

/** What the caller sees: an ordinary component proxy, with the DataProvider verb on it. */
type FieldProxy = RpcComponentProxy<Field>

test('a page of a record costs a page, and says how many there are', async (t) => {
    const server = new RpcServer({ name: peer('field3920'), transports: [{ port: 3920, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3920', { name: peer('asker3920'), defaultTarget: peer('field3920') })
    const field = await client.proxy<FieldProxy>('field')

    const page = await field.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 50 } })

    t.is(page.ids.length, 50, 'a page, not the record')
    t.is(page.data.length, 50)
    t.is(page.ids[0], 'tag.000')
    t.is(page.ids[49], 'tag.049')
    t.deepEqual(page.data[0], { value: 0, unit: '°C', quality: 'bad' })

    // The one thing a caller cannot work out for itself: its own rows say what is on this page and
    // nothing at all about the size of the set they came from.
    t.is(page.total, 300)

    // Measured rather than trusted, and against the record rather than against a constant, so the
    // claim cannot drift as a row grows a field. An implementation that fetched the whole record
    // and sliced it locally would pass every assertion above while failing this one.
    const carried = JSON.stringify(page)
    const whole = JSON.stringify(await field.$data('getList', ['state', 'tags']))
    t.true(carried.length * 5 < whole.length, `a page of fifty is ${carried.length} bytes against ${whole.length} for the record`)
    t.false(carried.includes('tag.050'), 'and nothing beyond the page travels')

    await client.close()
    await server.close()
})

test('turning a page is one call, and the keys keep a stable order across it', async (t) => {
    const server = new RpcServer({ name: peer('field3921'), transports: [{ port: 3921, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3921', { name: peer('asker3921'), defaultTarget: peer('field3921') })
    const field = await client.proxy<FieldProxy>('field')

    const first = await field.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 10 } })
    const second = await field.$data('getList', ['state', 'tags'], { pagination: { page: 1, pageSize: 10 } })

    t.is(first.ids[0], 'tag.000')
    t.is(second.ids[0], 'tag.010', 'page one begins where page zero stopped')
    t.is(second.ids[9], 'tag.019')
    t.is(second.total, 300, 'and the count does not change under paging')

    // Sorted contractually rather than by insertion, because insertion order is a property of how
    // the component happened to build its state: after a restart that populated the record in
    // another sequence, page two could hold something else and a paging caller would see one entry
    // twice and another never, with nothing to indicate it.
    t.deepEqual([...first.ids].sort(), [...first.ids])
    t.is(new Set([...first.ids, ...second.ids]).size, 20, 'so two pages never overlap')

    await client.close()
    await server.close()
})

test('a pageSize of zero is a count, which is the cheapest question there is', async (t) => {
    const server = new RpcServer({ name: peer('field3922'), transports: [{ port: 3922, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3922', { name: peer('asker3922'), defaultTarget: peer('field3922') })
    const field = await client.proxy<FieldProxy>('field')

    // How many pages are there, without fetching any of them. Stated rather than accidental: a
    // caller deciding whether to page at all should not have to pay for a page to find out.
    const count = await field.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 0 } })
    t.is(count.total, 300)
    t.is(count.ids.length, 0)
    t.is(count.data.length, 0)
    t.false(JSON.stringify(count).includes('tag.'), 'not one key travels')

    await client.close()
    await server.close()
})

test('a page past the end is empty with the true total, where a bad page is refused', async (t) => {
    const server = new RpcServer({ name: peer('field3923'), transports: [{ port: 3923, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3923', { name: peer('asker3923'), defaultTarget: peer('field3923') })
    const field = await client.proxy<FieldProxy>('field')

    // A race the caller cannot avoid: the set is data, so a page that was valid when the operator
    // clicked may be past the end by the time the request lands. Erroring on that would make a link
    // fail more the slower it got.
    const beyond = await field.$data('getList', ['state', 'tags'], { pagination: { page: 99, pageSize: 50 } })
    t.is(beyond.ids.length, 0)
    t.is(beyond.total, 300, 'and it still says where the end is, so a caller can go back to it')

    // A caller holding it wrong, which is a different thing and gets a different answer. Quietly
    // reading -1 as zero would serve a page nobody asked for with no way to notice.
    const negative = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { pagination: { page: -1, pageSize: 50 } }))
    t.regex(String(negative?.message), /non-negative integer/)

    // A page number with nothing to measure it in would otherwise answer the whole collection,
    // which is the one failure this interface exists to prevent.
    const unmeasured = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { pagination: { page: 2 } }))
    t.regex(String(unmeasured?.message), /needs a pageSize/)

    await client.close()
    await server.close()
})

test('a resource that is not a collection is an empty list, not an error', async (t) => {
    const server = new RpcServer({ name: peer('field3924'), transports: [{ port: 3924, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3924', { name: peer('asker3924'), defaultTarget: peer('field3924') })
    const field = await client.proxy<FieldProxy>('field')

    // The rule the projection already set: state is data, and a collection a caller expects may
    // simply not have been populated yet. Refusing would make this less robust than the whole
    // snapshot it replaces - and a caller that named the wrong path sees an empty table rather
    // than data quietly lost.
    for (const resource of [['state', 'fast'], ['state', 'nothing'], ['somewhere', 'else']]) {
        const empty = await field.$data('getList', resource)
        t.is(empty.total, 0, `${resource.join('.')} holds no collection`)
        t.is(empty.ids.length, 0)
    }

    // A verb that is not served says so, naming what is, rather than answering something plausible.
    const later = await t.throwsAsync(field.$data('getOne' as 'getList', ['state', 'tags']))
    t.regex(String(later?.message), /is not served here/)
    t.regex(String(later?.message), /getList, getMany, getManyReference/, 'and the refusal is the list of what to reach for')

    await client.close()
    await server.close()
})

test('a filter runs where the data is, so one that matches nothing sends nothing', async (t) => {
    const server = new RpcServer({ name: peer('field3926'), transports: [{ port: 3926, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3926', { name: peer('asker3926'), defaultTarget: peer('field3926') })
    const field = await client.proxy<FieldProxy>('field')

    // The query a plant screen is actually for, and the one no client-side filter can answer: which
    // of the three hundred are bad. Finding out is exactly what a local filter would have to receive
    // all three hundred to discover.
    const bad = await field.$data('getList', ['state', 'tags'], { filter: { field: 'quality', op: 'eq', operand: 'bad' }, pagination: { page: 0, pageSize: 50 } })
    t.is(bad.total, 30, 'total is the count of matches, which is what a pager needs')
    t.is(bad.ids.length, 30)
    t.is(bad.ids[0], 'tag.000')
    t.is(bad.ids[1], 'tag.010')
    t.true(bad.data.every((row) => (row as { quality: string }).quality === 'bad'))

    // The property the whole design turns on, and the only one measurable from here.
    const nothing = await field.$data('getList', ['state', 'tags'], { filter: { field: 'id', op: 'startsWith', operand: 'nosuch' } })
    t.is(nothing.total, 0)
    t.is(nothing.ids.length, 0)
    t.true(JSON.stringify(nothing).length < 120, 'a search that found nothing costs a sentence, not a record')

    // Searching the tag names, which is what the console's filter box compiles to.
    const named = await field.$data('getList', ['state', 'tags'], { filter: { field: 'id', op: 'contains', operand: '.05' } })
    t.is(named.total, 10, 'tag.050 through tag.059')
    t.is(named.ids[0], 'tag.050')

    // A field a row does not have never matches, rather than matching as undefined - otherwise
    // `contains: 'undef'` would find every row in the collection.
    const absent = await field.$data('getList', ['state', 'tags'], { filter: { field: 'nope', op: 'contains', operand: 'undef' } })
    t.is(absent.total, 0)

    await client.close()
    await server.close()
})

test('conditions combine, and the filter is applied before the page is cut', async (t) => {
    const server = new RpcServer({ name: peer('field3927'), transports: [{ port: 3927, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3927', { name: peer('asker3927'), defaultTarget: peer('field3927') })
    const field = await client.proxy<FieldProxy>('field')

    const both = await field.$data('getList', ['state', 'tags'], {
        filter: { all: [{ field: 'quality', op: 'eq', operand: 'bad' }, { field: 'value', op: 'gte', operand: 200 }] }
    })
    t.is(both.total, 10, 'the ten bad tags at or above 200')

    const either = await field.$data('getList', ['state', 'tags'], {
        filter: { any: [{ field: 'id', op: 'eq', operand: 'tag.001' }, { field: 'id', op: 'eq', operand: 'tag.002' }] }
    })
    t.deepEqual([...either.ids], ['tag.001', 'tag.002'])

    // Filtered first, then paged - a filter applied after paging would be a filter over fifty rows
    // pretending to be one over three hundred, which is a wrong answer that looks right.
    const firstPage = await field.$data('getList', ['state', 'tags'], {
        filter: { field: 'quality', op: 'eq', operand: 'bad' },
        pagination: { page: 0, pageSize: 4 }
    })
    t.deepEqual([...firstPage.ids], ['tag.000', 'tag.010', 'tag.020', 'tag.030'])
    t.is(firstPage.total, 30, 'and the pager still knows there are thirty')

    // An ordered comparison across kinds answers false rather than inventing an order, because
    // `20 > '9'` having any answer at all is how a threshold silently stops working.
    const mismatched = await field.$data('getList', ['state', 'tags'], { filter: { field: 'value', op: 'gt', operand: '100' } })
    t.is(mismatched.total, 0)

    await client.close()
    await server.close()
})

test('an order is over the matched set, and a malformed one is refused', async (t) => {
    const server = new RpcServer({ name: peer('field3928'), transports: [{ port: 3928, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3928', { name: peer('asker3928'), defaultTarget: peer('field3928') })
    const field = await client.proxy<FieldProxy>('field')

    const highest = await field.$data('getList', ['state', 'tags'], { sort: { field: 'value', order: 'DESC' }, pagination: { page: 0, pageSize: 3 } })
    t.deepEqual([...highest.ids], ['tag.299', 'tag.298', 'tag.297'])

    // Ties fall back to key order, so a sort on a field most rows share does not shuffle between
    // requests and hand the operator the same row on two pages.
    const byQuality = await field.$data('getList', ['state', 'tags'], { sort: { field: 'quality' }, pagination: { page: 0, pageSize: 3 } })
    t.deepEqual([...byQuality.ids], ['tag.000', 'tag.010', 'tag.020'], 'the bad ones first, in key order among themselves')

    // Checked rather than coerced, like every other bound here: a filter built wrongly that quietly
    // matched nothing would look exactly like a filter that worked and found no rows.
    const badOp = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { filter: { field: 'id', op: 'matches' as 'eq', operand: 'x' } }))
    t.regex(String(badOp?.message), /is not a comparison/)

    const badOperand = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { filter: { field: 'id', op: 'eq', operand: {} as unknown as string } }))
    t.regex(String(badOperand?.message), /operand is a string, number, boolean or null/)

    const badOrder = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { sort: { order: 'sideways' as 'ASC' } }))
    t.regex(String(badOrder?.message), /ASC or DESC/)

    // Depth and size are bounded because this runs on the peer that holds the plant, and a filter
    // nested a thousand deep is a caller holding it wrong rather than a query worth serving.
    let deep: unknown = { field: 'id', op: 'eq', operand: 'x' }
    for (let level = 0; level < 12; level++) deep = { all: [deep] }
    const tooDeep = await t.throwsAsync(field.$data('getList', ['state', 'tags'], { filter: deep as never }))
    t.regex(String(tooDeep?.message), /nested deeper than/)

    await client.close()
    await server.close()
})

/**
 * A component whose collections its contract cannot describe - the shape Source Relational has.
 *
 * Nothing about `customers` is in `props` or `state`, and nothing could be: which tables a store
 * holds is data, discovered when the component connects to it. So it says so at runtime, and the
 * same `$data` verb reaches it.
 */
@rpcNamespace('store')
class Store extends RpcComponent<{ label: string }, { connected: boolean }> implements RpcDataResources {
    private readonly customers = { c1: { name: 'Acme Ltd' }, c2: { name: 'Borg AB' }, c3: { name: 'Cyberdyne' } }
    /** The many side, each naming its customer - which is what getManyReference is asked about. */
    private readonly orders = {
        o1: { customerId: 'c1', total: 120 },
        o2: { customerId: 'c1', total: 40 },
        o3: { customerId: 'c2', total: 90 },
        o4: { customerId: 'c1', total: 250 }
    }

    constructor() {
        super({ label: 's' }, { connected: true })
    }

    dataResources() {
        return [
            { path: ['customers'], verbs: ['getList', 'getMany'] as const, label: 'Customers', row: { kind: 'object' as const, fields: { name: { type: { kind: 'string' as const } } } } },
            { path: ['orders'], verbs: ['getManyReference'] as const }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: readonly string[], params: RpcGetListParams | RpcGetManyParams) {
        // The many side, answered with the library's own paging so it cannot drift from the one
        // side beside it - the reference is a condition, and everything after it is a list.
        if (resource[0] === 'orders') {
            const reference = params as RpcGetManyReferenceParams
            const entries = Object.entries(this.orders).filter(([, order]) => order.customerId === reference.id)
            return { ...pageEntries(entries, reference), epoch: 'store', revision: 1 }
        }
        const row = (id: string) => this.customers[id as keyof typeof this.customers]
        if (method === 'getMany') {
            const ids = (params as RpcGetManyParams).ids.filter(row)
            return { ids, data: ids.map(row), epoch: 'store', revision: 1 }
        }
        const ids = Object.keys(this.customers).slice(0, (params as RpcGetListParams).pagination?.pageSize ?? undefined)
        return { ids, data: ids.map(row), total: 3, epoch: 'store', revision: 1 }
    }
}

test('a component may serve collections its contract cannot describe', async (t) => {
    const server = new RpcServer({ name: peer('store3929'), transports: [{ port: 3929, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Store())
    await server.ready()

    const client = new RpcClient('http://localhost:3929', { name: peer('asker3929'), defaultTarget: peer('store3929') })

    // describe() carries what exists and the shape of a row, never a row - the same rule the props
    // and state types follow, one level up. A viewer that has never heard of this component can
    // draw its columns from this alone.
    const description = await (await client.proxy<Introspection>('msgrpc')).describe()
    const store = description.namespaces.find((namespace) => namespace.name === 'store')
    t.deepEqual(
        store?.component?.resources?.map((resource) => resource.path.join('.')),
        ['customers', 'orders']
    )
    t.is(store?.component?.resources?.[0].label, 'Customers')
    t.is(store?.component?.resources?.[0].row?.kind, 'object')

    // And the same verb reaches it, answered by the component rather than from its state.
    const proxy = await client.proxy<RpcComponentProxy<Store>>('store')
    const page = await proxy.$data('getList', ['customers'], { pagination: { page: 0, pageSize: 2 } })
    t.deepEqual([...page.ids], ['c1', 'c2'])
    t.deepEqual(page.data[0], { name: 'Acme Ltd' })
    t.is(page.total, 3)

    // A verb the resource does not claim is refused by name rather than attempted, since the verb
    // list is what a viewer offers from and would otherwise be decoration.
    const wrong = await t.throwsAsync(proxy.$data('getList', ['orders']))
    t.regex(String(wrong?.message), /answers getManyReference, not getList/)

    // And the verbs it does claim reach it, through the one hook shaped like the wire verb.
    const named = await proxy.$data('getMany', ['customers'], { ids: ['c3', 'c1'] })
    t.deepEqual([...named.ids], ['c3', 'c1'])
    t.deepEqual(named.data[0], { name: 'Cyberdyne' })

    // The relational shape across two resources, which is the whole reason for taking this
    // interface rather than inventing a query one: the orders belonging to this customer, paged
    // and counted like any other list, with no new mechanism at all.
    const theirs = await proxy.$data('getManyReference', ['orders'], { target: 'customerId', id: 'c1' })
    t.is(theirs.total, 3)
    t.deepEqual([...theirs.ids], ['o1', 'o2', 'o4'])
    t.deepEqual(theirs.data[0], { customerId: 'c1', total: 120 })

    // A path the component did not declare still falls through to its state, which is what keeps an
    // ordinary component working without implementing anything - and what stops a component that
    // serves resources from losing access to its own.
    const fromState = await proxy.$data('getList', ['state'])
    t.deepEqual([...fromState.ids], ['connected'], 'served from the state by the base class, not by dataList')
    t.is(fromState.total, 1)

    await client.close()
    await server.close()
})

test('getMany answers rows a caller already named, in one call rather than one each', async (t) => {
    const server = new RpcServer({ name: peer('field3930'), transports: [{ port: 3930, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3930', { name: peer('asker3930'), defaultTarget: peer('field3930') })
    const field = await client.proxy<FieldProxy>('field')

    const some = await field.$data('getMany', ['state', 'tags'], { ids: ['tag.007', 'tag.001', 'tag.299'] })
    t.deepEqual([...some.ids], ['tag.007', 'tag.001', 'tag.299'], 'in the order asked, so a caller need not re-sort them')
    t.deepEqual(some.data[0], { value: 7, unit: '°C', quality: 'good' })

    // Absent rather than null, so "this row is gone" and "this row has no value" stay different
    // answers - one of them means a reference is dangling, which is worth being able to see.
    const partly = await field.$data('getMany', ['state', 'tags'], { ids: ['tag.002', 'nosuchtag'] })
    t.deepEqual([...partly.ids], ['tag.002'])
    t.is(partly.data.length, 1)

    // The reason it is plural. Fifty rows naming fifty customers is one call and one envelope here,
    // where fifty getOnes would be fifty of each - and on MQTT fifty exchanges as well.
    const fifty = Array.from({ length: 50 }, (_, index) => `tag.${String(index).padStart(3, '0')}`)
    const batch = await field.$data('getMany', ['state', 'tags'], { ids: fifty })
    t.is(batch.ids.length, 50)

    // Bounded, because this arrives from the network: ten thousand ids in one frame is a caller
    // that meant to page instead.
    const flood = await t.throwsAsync(field.$data('getMany', ['state', 'tags'], { ids: Array.from({ length: 1001 }, (_, index) => String(index)) }))
    t.regex(String(flood?.message), /bounded at 1000 ids/)

    const empty = await t.throwsAsync(field.$data('getMany', ['state', 'tags'], { ids: [] }))
    t.regex(String(empty?.message), /non-empty array of string ids/)

    await client.close()
    await server.close()
})

test('the page is stamped with where it came from, so a restart is visible', async (t) => {
    const server = new RpcServer({ name: peer('field3925'), transports: [{ port: 3925, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3925', { name: peer('asker3925'), defaultTarget: peer('field3925') })
    const field = await client.proxy<FieldProxy>('field')
    const observed = await client.component<Field>('field')

    const before = await field.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 5 } })
    await field.tick()
    const after = await field.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 5 } })

    t.is(before.epoch, after.epoch, 'the same component, so the same epoch')
    t.true(after.revision > before.revision, 'and a revision that moved, so a pull can be told from a stale one')
    // The same epoch the subscription reports, which is what lets a polled page and a subscribed
    // leaf be compared at all rather than merely coexist.
    t.is(after.epoch, observed[rpcComponent].getSnapshot().epoch)

    await observed[rpcComponent].close()
    await client.close()
    await server.close()
})

test('getManyReference is getList with the join already in hand', async (t) => {
    const server = new RpcServer({ name: peer('field3931'), transports: [{ port: 3931, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3931', { name: peer('asker3931'), defaultTarget: peer('field3931') })
    const field = await client.proxy<FieldProxy>('field')

    // Every row of this resource whose `quality` names that one. Structurally a foreign key, and
    // served as `getList` with an `eq` on the filter rather than as a second implementation - so
    // paging, ordering and the count of matches are identical by construction.
    const bad = await field.$data('getManyReference', ['state', 'tags'], { target: 'quality', id: 'bad', pagination: { page: 0, pageSize: 4 } })
    t.is(bad.total, 30, 'the count of referencing rows, which is what a pager under a record needs')
    t.deepEqual([...bad.ids], ['tag.000', 'tag.010', 'tag.020', 'tag.030'])

    // A caller's own filter narrows further rather than replacing the reference - the two are and-ed,
    // so a search inside a one-to-many cannot accidentally widen it back to the whole resource.
    const narrowed = await field.$data('getManyReference', ['state', 'tags'], { target: 'quality', id: 'bad', filter: { field: 'value', op: 'gte', operand: 200 } })
    t.is(narrowed.total, 10)
    t.true(narrowed.ids.every((id) => id >= 'tag.200'))

    // And it orders like any other list, over the referencing set rather than over a page of it.
    const highest = await field.$data('getManyReference', ['state', 'tags'], { target: 'quality', id: 'bad', sort: { field: 'value', order: 'DESC' }, pagination: { page: 0, pageSize: 1 } })
    t.deepEqual([...highest.ids], ['tag.290'])

    const noTarget = await t.throwsAsync(field.$data('getManyReference', ['state', 'tags'], { target: '', id: 'bad' }))
    t.regex(String(noTarget?.message), /needs a target field/)

    await client.close()
    await server.close()
})
