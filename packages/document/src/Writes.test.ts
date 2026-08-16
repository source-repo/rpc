import { rowStamp, type RpcRowRead, type RpcWriteOutcome } from '@source-repo/rpc'
import anyTest, { type ExecutionContext, type TestFn } from 'ava'
import { randomUUID } from 'node:crypto'
import type { CollectionInfo, DocumentCatalogue } from './Catalogue.js'
import { fixture, MONGO_URL, type MongoFixture } from './Fixture.js'
import { DocumentWriteService } from './WriteService.js'
import { guardFor, resolveWrites, stampFields } from './Writes.js'

/**
 * The write half, asked the questions that decide whether it is safe rather than whether it works.
 *
 * "Works" is one test: a document goes in and comes back out. Everything else here is a refusal,
 * because a write surface is defined by what it will not do - and every one of these refusals is a
 * specific way a permission document, a stale precondition or a well-formed but wrong value could
 * otherwise have reached somebody else's database.
 *
 * **Some of it runs without a server and the rest cannot.** There is no in-memory MongoDB, so a
 * laptop with no container skips most of this file - which is right, and is exactly why
 * `SOURCE_RPC_REQUIRE_MONGO` exists and why CI sets it. The questions that need no store at all -
 * what a malformed permission document does, and what a rule naming something impossible resolves to
 * - are asked without one deliberately, so that this file can never report itself green having run
 * nothing whatsoever.
 */

const run = randomUUID().replace(/-/g, '').slice(0, 10)

interface Context {
    held?: MongoFixture
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    try {
        const held = await fixture(run)
        const service = new DocumentWriteService({ db: held.db })
        await service.refresh()
        t.context = { held, skipped: false }
    } catch (failure) {
        if (process.env.SOURCE_RPC_REQUIRE_MONGO)
            throw new Error(`SOURCE_RPC_REQUIRE_MONGO is set, but no MongoDB answered at ${MONGO_URL} - these tests must not be skipped here`, { cause: failure })
        t.context = { skipped: true }
    }
})

test.after.always(async (t) => {
    await t.context?.held?.close()
})

/** True where there is nothing to test against, having said so once. */
const without = (t: { context: Context; pass: (message?: string) => void }) => {
    if (t.context.skipped) {
        t.pass('no MongoDB reachable, skipped - docker compose -f docker-compose/docker-compose.yml up -d mongo')
        return true
    }
    return false
}

const permissive = {
    customers: { verbs: ['create', 'update', 'delete'] as const, columns: ['id', 'name', 'city', 'active', 'balance'] },
    sites: { verbs: ['update'] as const, columns: ['label'] }
}

let nth = 0

/**
 * A node over a database of its own, dropped when the test ends.
 *
 * A database each rather than a collection each, because these tests write: one that changed
 * `customers/1` under another would be a flake that appears only when the two happen to interleave,
 * which is the kind that gets re-run rather than read. `over` shares one where two nodes looking at
 * the same documents through different rules is the actual question.
 */
const writer = async (t: ExecutionContext<Context>, writes: unknown = permissive, over?: MongoFixture) => {
    const held = over ?? (await fixture(`${run}x${++nth}`))
    if (!over) t.teardown(() => held.close())
    const node = new DocumentWriteService({ db: held.db, writes: writes as never })
    await node.refresh()
    return { node, held }
}

const ok = (outcome: RpcWriteOutcome) => {
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`)
    return outcome
}

const read = (row: RpcRowRead) => {
    if (row.status !== 'ok') throw new Error('expected the document to be there')
    return { stamp: row.stamp, row: row.row as Record<string, unknown> }
}

/** A catalogue built by hand, so what `resolveWrites` does can be asked without a database. */
const catalogueOf = (...names: readonly string[]): DocumentCatalogue => {
    const collections: CollectionInfo[] = names.map((name) => ({ name, idKind: 'number', shape: 'sampled', sampled: 4 }))
    return { collections, byName: new Map(collections.map((one) => [one.name, one])) }
}

test('a malformed document refuses the node rather than being read as granting nothing', (t) => {
    t.throws(() => new DocumentWriteService({ db: undefined as never, writes: { customers: { verbs: [] } } as never }), { message: /at least one of create, update, delete/ })
    t.throws(() => new DocumentWriteService({ db: undefined as never, writes: { customers: { verbs: ['update'] } } as never }), { message: /columns: required/ })
    t.throws(() => new DocumentWriteService({ db: undefined as never, writes: { customers: { verbs: ['delete'], columns: ['name'] } } as never }), {
        message: /only create and update write fields/
    })
    t.throws(() => new DocumentWriteService({ db: undefined as never, writes: { customers: { verbs: ['drop'] } } as never }), { message: /is not a verb this library defines/ })
})

test('a rule naming something impossible is refused, whole, and reported', (t) => {
    const { writable, refused } = resolveWrites(catalogueOf('customers', 'orders', 'nested', 'both', 'sites'), {
        custmers: { verbs: ['update'], columns: ['name'] },
        customers: { verbs: ['update'], columns: ['name', '$where'] },
        orders: { verbs: ['update'], columns: ['a..b'] },
        nested: { verbs: ['update'], columns: ['a.b.c.d.e.f.g.h.i.j'] },
        both: { verbs: ['update'], columns: ['id', '_id'] },
        sites: { verbs: ['update'], columns: ['id', 'label'] }
    } as never)
    const reasons = Object.fromEntries(refused.map((one) => [one.resource, one.reason]))
    t.regex(reasons.custmers, /not a collection this node serves/)
    // Dropped whole rather than narrowed to `name` - the person who wrote it believed something
    // false about that collection, and the next line may be wrong in a way this cannot see.
    t.regex(reasons.customers, /an operator rather than a field/)
    t.regex(reasons.orders, /empty path segment/)
    t.regex(reasons.nested, /the most this node will follow/)
    t.regex(reasons.both, /another spelling/)
    t.deepEqual([...writable.keys()], ['sites'], 'only the rule that resolved survives')
    // And `id` means the document's identity whatever it is stored under, which here is always `_id`.
    t.deepEqual([...writable.get('sites')!.fields], ['_id', 'label'])
})

test('a field the rule names is *not* checked against the collection, and that difference is the point', (t) => {
    // The SQL node refuses a rule naming a column its table does not have. There is nothing to check
    // against here: a field exists on the documents that happen to have it, and sampling can prove a
    // field is there but never that it is not. So a well-formed name resolves, and the allow-list
    // plus the stamp are what remain doing the work.
    const { writable, refused } = resolveWrites(catalogueOf('customers'), { customers: { verbs: ['update'], columns: ['nobodyHasThis'] } } as never)
    t.deepEqual([...refused], [])
    t.deepEqual([...writable.get('customers')!.fields], ['nobodyHasThis'])
})

test('the guard pins an absent field to being absent, which is a state like any other', (t) => {
    const { writable } = resolveWrites(catalogueOf('sparse'), { sparse: { verbs: ['update'], columns: ['city', 'label', 'address.city'] } } as never)
    const resolved = writable.get('sparse')!
    const document = { _id: 'a', label: 'x', address: { city: 'Berlin' } }

    // `{ city: null }` would not do it: that matches a document missing the field as well as one
    // holding an explicit null, and telling those apart is the one thing a guard has to do.
    t.deepEqual(guardFor(resolved, document) as Record<string, unknown>, { city: { $exists: false }, label: 'x', 'address.city': 'Berlin' })
    t.deepEqual(
        stampFields(resolved, document).map(([name, value]) => [name, value]),
        [
            ['city', undefined],
            ['label', 'x'],
            ['address.city', 'Berlin']
        ]
    )
})

test('a node with no permission document writes nothing, and says what it does not have', async (t) => {
    if (without(t)) return
    const { node } = await writer(t, {})
    t.is(node.props.writable, 0)
    t.is(node.elevation(), undefined, 'a node that can do nothing announces nothing')
    await t.throwsAsync(node.create('customers', { name: 'x' }), { message: /accepts no writes at all/ })
})

test('a document is created, changed and removed, each under the stamp it was read at', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)

    const made = ok(await node.create('customers', { id: 99, name: 'Newco', city: 'Lund', active: true, balance: 1.5 }))
    t.is(made.id, '99')
    t.truthy(made.stamp, 'a create answers the stamp of what it made, so the next edit needs no read')

    const changed = ok(await node.update('customers', made.id, { city: 'Malmo' }, made.stamp!))
    t.not(changed.stamp, made.stamp, 'the stamp moves when the document does')

    const now = read(await node.getOne('customers', made.id))
    t.is(now.row.city, 'Malmo')
    t.is(now.stamp, changed.stamp!, 'the stamp an update answers is the one a fresh read produces')

    t.is((await node.delete('customers', made.id, changed.stamp!)).status, 'ok')
    t.is((await node.getOne('customers', made.id)).status, 'missing')

    t.is(node.state.created, 1)
    t.is(node.state.updated, 1)
    t.is(node.state.deleted, 1)
})

test('a stale stamp is a conflict, and the conflict carries nothing to retry with', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    const first = read(await node.getOne('customers', '1'))

    ok(await node.update('customers', '1', { city: 'Hamburg' }, first.stamp))
    const stale = await node.update('customers', '1', { city: 'Bremen' }, first.stamp)

    t.is(stale.status, 'conflict')
    // The whole point: a blind overwrite must not be one call away, so nothing usable as a
    // precondition comes back with the refusal.
    t.false('stamp' in stale)
    t.is(read(await node.getOne('customers', '1')).row.city, 'Hamburg', 'and nothing was written')
    t.is(node.state.conflicts, 1)
})

test('the guard stops matching the moment the document moves, which is what the service turns into a conflict', async (t) => {
    if (without(t)) return
    const { held } = await writer(t)
    const source = held.db.collection('sparse')
    await source.insertMany([
        { _id: 'has' as unknown as never, city: 'Berlin' },
        { _id: 'none' as unknown as never, label: 'x' }
    ])
    const resolved = resolveWrites(catalogueOf('sparse'), { sparse: { verbs: ['update'], columns: ['city'] } } as never).writable.get('sparse')!

    // The window this closes is inside one call - the node reads, compares the stamp, and writes -
    // so it cannot be opened from out here without reaching into the node. What can be asked from
    // out here is the property the whole precondition rests on: a guard taken from one state of a
    // document matches that state and no other, at the instant the server applies the write. A
    // `matchedCount` of nothing is what `update` answers `conflict` to, and without it the stamp
    // comparison would be advisory - two callers could both find the stamp they expected and both
    // write.
    const before = (await source.findOne({ _id: 'has' as unknown as never }))!
    await source.updateOne({ _id: 'has' as unknown as never }, { $set: { city: 'Malmo' } })
    const stale = await source.updateOne({ ...guardFor(resolved, before), _id: 'has' as unknown as never }, { $set: { city: 'Hamburg' } })
    t.is(stale.matchedCount, 0, 'nothing to write to: this is no longer the document that was read')
    t.is((await source.findOne({ _id: 'has' as unknown as never }))!.city, 'Malmo', 'and the other edit is intact')

    // And absent is pinned as a state rather than left out of the guard, so a document that has
    // since acquired a value there is not written over either - which is the case `{ city: null }`
    // would have got wrong, since that matches a missing field as well as an explicit null.
    const empty = (await source.findOne({ _id: 'none' as unknown as never }))!
    t.is((await source.updateOne({ ...guardFor(resolved, empty), _id: 'none' as unknown as never }, { $set: { city: 'Lund' } })).matchedCount, 1)
    await source.updateOne({ _id: 'none' as unknown as never }, { $unset: { city: '' } })
    await source.updateOne({ _id: 'none' as unknown as never }, { $set: { city: null } })
    t.is((await source.updateOne({ ...guardFor(resolved, empty), _id: 'none' as unknown as never }, { $set: { city: 'Lund' } })).matchedCount, 0, 'an explicit null is not the absence it replaced')
})

test('a stamp covers the writable fields and nothing else', async (t) => {
    if (without(t)) return
    // Two rules over one database, which is the sharper form of the question: `city` is outside the
    // narrow rule, so a change to it must not invalidate a stamp that rule is about to use. A
    // precondition that fails because something touched a field nobody may write is one that fails
    // for a reason nobody can act on, and one of those gets switched off within a week.
    const { node: narrow, held } = await writer(t, { customers: { verbs: ['update'], columns: ['balance'] } })
    const { node: wide } = await writer(t, permissive, held)

    const before = read(await narrow.getOne('customers', '1'))
    ok(await wide.update('customers', '1', { city: 'Somewhere else' }, read(await wide.getOne('customers', '1')).stamp))

    t.is(read(await narrow.getOne('customers', '1')).stamp, before.stamp, 'a field outside the rule moving is not a conflict')
    t.not(read(await wide.getOne('customers', '1')).stamp, before.stamp, 'and a wider rule stamps more of the document')
})

test('a field nobody may write is refused rather than dropped', async (t) => {
    if (without(t)) return
    const { node } = await writer(t, { customers: { verbs: ['update'], columns: ['city'] } })
    const row = read(await node.getOne('customers', '1'))
    // Silently ignoring `balance` would be a change the caller believes it made.
    await t.throwsAsync(node.update('customers', '1', { city: 'Lund', balance: 999 }, row.stamp), { message: /balance is not writable on customers - this node writes city/ })
    t.is(read(await node.getOne('customers', '1')).row.city, 'Berlin', 'and the permitted half was not applied either')
})

test('a document cannot rename itself, even where its id is creatable', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    const row = read(await node.getOne('customers', '1'))
    await t.throwsAsync(node.update('customers', '1', { id: 99 }, row.stamp), { message: /is the id of customers/ })
    // And the same field is accepted by create, which is why it is in the allow-list at all.
    t.is(ok(await node.create('customers', { id: 77, name: 'Explicit' })).id, '77')
})

test('a value is checked for what a document can hold, and deliberately not for what kind it is', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    const row = read(await node.getOne('customers', '1'))

    await t.throwsAsync(node.update('customers', '1', { balance: undefined }, row.stamp), { message: /was given no value/ })
    await t.throwsAsync(node.update('customers', '1', {}, row.stamp), { message: /no fields to change/ })
    // Nothing that would come back as something other than what was sent: the stamp would then
    // describe a document the caller never wrote.
    await t.throwsAsync(node.update('customers', '1', { balance: 10n }, row.stamp), { message: /was given a bigint/ })
    await t.throwsAsync(node.update('customers', '1', { balance: () => 1 }, row.stamp), { message: /not a value a document can hold/ })
    // And nothing this node could write and then never read back: `fieldFor` refuses a path segment
    // beginning with `$` or holding a dot, so a value carrying one would be a field beyond the reach
    // of every filter this package builds.
    await t.throwsAsync(node.update('customers', '1', { name: { $ne: 1 } }, row.stamp), { message: /reads as an operator rather than a name/ })
    await t.throwsAsync(node.update('customers', '1', { name: { 'a.b': 1 } }, row.stamp), { message: /holds a dot/ })

    // The SQL node refuses this, and refusing it is right there: a column declared numeric that is
    // handed `'80'` stores something wrong and reports nothing. There is no declaration here to
    // refuse against - a collection's shape is a sample as often as it is a validator, and neither
    // is a promise about what may be written - so the write lands, which is the capability
    // difference stated as a test rather than left to be discovered.
    ok(await node.update('customers', '1', { balance: 'eighty' }, row.stamp))
    t.is(read(await node.getOne('customers', '1')).row.balance, 'eighty')
})

test('a verb a collection does not answer is refused, naming the ones it does', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    await t.throwsAsync(node.create('sites', { label: 'West plant' }), { message: /sites does not answer create - it answers update/ })
    await t.throwsAsync(node.delete('sites', 'north', 'whatever'), { message: /does not answer delete/ })
})

test('a write against a document that is gone is missing rather than a failure', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    t.is((await node.update('customers', '404', { city: 'Nowhere' }, 'any-stamp')).status, 'missing')
    t.is((await node.delete('customers', '404', 'any-stamp')).status, 'missing')
    t.is(node.state.missing, 2)
    t.is(node.state.failures, 0, 'a document that is not there is a fact about the store, not a fault')
})

test('a precondition is required, not merely available', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    await t.throwsAsync(node.update('customers', '1', { city: 'x' }, '' as never), { message: /needs the stamp the row was read under/ })
    await t.throwsAsync(node.delete('customers', '1', undefined as never), { message: /needs the stamp the row was read under/ })
})

test('a stamp names one document of one collection and cannot be carried to another', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    const one = read(await node.getOne('customers', '1'))
    const two = read(await node.getOne('customers', '2'))
    t.not(one.stamp, two.stamp)
    t.is((await node.update('customers', '2', { city: 'Elsewhere' }, one.stamp)).status, 'conflict')
})

test('the stamp is over the document as it goes on the wire, not as the driver returned it', async (t) => {
    if (without(t)) return
    const { node, held } = await writer(t, { generated: { verbs: ['update'], columns: ['id', 'label'] } })
    await held.db.collection('generated').insertOne({ label: 'a' })
    await node.refresh()

    const id = (await held.db.collection('generated').findOne({}))!._id.toHexString()
    const { stamp } = read(await node.getOne('generated', id))
    // An ObjectId is a BSON object to the driver and a hex string on the wire. Digesting the first
    // would make one document's stamp depend on which path it arrived by, so a caller that read it
    // through one and wrote it through the other would be refused for no reason at all.
    t.is(
        stamp,
        await rowStamp('generated', id, [
            ['_id', id],
            ['label', 'a']
        ])
    )
})

test('what the node may write is published, so a caller need not find out by being refused', async (t) => {
    if (without(t)) return
    const { node } = await writer(t)
    const writable = await node.writable()
    t.deepEqual(
        writable.map((one) => one.resource),
        ['customers', 'sites']
    )
    const customers = writable.find((one) => one.resource === 'customers')!
    t.deepEqual([...customers.verbs], ['create', 'delete', 'update'])
    t.deepEqual([...customers.columns], ['_id', 'name', 'city', 'active', 'balance'])
    // No row shape, unlike the SQL node: a collection declares nothing that says what `create`
    // accepts, and a form drawn from a sampled shape would offer whichever fields happened to be
    // popular in twenty documents. The read half publishes the shape with its provenance attached,
    // which is the only honest way to hand one over.
    t.is(customers.row, undefined)
    t.regex(node.elevation()!.reason!, /customers \(create\/delete\/update\)/)
})

test('a collection nobody may write has no stamp to be had either', async (t) => {
    if (without(t)) return
    const { node } = await writer(t, { sites: { verbs: ['update'], columns: ['label'] } })
    await t.throwsAsync(node.getOne('customers', '1'), { message: /customers is not writable on this node - it accepts writes to sites/ })
})
