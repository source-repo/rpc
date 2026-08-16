import { DATA_QUESTIONS, rowsAgainstDeclaration, stampedFields, WRITE_PERMISSIONS, WRITE_QUESTIONS, type ConformanceCollection, type WriteEnds } from '@source-repo/conformance'
import { rowStamp, type RpcGetListParams, type RpcGetListResult, type RpcGetManyResult, type RpcWritePermissions } from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { randomUUID } from 'node:crypto'
import { DocumentRefusal } from './Filter.js'
import { fixture, MONGO_URL, type MongoFixture } from './Fixture.js'
import { DocumentService } from './Service.js'
import { DocumentWriteService } from './WriteService.js'

/**
 * The document node, asked the same questions the SQL node is asked - and then the ones only a
 * document store raises.
 *
 * Unlike `packages/relational`, **every test here needs a server**: there is no in-memory MongoDB,
 * so nothing in this file can run without one. That makes the guard more load-bearing rather than
 * less - a laptop with no container skips the whole package, which is right, and CI setting
 * `SOURCE_RPC_REQUIRE_MONGO` is the only thing standing between that and a package that is never
 * tested at all.
 */

const run = randomUUID().replace(/-/g, '').slice(0, 10)

/** A document of the same collection the question is not about, for the "somebody else's stamp" step. */
const OTHER: { readonly [collection in ConformanceCollection]: string } = { customers: '3', orders: '11', sites: 'south' }

interface Context {
    held?: MongoFixture
    service?: DocumentService
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    try {
        const held = await fixture(run)
        const service = new DocumentService({ db: held.db })
        await service.refresh()
        t.context = { held, service, skipped: false }
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

const list = (service: DocumentService, collection: string, params: RpcGetListParams = {}) =>
    service.dataRequest('getList', [collection], params) as Promise<RpcGetListResult>

test('it answers the shared conformance questions the way every other backend does', async (t) => {
    if (without(t)) return
    const { service, held } = t.context as Required<Context>

    for (const question of DATA_QUESTIONS) {
        const excepted = question.except?.mongo
        if (excepted) {
            t.log(`mongo declines "${question.asks}": ${excepted}`)
            continue
        }
        const answer = (await service.dataRequest(question.method ?? 'getList', [held.name[question.collection]], question.params as RpcGetListParams)) as RpcGetListResult
        t.deepEqual([...answer.ids], [...question.ids], `${question.asks}${question.because ? ` - ${question.because}` : ''}`)
        t.is(answer.total, question.total ?? question.ids.length, `the count of ${question.asks} is of the matched set, not of the page`)
        // And that the documents look like what this node said they would. Over a sampled shape
        // that is an inference being checked against its own collection, which nothing else does.
        const declared = service.dataResources().find((resource) => resource.path[0] === held.name[question.collection])?.row
        t.is(rowsAgainstDeclaration(answer.data, declared), undefined, `${question.asks}: the rows match the shape this node published`)
    }
})

test('a shape that was guessed says so, and one that was declared does not', async (t) => {
    if (without(t)) return
    const { service, held } = t.context as Required<Context>

    // Nothing in the fixture has a validator, so every shape here is evidence rather than a
    // statement - and the object is left open to say exactly that. A grid drawing columns from
    // twenty documents over a collection whose twenty-first differs is the failure this prevents
    // being silent.
    const customers = service.dataResources().find((resource) => resource.path[0] === 'customers')
    const row = customers?.row as { kind: 'object'; fields: Record<string, { type: { kind: string }; optional?: boolean }>; additional?: boolean }
    t.true(row.additional, 'sampled, so there may be fields nobody has seen yet')
    t.is(row.fields.name.type.kind, 'string')

    const shapes = service.props.shapes
    t.deepEqual(
        shapes.map(({ name, from }) => `${name}:${from}`).sort(),
        ['customers:sampled', 'orders:sampled', 'sites:sampled'],
        'and the provenance is published rather than left to be assumed'
    )
    t.is(shapes.find(({ name }) => name === 'customers')?.sampled, 4)
    t.is(shapes.find(({ name }) => name === 'customers')?.id, 'number', 'the fixture keys on the shared integer ids')

    // A validator is a declaration the server enforces on every write, so it is used as a table's
    // columns are - closed where it says so, and not labelled as a guess.
    await held.db.createCollection('declared', {
        validator: {
            $jsonSchema: {
                bsonType: 'object',
                required: ['label'],
                additionalProperties: false,
                properties: { _id: { bsonType: 'objectId' }, label: { bsonType: 'string' }, count: { bsonType: 'int' } }
            }
        }
    })
    await held.db.collection('declared').insertOne({ label: 'one', count: 1 })
    await service.refresh()

    const declared = service.dataResources().find((resource) => resource.path[0] === 'declared')
    const shape = declared?.row as { kind: 'object'; fields: Record<string, { type: { kind: string }; optional?: boolean }>; additional?: boolean }
    t.falsy(shape.additional, 'the validator forbids extra properties, so the published shape is closed')
    t.is(shape.fields.label.type.kind, 'string')
    t.true(shape.fields.count.optional, 'and a property the validator does not require is optional')
    // An ObjectId is a hex string on the wire, so that is what the row type says a caller receives -
    // rather than what MongoDB happens to store.
    t.is(shape.fields._id.type.kind, 'string')
    t.is(service.props.shapes.find(({ name }) => name === 'declared')?.from, 'validator')
    t.is(service.props.shapes.find(({ name }) => name === 'declared')?.id, 'objectId')

    await held.db.collection('declared').drop()
    await service.refresh()
})

test('an ObjectId round-trips as its hex string', async (t) => {
    if (without(t)) return
    const { service, held } = t.context as Required<Context>

    await held.db.collection('generated').insertMany([{ label: 'a' }, { label: 'b' }])
    await service.refresh()

    const page = await list(service, 'generated')
    t.is(page.ids.length, 2)
    t.regex(page.ids[0], /^[0-9a-f]{24}$/, 'the id a caller sees')
    // And the same string in the document, rather than a BSON object the codec would have had to
    // invent a shape for.
    t.is((page.data[0] as { _id: string })._id, page.ids[0])

    const some = (await service.dataRequest('getMany', ['generated'], { ids: [page.ids[1], page.ids[0]] })) as RpcGetManyResult
    t.deepEqual([...some.ids], [page.ids[1], page.ids[0]], 'rebuilt into ObjectIds on the way in, or this finds nothing')

    // Silently finding nothing is what this prevents: `{ _id: { $in: ['65…'] } }` is a perfectly
    // valid query that matches no document at all.
    const notAnId = await t.throwsAsync(service.dataRequest('getMany', ['generated'], { ids: ['not-an-objectid'] }), { instanceOf: DocumentRefusal })
    t.regex(String(notAnId?.message), /is not an ObjectId/)

    await held.db.collection('generated').drop()
    await service.refresh()
})

test('a field name is checked for what would make it something other than a field', async (t) => {
    if (without(t)) return
    const { service } = t.context as Required<Context>

    // There is no column list to check against - a field exists on the documents that have it, and
    // sampling can prove a field is there but never that it is not. So the defence is structural,
    // and these are the shapes that are not field names.
    const operator = await t.throwsAsync(list(service, 'customers', { filter: { field: '$where', op: 'eq', operand: 'x' } }), { instanceOf: DocumentRefusal })
    t.regex(String(operator?.message), /an operator rather than a field/)

    const nested = await t.throwsAsync(list(service, 'customers', { filter: { field: 'a.$ne', op: 'eq', operand: 'x' } }), { instanceOf: DocumentRefusal })
    t.regex(String(nested?.message), /an operator rather than a field/, 'including one buried in a path')

    const empty = await t.throwsAsync(list(service, 'customers', { filter: { field: 'a..b', op: 'eq', operand: 'x' } }), { instanceOf: DocumentRefusal })
    t.regex(String(empty?.message), /empty path segment/)

    const deep = await t.throwsAsync(list(service, 'customers', { filter: { field: 'a.b.c.d.e.f.g.h.i.j', op: 'eq', operand: 'x' } }), { instanceOf: DocumentRefusal })
    t.regex(String(deep?.message), /the most this node will follow/)

    // A field nobody has seen is *allowed*, which is the capability difference stated as a test: a
    // document store's fields are not enumerable in advance, and refusing an unsampled one would
    // refuse half of what it is for. It simply matches nothing.
    const unseen = await list(service, 'customers', { filter: { field: 'nobodyHasThis', op: 'eq', operand: 'x' } })
    t.is(unseen.total, 0)
})

test('a dot path reaches inside a value, which is the capability the SQL node refuses', async (t) => {
    if (without(t)) return
    const { service, held } = t.context as Required<Context>

    await held.db.collection('nested').insertMany([
        { _id: 'a' as unknown as never, address: { city: 'Berlin' } },
        { _id: 'b' as unknown as never, address: { city: 'Malmo' } },
        { _id: 'c' as unknown as never }
    ])
    await service.refresh()

    const berlin = await list(service, 'nested', { filter: { field: 'address.city', op: 'eq', operand: 'Berlin' } })
    t.deepEqual([...berlin.ids], ['a'])

    // And the missing-value rule holds one level down as well: `ne` sees the document with no
    // address at all, and every other operator does not.
    const notBerlin = await list(service, 'nested', { filter: { field: 'address.city', op: 'ne', operand: 'Berlin' } })
    t.deepEqual([...notBerlin.ids], ['b', 'c'])

    await held.db.collection('nested').drop()
    await service.refresh()
})

test('a missing field and a null one are the same to an order, and different to a filter', async (t) => {
    if (without(t)) return
    const { service, held } = t.context as Required<Context>

    await held.db.collection('sparse').insertMany([
        { _id: 'has' as unknown as never, city: 'Berlin' },
        { _id: 'null' as unknown as never, city: null },
        { _id: 'missing' as unknown as never }
    ])
    await service.refresh()

    // Ordering treats both as absent, which is the only reading that agrees with SQL - where a NULL
    // is the only way to have no value and there is nothing else for it to mean.
    const up = await list(service, 'sparse', { sort: { field: 'city', order: 'ASC' } })
    t.deepEqual([...up.ids], ['has', 'missing', 'null'], 'the value first, then both absences in key order')

    // Filtering keeps them apart, which is the in-memory rule: `eq null` is about a value that is
    // null, and a document that never had the field has no value to be equal to.
    const isNull = await list(service, 'sparse', { filter: { field: 'city', op: 'eq', operand: null } })
    t.deepEqual([...isNull.ids], ['null'], 'and not the document that simply has no city')

    // `ne` is the deliberate exception and sees both - the rule that costs SQL an extra clause and
    // costs Mongo nothing.
    const notBerlin = await list(service, 'sparse', { filter: { field: 'city', op: 'ne', operand: 'Berlin' } })
    t.deepEqual([...notBerlin.ids], ['missing', 'null'])

    await held.db.collection('sparse').drop()
    await service.refresh()
})

test('a collection this node does not serve is refused by name', async (t) => {
    if (without(t)) return
    const { service } = t.context as Required<Context>

    const missing = await t.throwsAsync(list(service, 'nosuchthing'), { instanceOf: DocumentRefusal })
    t.regex(String(missing?.message), /not a collection this node serves/)
})

test('a table that cannot afford a count pages on hasMore alone', async (t) => {
    if (without(t)) return
    const { held } = t.context as Required<Context>

    const uncounted = new DocumentService({ db: held.db, count: false })
    await uncounted.refresh()

    const first = await list(uncounted, 'customers', { pagination: { page: 0, pageSize: 3 } })
    t.is(first.total, undefined, 'unknown, and saying zero here is what would read as "nothing matches"')
    t.is(first.countMs, undefined)
    t.true(first.hasMore)

    const past = await list(uncounted, 'customers', { pagination: { page: 5, pageSize: 3 } })
    t.is(past.data.length, 0)
    t.is(past.total, undefined)
    t.false(past.hasMore)
})

/**
 * The shared write questions, asked of a document store.
 *
 * The other half of the claim `packages/conformance` exists to turn from an assertion into a fact.
 * Reading the same rows the same way was the first half; refusing the same changes for the same
 * reasons is the second, and it is the half where a divergence is destructive rather than merely
 * confusing - a stamp that meant one thing over SQL and another here would be a compare-and-set that
 * holds on one backend and not the other, and the symptom is a lost update, which leaves nothing
 * behind for anybody to find.
 *
 * A database of its own, because these change documents and the read questions above are counting
 * the same rows. `Fixture` already builds one per run, so this is one more of them rather than a new
 * mechanism.
 */
test.serial('it refuses the same changes the SQL node refuses, for the same reasons', async (t) => {
    if (without(t)) return

    for (const question of WRITE_QUESTIONS) {
        const excepted = question.except?.mongo
        if (excepted) {
            t.log(`mongo declines "${question.asks}": ${excepted}`)
            continue
        }
        // Rebuilt per question: each is independent by design, and one that depended on the one
        // before it would fail in a way that named the wrong question.
        const held = await fixture(`${run}w${WRITE_QUESTIONS.indexOf(question)}`)
        try {
            const writer = new DocumentWriteService({
                db: held.db,
                writes: {
                    [held.name.customers]: WRITE_PERMISSIONS.customers,
                    [held.name.sites]: WRITE_PERMISSIONS.sites
                } as unknown as RpcWritePermissions
            })
            await writer.refresh()

            const collection = held.name[question.collection]
            const where = `${question.asks}${question.because ? ` - ${question.because}` : ''}`

            // Taken before the first step, which is what makes `held` mean anything: it is the stamp
            // a caller was holding while somebody else changed the document underneath it.
            const opening = await writer.getOne(collection, question.id)
            const started = opening.status === 'ok' ? opening.stamp : ''
            const elsewhere = await writer.getOne(collection, OTHER[question.collection])

            for (const step of question.steps) {
                if (step.act === 'expect') {
                    const document = await writer.getOne(collection, question.id)
                    t.is(document.status, 'ok', `${where}: the document is still there`)
                    if (document.status === 'ok') for (const [field, value] of Object.entries(step.row)) t.is((document.row as Record<string, unknown>)[field], value, `${where}: ${field}`)
                    continue
                }
                if (step.act === 'gone') {
                    t.is((await writer.getOne(collection, question.id)).status, 'missing', `${where}: the document is gone`)
                    continue
                }
                const current = await writer.getOne(collection, question.id)
                const stamp =
                    step.using === 'held'
                        ? started
                        : step.using === 'other'
                          ? elsewhere.status === 'ok'
                              ? elsewhere.stamp
                              : ''
                          : // `fresh` reads one immediately before acting, which is the ordinary
                            // path - and against a document that is not there it has nothing to
                            // read, so the step is made with the held one and the node answers
                            // `missing` rather than being asked a question about a stamp.
                            current.status === 'ok'
                            ? current.stamp
                            : started
                const act = step.act === 'delete' ? writer.delete(collection, question.id, stamp) : writer.update(collection, question.id, step.patch, stamp)
                const ends: WriteEnds = step
                if (ends.refuses !== undefined) {
                    const refusal = await t.throwsAsync(act, undefined, `${where}: refused`)
                    t.regex(refusal!.message, new RegExp(ends.refuses), where)
                    continue
                }
                t.is((await act).status, ends.answers, where)
            }
        } finally {
            await held.close()
        }
    }
})

test.serial('it stamps the fields its rule permits, over the document it published', async (t) => {
    if (without(t)) return
    // The one cross-backend claim about the stamp itself, and it is a relationship rather than a
    // constant: the node must digest exactly the permitted fields, taken from the document as it
    // publishes it. Stamp what the driver returned instead and this diverges from every SQL node,
    // since BSON is not what goes on the wire - and the symptom in production is a precondition that
    // never holds, with nothing anywhere to say why.
    const held = await fixture(`${run}stamp`)
    try {
        const service = new DocumentService({ db: held.db })
        await service.refresh()
        const writer = new DocumentWriteService({
            db: held.db,
            writes: { [held.name.customers]: WRITE_PERMISSIONS.customers } as unknown as RpcWritePermissions
        })
        await writer.refresh()

        const page = (await service.dataRequest('getMany', [held.name.customers], { ids: ['1'] })) as RpcGetManyResult
        const published = page.data[0] as Record<string, unknown>
        const read = await writer.getOne(held.name.customers, '1')
        t.is(read.status, 'ok')
        if (read.status !== 'ok') return
        t.is(read.stamp, await rowStamp(held.name.customers, '1', stampedFields('customers', published)), 'the stamp is a digest of the published document')
    } finally {
        await held.close()
    }
})
