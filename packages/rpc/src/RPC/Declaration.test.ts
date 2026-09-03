import test from 'ava'
import { randomUUID } from 'node:crypto'
import { rpc, rpcNamespace, RpcClient, RpcComponent, RpcServer } from '../index.js'
import type { RpcDataMethod, RpcDataResource, RpcGetListParams, RpcResource } from './DataProvider.js'
import type { RpcWritableResource } from './DataWrites.js'

/**
 * One declaration, saying what a resource answers - reading and writing.
 *
 * A resource used to describe its reads in `RpcDataResource.verbs` and its writes somewhere else
 * entirely: a sibling `<namespace>.write` instance answering `writable()`. So "what can I do with
 * this?" was two questions, of two shapes, over two round trips, joined by every caller that asked.
 *
 * The join was lossy as well as duplicated, and that is the part worth a test rather than a comment.
 * A write surface names a resource by a single string where `$data` addresses it by a path, so the
 * two agreed only for resources exactly one segment deep - anything nested was not refused, it was
 * unsayable. Folding the answer into the declaration ends that by construction.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

@rpcNamespace('desk')
class Desk extends RpcComponent<Record<string, never>, { notes: { [id: string]: { title: string; body: string } } }> {
    constructor() {
        super({}, { notes: { '1': { title: 'first', body: 'a' }, '2': { title: 'second', body: 'b' } } })
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            { path: ['notes'], verbs: ['getList', 'getOne'], row: { kind: 'object', fields: { title: { type: { kind: 'string' } }, body: { type: { kind: 'string' } } } } },
            // Two segments deep on purpose: this is the shape the old join could not describe as
            // writable, because the write surface had only a single string to name it with.
            { path: ['archive', 'notes'], verbs: ['getList'] }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetListParams): unknown {
        return { ids: [], data: [], total: 0, epoch: 'e', revision: 1, ms: 0, asked: [method, resource.join('.'), params] }
    }
}

/** The sibling write surface, exactly as the store packages expose it. */
@rpcNamespace('desk.write')
class DeskWrites {
    @rpc({ semantics: 'query' })
    async writable(): Promise<readonly RpcWritableResource[]> {
        return [{ resource: 'notes', verbs: ['update', 'delete'], columns: ['title'] }]
    }
}

const described = async (port: number, name: string, expose: (server: RpcServer) => void) => {
    const server = new RpcServer({ name: peer(name), transports: [{ port, host: '127.0.0.1' }], exposeIntrospection: true })
    expose(server)
    await server.ready()
    const client = new RpcClient(`http://127.0.0.1:${port}`, { name: peer(`${name}-caller`), defaultTarget: peer(name) })
    await client.ready()
    const proxy = await client.proxy<{ describe(): Promise<{ namespaces: { name: string; component?: { resources?: RpcDataResource[] } }[] }> }>('msgrpc', peer(name))
    const answer = await proxy.describe()
    return { answer, close: async () => (await client.close(), await server.close()) }
}

test('one list: what a resource reads with and what it writes with, from describe alone', async (t) => {
    const { answer, close } = await described(3971, 'desk', (server) => {
        server.exposeClassInstance(new Desk())
        server.exposeClassInstance(new DeskWrites())
    })
    const resources = answer.namespaces.find((one) => one.name === 'desk')?.component?.resources ?? []
    const notes = resources.find((one) => one.path.join('.') === 'notes')

    // The whole point in one assertion: a caller that has the description has the answer, and does
    // not open a second namespace to complete it.
    t.deepEqual([...(notes?.verbs ?? [])].sort(), ['delete', 'getList', 'getOne', 'update'])
    // Resolved rather than restated: `columns` is what the store agreed to, not what a rule asked
    // for, so a field the store does not have is absent here instead of advertised and then refused.
    t.deepEqual(notes?.columns, ['title'])
    await close()
})

test('a resource nobody permitted keeps the verbs it reads with, which is the write default said once', async (t) => {
    const { answer, close } = await described(3972, 'desk2', (server) => {
        server.exposeClassInstance(new Desk())
        server.exposeClassInstance(new DeskWrites())
    })
    const resources = answer.namespaces.find((one) => one.name === 'desk')?.component?.resources ?? []
    const nested = resources.find((one) => one.path.join('.') === 'archive.notes')

    // Not in the write rules, so read-only - and said by the list being short rather than by a
    // second document being silent. `columns` is absent rather than empty for the same reason a
    // total is: absent means nothing was claimed.
    t.deepEqual(nested?.verbs, ['getList'])
    t.is(nested?.columns, undefined)
    await close()
})

test('a write surface that will not answer costs the read half nothing', async (t) => {
    @rpcNamespace('desk.write')
    class Broken {
        @rpc({ semantics: 'query' })
        async writable(): Promise<readonly RpcWritableResource[]> {
            throw new Error('the store has gone away')
        }
    }

    const { answer, close } = await described(3973, 'desk3', (server) => {
        server.exposeClassInstance(new Desk())
        server.exposeClassInstance(new Broken())
    })
    const resources = answer.namespaces.find((one) => one.name === 'desk')?.component?.resources ?? []

    // A description that failed because the write half did would be a peer that stopped being
    // describable when its database went down - which is the moment somebody most wants to look.
    t.deepEqual(resources.find((one) => one.path.join('.') === 'notes')?.verbs, ['getList', 'getOne'])
    await close()
})
