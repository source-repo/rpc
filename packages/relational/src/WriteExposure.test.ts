import { createTokenAuthenticator, RpcClient, RpcServer, type RpcAiGrants, type RpcCallContext, type RpcRowRead, type RpcWritableResource, type RpcWriteOutcome } from '@source-repo/rpc'
import test from 'ava'
import { randomUUID } from 'node:crypto'
import { fixture } from './Fixture.js'
import { exposeRelational } from './Service.js'
import { exposeRelationalWrites } from './WriteService.js'

/**
 * The write half as an ordinary peer, which is the whole claim of putting it in a namespace rather
 * than on a dispatch verb.
 *
 * Everything in `Writes.test.ts` calls the service directly, which is the right way to test a
 * translation. None of it can test the thing that actually makes this design defensible: that a
 * write goes through every gate an ordinary command goes through, because it *is* an ordinary
 * command. So this one goes over a real link with authentication, an authorizer and a grants
 * document in front of it, and asks whether each of them sees what it needs to see.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const READER = `reader-token-${run}`
const WRITER = `writer-token-${run}`
const ASSISTANT = `assistant-token-${run}`

interface WriteProxy {
    writable(): Promise<readonly RpcWritableResource[]>
    getOne(table: string, id: string): Promise<RpcRowRead>
    update(table: string, id: string, patch: Record<string, unknown>, expect: string): Promise<RpcWriteOutcome>
    delete(table: string, id: string, expect: string): Promise<RpcWriteOutcome>
}

/** Every call the authorizer was asked about, so the test can assert what it was told rather than only what it decided. */
const asked: RpcCallContext[] = []

const grants: RpcAiGrants = { grants: 1, revision: 1, open: {} }

const raise = async (port: number) => {
    const db = await fixture()
    const server = new RpcServer({
        // A port and a name per test, because ava runs the tests in a file concurrently and a
        // second listener on the same port is a failure that names the wrong test.
        name: peer(`sql${port}`),
        transports: [{ port, host: '127.0.0.1' }],
        exposeIntrospection: true,
        authenticate: createTokenAuthenticator({
            [READER]: { name: peer('reader'), roles: ['viewer'] },
            [WRITER]: { name: peer('writer'), roles: ['engineer'] },
            // A badged AI principal on a node whose grants document opens nothing, which is the
            // default posture the whole ladder is built around.
            [ASSISTANT]: { name: peer('assistant'), roles: ['ai-tool'] }
        }),
        aiGrants: grants,
        authorize: async (context) => {
            asked.push(context)
            // The policy this test exists to make possible: one namespace is open to everyone who
            // got through the door, and the other is open to one peer - and inside it, to one table.
            if (context.instanceName !== 'sql.write') return true
            if (context.identity?.name !== peer('writer') && context.identity?.name !== peer('assistant')) return false
            // `params` carries the table, so a deployment rules on *which* table rather than only on
            // the method. Without that this whole surface would be one permission.
            const table = context.params[0]
            return context.method === 'writable' || table === 'customers'
        }
    })
    await exposeRelational(server, 'sql', { db, flavour: 'sqlite' })
    await exposeRelationalWrites(server, 'sql.write', {
        db,
        flavour: 'sqlite',
        writes: {
            customers: { verbs: ['create', 'update', 'delete'], columns: ['name', 'city'] },
            sites: { verbs: ['update'], columns: ['label'] }
        }
    })
    await server.ready()
    return server
}

const dial = (port: number, token: string, as: string) => new RpcClient(`http://localhost:${port}`, { name: peer(as), defaultTarget: peer(`sql${port}`), credentials: { token } })

test('a write is an ordinary command, so every gate a command passes is in front of it', async (t) => {
    const port = 3949
    const server = await raise(port)
    t.teardown(() => server.close())

    const engineer = dial(port, WRITER, 'writer')
    const viewer = dial(port, READER, 'reader')
    const assistant = dial(port, ASSISTANT, 'assistant')
    t.teardown(async () => {
        await engineer.close()
        await viewer.close()
        await assistant.close()
    })

    const writer = await engineer.proxy<WriteProxy>('sql.write')

    // ---- what it will let this caller do, before anything is refused
    const writable = await writer.writable()
    t.deepEqual(
        writable.map((one) => one.resource),
        ['customers', 'sites']
    )

    // ---- the ordinary path: read the row, hold the stamp, change it under that stamp
    const read = await writer.getOne('customers', '1')
    t.is(read.status, 'ok')
    if (read.status !== 'ok') return
    t.is((await writer.update('customers', '1', { city: 'Hamburg' }, read.stamp)).status, 'ok')

    // And the same stamp a second time is refused, over the wire as it is in memory.
    t.is((await writer.update('customers', '1', { city: 'Bremen' }, read.stamp)).status, 'conflict')

    // ---- two namespaces are two authorization surfaces
    const reading = await viewer.proxy<{ tables(): Promise<{ served: readonly string[] }> }>('sql')
    t.truthy((await reading.tables()).served.length, 'the viewer reads the database perfectly well')
    const denied = await viewer.proxy<WriteProxy>('sql.write')
    await t.throwsAsync(denied.getOne('customers', '1'), { message: /not permitted/ }, 'and cannot reach the write namespace at all')

    // ---- and the authorizer ruled on which table, from params
    const refused = await t.throwsAsync(writer.update('sites', 'north', { label: 'North works' }, 'any-stamp'), { message: /not permitted/ })
    t.truthy(refused, 'the same peer, the same method, a different table')
    const ruled = asked.filter((one) => one.instanceName === 'sql.write' && one.method === 'update')
    t.true(
        ruled.some((one) => one.params[0] === 'sites'),
        'the authorizer saw the table name in params rather than only the method'
    )
    t.true(
        ruled.some((one) => (one.params[2] as Record<string, unknown>)?.city === 'Hamburg'),
        'and the patch, so a policy can rule on what is being written as well as where'
    )
})

test('a badged AI principal may take a stamp and may not use one', async (t) => {
    // The ladder in one test, and the reason `effect` is declared separately from `semantics` on
    // every method of the write service. Reading is where AI earns its place; a node whose grants
    // document opens nothing refuses the change - before the authorizer above, which would have
    // allowed it.
    const port = 3950
    const server = await raise(port)
    t.teardown(() => server.close())
    const assistant = dial(port, ASSISTANT, 'assistant')
    t.teardown(() => assistant.close())

    const writer = await assistant.proxy<WriteProxy>('sql.write')

    const read = await writer.getOne('customers', '1')
    t.is(read.status, 'ok', 'observe: a stamp is a read, and a badged principal may read')
    if (read.status !== 'ok') return
    t.truthy(await writer.writable(), 'and may ask what it would be permitted to change')

    await t.throwsAsync(writer.update('customers', '1', { city: 'Lund' }, read.stamp), { message: /not permitted/ }, 'operate: closed, on a node that opened nothing')
    await t.throwsAsync(writer.delete('customers', '1', read.stamp), { message: /not permitted/ })
})

test('the write namespace and its elevation are both visible to something asking what this peer is', async (t) => {
    const port = 3951
    const server = await raise(port)
    t.teardown(() => server.close())
    const engineer = dial(port, WRITER, 'writer')
    t.teardown(() => engineer.close())

    const introspection = await engineer.proxy<{
        describe(): Promise<{ namespaces: { name: string; methods?: { name: string }[] }[]; elevated?: { capability: string; reason?: string }[] }>
    }>('msgrpc')
    const description = await introspection.describe()

    const written = description.namespaces.find((one) => one.name === 'sql.write')
    t.truthy(written, 'the write half is its own namespace, which is what makes it its own authorize() surface')
    const methods = (written?.methods ?? []).map((one) => one.name).sort()
    t.deepEqual(methods, ['create', 'delete', 'getOne', 'refresh', 'update', 'writable'])

    // Announced rather than remembered: composing the node in with a usable document is what makes
    // this host able to change somebody else's database, so composing it in is what says so.
    const elevation = description.elevated?.find((one) => one.capability === 'relational.write')
    t.truthy(elevation, 'and a console can see that this peer can currently write without calling anything')
    t.regex(elevation!.reason!, /customers/)
})
