import test from 'ava'
import { randomUUID } from 'node:crypto'
import { RpcClient, RpcComponent, RpcServer, rpc, rpcNamespace } from '../index.js'
import type { RpcDataMethod, RpcDataResource, RpcGetOneParams, RpcGetOneResult, RpcResource } from './DataProvider.js'

/**
 * One row, on its own.
 *
 * `getOne` has been named in `RpcDataMethod` since resources were added and was never served, in
 * exactly the way `shape: 'tree'` was declarable before `getChildren` answered it. This is that
 * second seam closed, and it is the verb a detail view is made of: a list answers what a row looks
 * like among its siblings, and this answers what it looks like on its own.
 *
 * The fixture is a rack of serial ports rather than a table of documents, because the case the verb
 * exists for is the one where the two answers genuinely differ. A port's row is four fields worth
 * comparing down a column; a port *itself* is twenty fields nobody wants in a table, and until now
 * a viewer had no way to ask for the second without an aspect provider's `openObject` - which is a
 * different protocol, and one an ordinary component does not implement.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

interface Port {
    id: string
    port: string
    baudrate: number
    status: 'open' | 'closed' | 'fault'
    errors: number
    /**
     * The fields a list does not populate, declared optional here for the reason the contract
     * states: one row type governs both answers, so a resource whose detail is richer says which
     * fields may be absent rather than declaring a second type to keep in step with the first.
     */
    parity?: string
    stopBits?: number
    overruns?: number
    lastError?: string
}

const rack: { [id: string]: Port } = {
    'usb-0': { id: 'usb-0', port: '/dev/ttyUSB0', baudrate: 115200, status: 'open', errors: 0, parity: 'none', stopBits: 1, overruns: 0 },
    'usb-1': {
        id: 'usb-1',
        port: '/dev/ttyUSB1',
        baudrate: 9600,
        status: 'fault',
        errors: 417,
        parity: 'even',
        stopBits: 1,
        overruns: 15,
        lastError: 'framing at 09:41'
    }
}

/** What a list sends: the columns, and none of the twenty fields behind them. */
const asRow = ({ id, port, baudrate, status, errors }: Port): Port => ({ id, port, baudrate, status, errors })

@rpcNamespace('ports')
class Ports extends RpcComponent<{ host: string }, { open: number }> {
    constructor() {
        super({ host: 'cabinet-a' }, { open: 1 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['ports'],
                verbs: ['getList', 'getOne'],
                label: 'Serial ports',
                presentation: { defaultColumns: ['port', 'baudrate', 'status', 'errors'] },
                row: {
                    kind: 'object',
                    fields: {
                        id: { type: { kind: 'string' } },
                        port: { type: { kind: 'string' } },
                        baudrate: { type: { kind: 'number' } },
                        status: { type: { kind: 'string' } },
                        errors: { type: { kind: 'number' } },
                        parity: { type: { kind: 'string' }, optional: true },
                        stopBits: { type: { kind: 'number' }, optional: true },
                        overruns: { type: { kind: 'number' }, optional: true },
                        lastError: { type: { kind: 'string' }, optional: true }
                    }
                }
            }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetOneParams): unknown {
        if (resource[0] !== 'ports') throw new Error(`no such resource ${resource.join('.')}`)
        if (method === 'getOne') {
            const held = rack[params.id]
            // Absent rather than an error: a row can go between the list that named it and the
            // click that opened it, and that race is not a fault in this peer.
            return { ...(held ? { data: held } : {}), epoch: run, revision: 1 }
        }
        const rows = Object.values(rack).map(asRow)
        return { data: rows, ids: rows.map((row) => row.id), total: rows.length, epoch: run, revision: 1 }
    }
}

/** Declares the verb and then answers a row its own type forbids - what a rename leaves behind. */
@rpcNamespace('wrong')
class Wrong extends RpcComponent<{ host: string }, { open: number }> {
    constructor() {
        super({ host: 'cabinet-b' }, { open: 0 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['ports'],
                verbs: ['getOne'],
                row: { kind: 'object', fields: { id: { type: { kind: 'string' } }, baudrate: { type: { kind: 'number' } } } }
            }
        ]
    }

    dataRequest(): RpcGetOneResult {
        return { data: { id: 'usb-0', baudrate: 'fast' }, epoch: run, revision: 1 }
    }
}

/** A component with a record in its own state and no declared resources at all. */
@rpcNamespace('meter')
class Meter extends RpcComponent<{ site: string }, { tags: { [tag: string]: { value: number; unit: string } } }> {
    constructor() {
        super({ site: 'north' }, { tags: { t1: { value: 20, unit: 'C' }, t2: { value: 4, unit: 'bar' } } })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }
}

const linked = async (t: { teardown: (fn: () => Promise<void>) => void }, port: number, instance: object, namespace: string, validateResults = false) => {
    const server = new RpcServer({ name: peer(`host${port}`), transports: [{ port, host: '127.0.0.1' }], exposeIntrospection: true, validateResults })
    server.exposeClassInstance(instance, namespace)
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`host${port}`) })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { server, client }
}

interface DataFace {
    $data(verb: string, resource: string[], params: unknown): Promise<RpcGetOneResult & { data?: Port; ids?: string[] }>
}

const one = async (client: RpcClient, namespace: string, resource: string[], id: string) => {
    const face = await client.proxy<DataFace>(namespace)
    return face.$data('getOne', resource, { id })
}

test('a declared resource answers one row, richer than the row it lists', async (t) => {
    const { client } = await linked(t, 5011, new Ports(), 'ports')
    const face = await client.proxy<DataFace>('ports')

    const listed = await face.$data('getList', ['ports'], {})
    t.deepEqual(listed.ids, ['usb-0', 'usb-1'])
    // The list carries the columns and nothing behind them, which is the whole reason the two
    // verbs are separate rather than one verb with a flag.
    t.false(JSON.stringify(listed).includes('framing at 09:41'))

    const opened = await one(client, 'ports', ['ports'], 'usb-1')
    t.is(opened.data?.port, '/dev/ttyUSB1')
    t.is(opened.data?.overruns, 15)
    t.is(opened.data?.lastError, 'framing at 09:41', 'the fields a table has no room for')
})

test('an id that reaches nothing answers an absent row rather than an error', async (t) => {
    const { client } = await linked(t, 5012, new Ports(), 'ports')

    const gone = await one(client, 'ports', ['ports'], 'usb-9')
    t.is(gone.data, undefined)
    t.false('data' in gone, 'absent, not present-and-undefined - a positional format encodes those differently')
    // Still an answer, so the freshness a cache reads is still there.
    t.is(gone.revision, 1)
})

test('a record in the component’s own state answers it too, with no resource declared', async (t) => {
    const { client } = await linked(t, 5013, new Meter(), 'meter')

    const held = await one(client, 'meter', ['state', 'tags'], 't2')
    t.deepEqual(held.data as unknown, { value: 4, unit: 'bar' })

    const missing = await one(client, 'meter', ['state', 'tags'], 't9')
    t.is(missing.data, undefined, 'the same answer from the library-served path as from a declared one')
})

test('a resource that does not declare the verb refuses it, and says what it answers', async (t) => {
    const { client } = await linked(t, 5014, new Ports(), 'ports')
    const face = await client.proxy<DataFace>('ports')

    const refused = await t.throwsAsync(face.$data('getChildren', ['ports'], {}))
    t.regex(String(refused?.message), /answers getList, getOne/, 'named, so the caller learns what to ask instead')
})

test('an id must be a non-empty string, checked before anything is served', async (t) => {
    const { client } = await linked(t, 5015, new Ports(), 'ports')
    const face = await client.proxy<DataFace>('ports')

    for (const params of [{}, { id: '' }, { id: 7 }]) {
        const refused = await t.throwsAsync(face.$data('getOne', ['ports'], params))
        t.regex(String(refused?.message), /getOne takes a non-empty string id/)
    }
})

test('a single row is checked against the declared type, exactly as a page of them is', async (t) => {
    // The row check is a self-check on this server's own code and is off by default, so the test
    // that it fires has to turn it on - the same as the page-of-rows check it now shares.
    const { client } = await linked(t, 5016, new Wrong(), 'wrong', true)
    const face = await client.proxy<DataFace>('wrong')

    // The reason a row is validated at all - a viewer drawing the wrong shape looks like a viewer
    // bug - does not stop applying because there is one of them.
    const refused = await t.throwsAsync(face.$data('getOne', ['ports'], { id: 'usb-0' }))
    t.regex(String(refused?.message), /served a row its own declared type forbids/)
    t.regex(String(refused?.message), /baudrate/, 'and names the field, so the rename is findable')
})
