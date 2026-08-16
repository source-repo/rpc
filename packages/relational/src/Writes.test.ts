import { rowStamp, validateWritePermissions, type RpcRowRead, type RpcWriteOutcome } from '@source-repo/rpc'
import test from 'ava'
import { fixture } from './Fixture.js'
import { RelationalWriteService } from './WriteService.js'

/**
 * The write half, asked the questions that decide whether it is safe rather than whether it works.
 *
 * "Works" is one test: a row goes in and comes back out. Everything else here is a refusal, because
 * a write surface is defined by what it will not do - and every one of these refusals is a specific
 * way a permission document, a stale precondition or a well-formed but wrong value could otherwise
 * have reached somebody else's database.
 */

const permissive = {
    customers: { verbs: ['create', 'update', 'delete'] as const, columns: ['id', 'name', 'city', 'active', 'balance'] },
    sites: { verbs: ['update'] as const, columns: ['label'] }
}

const service = async (writes: Parameters<typeof validateWritePermissions>[0] = permissive) => {
    const db = await fixture()
    const node = new RelationalWriteService({ db, flavour: 'sqlite', writes: writes as never })
    await node.refresh()
    return node
}

const ok = (outcome: RpcWriteOutcome) => {
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`)
    return outcome
}

const read = (row: RpcRowRead) => {
    if (row.status !== 'ok') throw new Error('expected the row to be there')
    return { stamp: row.stamp, row: row.row as Record<string, unknown> }
}

test('a node with no permission document writes nothing, and says what it does not have', async (t) => {
    const node = await service({} as never)
    t.is(node.props.writable, 0)
    t.is(node.elevation(), undefined, 'a node that can do nothing announces nothing')
    await t.throwsAsync(node.create('customers', { name: 'x' }), { message: /accepts no writes at all/ })
})

test('a rule naming something the database does not have is refused, whole, and reported', async (t) => {
    const node = await service({
        custmers: { verbs: ['update'], columns: ['name'] },
        customers: { verbs: ['update'], columns: ['name', 'nickname'] },
        tags: { verbs: ['update'], columns: ['tag'] },
        active_customers: { verbs: ['update'], columns: ['name'] },
        sites: { verbs: ['update'], columns: ['label'] }
    } as never)
    const reasons = Object.fromEntries(node.props.refused.map((one) => [one.resource, one.reason]))
    t.regex(reasons.custmers, /not a table this node serves/)
    // Narrowed to three, not to "name" - a rule is honoured whole or dropped whole, because the
    // person who wrote it believed something false about that table.
    t.regex(reasons.customers, /nickname, which is not a column of customers/)
    // The read side already worked out why, so the write side does not invent a second sentence.
    t.regex(reasons.tags, /composite primary key/)
    t.regex(reasons.active_customers, /a view/)
    t.deepEqual(
        (await node.writable()).map((one) => one.resource),
        ['sites'],
        'only the rule that resolved survives'
    )
})

test('a malformed document refuses the node rather than being read as granting nothing', (t) => {
    t.throws(() => new RelationalWriteService({ db: undefined as never, flavour: 'sqlite', writes: { customers: { verbs: [] } } as never }), { message: /at least one of create, update, delete/ })
    t.throws(() => new RelationalWriteService({ db: undefined as never, flavour: 'sqlite', writes: { customers: { verbs: ['update'] } } as never }), {
        message: /columns: required/
    })
    t.throws(() => new RelationalWriteService({ db: undefined as never, flavour: 'sqlite', writes: { customers: { verbs: ['delete'], columns: ['name'] } } as never }), {
        message: /only create and update write fields/
    })
    t.throws(() => new RelationalWriteService({ db: undefined as never, flavour: 'sqlite', writes: { customers: { verbs: ['drop'] } } as never }), { message: /is not a verb this library defines/ })
})

test('a row is created, changed and removed, each under the stamp it was read at', async (t) => {
    const node = await service()

    const made = ok(await node.create('customers', { name: 'Newco', city: 'Lund', active: true, balance: 1.5 }))
    t.truthy(made.id)
    t.truthy(made.stamp, 'a create answers the stamp of what it made, so the next edit needs no read')

    const changed = ok(await node.update('customers', made.id, { city: 'Malmo' }, made.stamp!))
    t.not(changed.stamp, made.stamp, 'the stamp moves when the row does')

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
    const node = await service()
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

test('a stamp covers the writable columns and nothing else', async (t) => {
    // `balance` is writable here and `city` is not, so a change to `city` underneath a caller must
    // not invalidate a stamp it is about to use - the precondition is about what this rule can
    // collide over, not about every column a trigger might touch.
    const node = await service({ customers: { verbs: ['update'], columns: ['balance'] } } as never)
    const before = read(await node.getOne('customers', '1'))
    await node.props // no-op, keeps the read above from being reordered by a reader of this test

    const permissive = await service()
    ok(await permissive.update('customers', '1', { city: 'Somewhere else' }, read(await permissive.getOne('customers', '1')).stamp))

    // Two services over two databases, so this asserts the *rule* rather than the shared row: a
    // stamp over one column and a stamp over five are different digests of the same row.
    const narrow = read(await node.getOne('customers', '1'))
    t.is(narrow.stamp, before.stamp)
    t.not(narrow.stamp, read(await permissive.getOne('customers', '1')).stamp, 'a wider rule stamps more of the row')
})

test('a field nobody may write is refused rather than dropped', async (t) => {
    const node = await service({ customers: { verbs: ['update'], columns: ['city'] } } as never)
    const row = read(await node.getOne('customers', '1'))
    // Silently ignoring `balance` would be a change the caller believes it made.
    await t.throwsAsync(node.update('customers', '1', { city: 'Lund', balance: 999 }, row.stamp), { message: /balance is not writable on customers - this node writes city/ })
    t.is(read(await node.getOne('customers', '1')).row.city, 'Berlin', 'and the permitted half was not applied either')
})

test('a row cannot rename itself, even where its id is creatable', async (t) => {
    const node = await service()
    const row = read(await node.getOne('customers', '1'))
    await t.throwsAsync(node.update('customers', '1', { id: 99 }, row.stamp), { message: /is the id of customers/ })
    // And the same column is accepted by create, which is why it is in the allow-list at all.
    t.is(ok(await node.create('customers', { id: 77, name: 'Explicit' })).id, '77')
})

test('a value is checked rather than converted', async (t) => {
    const node = await service()
    const row = read(await node.getOne('customers', '1'))
    await t.throwsAsync(node.update('customers', '1', { balance: '80' }, row.stamp), { message: /was given a string/ })
    await t.throwsAsync(node.update('customers', '1', { name: 42 }, row.stamp), { message: /was given a number/ })
    await t.throwsAsync(node.update('customers', '1', { name: null }, row.stamp), { message: /cannot be null/ })
    await t.throwsAsync(node.update('customers', '1', { name: undefined }, row.stamp), { message: /was given no value/ })
    await t.throwsAsync(node.update('customers', '1', {}, row.stamp), { message: /no fields to change/ })
})

test('a required column the caller omitted is named here rather than by the driver', async (t) => {
    const node = await service()
    await t.throwsAsync(node.create('customers', { city: 'Berlin' }), { message: /customers requires name/ })
})

test('a verb a table does not answer is refused, naming the ones it does', async (t) => {
    const node = await service()
    await t.throwsAsync(node.create('sites', { label: 'West plant' }), { message: /sites does not answer create - it answers update/ })
    await t.throwsAsync(node.delete('sites', 'north', 'whatever'), { message: /does not answer delete/ })
})

test('a write against a row that is gone is missing rather than a failure', async (t) => {
    const node = await service()
    t.is((await node.update('customers', '404', { city: 'Nowhere' }, 'any-stamp')).status, 'missing')
    t.is((await node.delete('customers', '404', 'any-stamp')).status, 'missing')
    t.is(node.state.missing, 2)
    t.is(node.state.failures, 0, 'a row that is not there is a fact about the store, not a fault')
})

test('a precondition is required, not merely available', async (t) => {
    const node = await service()
    await t.throwsAsync(node.update('customers', '1', { city: 'x' }, '' as never), { message: /needs the stamp the row was read under/ })
    await t.throwsAsync(node.delete('customers', '1', undefined as never), { message: /needs the stamp the row was read under/ })
})

test('a stamp names one row of one table and cannot be carried to another', async (t) => {
    const node = await service()
    const one = read(await node.getOne('customers', '1'))
    const two = read(await node.getOne('customers', '2'))
    t.not(one.stamp, two.stamp)
    t.is((await node.update('customers', '2', { city: 'Elsewhere' }, one.stamp)).status, 'conflict')
})

test('the stamp is over the row as it goes on the wire, not as the driver returned it', async (t) => {
    // SQLite answers a boolean column as 1 and Postgres as `true`. Stamping the raw value would give
    // one row two stamps on two backends, and a conformance run comparing them would be comparing
    // drivers rather than nodes.
    const node = await service()
    const { row, stamp } = read(await node.getOne('customers', '1'))
    t.is(row.active, true)
    t.is(
        stamp,
        await rowStamp('customers', '1', [
            ['id', 1],
            ['name', 'Acme Ltd'],
            ['city', 'Berlin'],
            ['active', true],
            ['balance', 12.5]
        ])
    )
})

test('what the node may write is published, so a caller need not find out by being refused', async (t) => {
    const node = await service()
    const writable = await node.writable()
    t.deepEqual(
        writable.map((one) => one.resource),
        ['customers', 'sites']
    )
    const customers = writable.find((one) => one.resource === 'customers')!
    t.deepEqual([...customers.verbs], ['create', 'delete', 'update'])
    t.deepEqual([...customers.columns], ['id', 'name', 'city', 'active', 'balance'])
    // The id is optional in the shape because SQLite generates one; `name` is not, and a form drawn
    // from this asks for it.
    const fields = (customers.row as { fields: Record<string, { optional?: boolean }> }).fields
    t.true(fields.id.optional)
    t.falsy(fields.name.optional)
    t.regex(node.elevation()!.reason!, /customers \(create\/delete\/update\)/)
})

test('a table nobody may write has no stamp to be had either', async (t) => {
    const node = await service({ sites: { verbs: ['update'], columns: ['label'] } } as never)
    await t.throwsAsync(node.getOne('customers', '1'), { message: /customers is not writable on this node - it accepts writes to sites/ })
})
