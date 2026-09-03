import test from 'ava'
import { randomUUID } from 'node:crypto'
import { rpcNamespace, RpcClient, RpcComponent, RpcServer } from '../index.js'
import type { RpcDataMethod, RpcDataResource, RpcGetListParams, RpcResource } from './DataProvider.js'
import { RPC_WRITE_ANY, type RpcMoveParams, type RpcUpdateParams, type RpcWritableResource, type RpcWriteOutcome, type RpcWriteParams, type RpcWriteVerb } from './DataWrites.js'

/**
 * `$write`: one dispatch verb for every write, the way `$data` is one for every read.
 *
 * The read side has had a verb-shaped dispatch since resources existed, which is why `getOne`,
 * `getChildren` and `getManyReference` each arrived as one case rather than as a method every
 * implementor had to grow. The write side did not: `create`, `update` and `delete` were ordinary
 * methods on a hand-written service per store package, so a fourth verb meant a fourth method
 * everywhere, and a fifth would have meant a fifth.
 *
 * `move` is the verb that made that cost visible, and the fixture is the case it exists for: a list
 * of contact methods somebody arranged - try email, then sms, then phone. That order is **data**. A
 * viewer that stored it would be a second system of record for it, disagreeing with the first as
 * soon as anything else wrote, so the resource owns it and declares `move`; a viewer offers arrows
 * exactly where that declaration is and nowhere else.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

type Method = { id: string; via: string; detail: string }

@rpcNamespace('contacts')
class Contacts extends RpcComponent<Record<string, never>, Record<string, never>> {
    /** Ordered, and the order is the point: this array *is* what `move` moves. */
    private methods: Method[] = [
        { id: 'a', via: 'email', detail: 'someone@example.invalid' },
        { id: 'b', via: 'sms', detail: '+46 700 000 000' },
        { id: 'c', via: 'phone', detail: '+46 8 000 000' }
    ]

    constructor() {
        super({}, {})
    }

    order() {
        return this.methods.map((one) => one.id)
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['methods'],
                // One list, reads and writes, and `move` is what says this resource is ordered.
                verbs: ['getList', 'getOne', 'update', 'move'],
                row: { kind: 'object', fields: { via: { type: { kind: 'string' } }, detail: { type: { kind: 'string' } } } }
            }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetListParams): unknown {
        void resource
        void params
        if (method !== 'getList') throw new Error(`contacts serves getList, not ${method}`)
        return { ids: this.methods.map((one) => one.id), data: this.methods.map((one) => ({ via: one.via, detail: one.detail })), total: this.methods.length, epoch: 'e', revision: 1, ms: 0 }
    }

    writable(): readonly RpcWritableResource[] {
        return [{ resource: 'methods', verbs: ['update', 'move'], columns: ['detail'] }]
    }

    writeRequest(verb: RpcWriteVerb, resource: string, params: RpcWriteParams): RpcWriteOutcome {
        void resource
        const at = this.methods.findIndex((one) => one.id === (params as { id: string }).id)
        if (at < 0) return { status: 'missing' }
        // The precondition, as everywhere on this surface - with `'*'` as the caller saying out loud
        // that it has none, rather than saying it by leaving a field out.
        const expect = (params as { expect: string }).expect
        if (expect !== RPC_WRITE_ANY && expect !== `v${at}`) return { status: 'conflict' }

        if (verb === 'move') {
            const [moved] = this.methods.splice(at, 1)
            // Clamped rather than refused: a position past the end plainly means last, and the
            // validator has already refused the ones that mean nothing at all.
            this.methods.splice(Math.min((params as RpcMoveParams).position, this.methods.length), 0, moved)
            return { status: 'ok', id: moved.id }
        }
        this.methods[at] = { ...this.methods[at], ...(params as RpcUpdateParams).patch }
        return { status: 'ok', id: this.methods[at].id }
    }
}

const connected = async (port: number) => {
    const held = new Contacts()
    const server = new RpcServer({ name: peer(`w${port}`), transports: [{ port, host: '127.0.0.1' }] })
    server.exposeClassInstance(held)
    await server.ready()
    const client = new RpcClient(`http://127.0.0.1:${port}`, { name: peer(`c${port}`), defaultTarget: peer(`w${port}`) })
    await client.ready()
    const proxy = await client.proxy<{ $write(verb: string, resource: string, params: unknown): Promise<RpcWriteOutcome> }>('contacts', peer(`w${port}`))
    return { held, proxy, close: async () => (await client.close(), await server.close()) }
}

test('one dispatch verb: move reorders the resource that declared it', async (t) => {
    const { held, proxy, close } = await connected(3981)
    t.deepEqual(held.order(), ['a', 'b', 'c'])

    // Phone to the front. `position` is where it ends up, not how far it travelled - which is what
    // somebody dragging a row means.
    const outcome = await proxy.$write('move', 'methods', { id: 'c', position: 0, expect: RPC_WRITE_ANY })
    t.is(outcome.status, 'ok')
    t.deepEqual(held.order(), ['c', 'a', 'b'])
    await close()
})

test('a verb the resource did not claim is refused by name, not attempted', async (t) => {
    const { proxy, close } = await connected(3982)
    // The same shape of refusal `$data` gives, because a caller reading both should not have to
    // learn two ways of being told no.
    await t.throwsAsync(proxy.$write('delete', 'methods', { id: 'a', expect: RPC_WRITE_ANY }), { message: /accepts update, move, not delete/ })
    await close()
})

test('a resource nobody permitted is refused with what is permitted, rather than silently', async (t) => {
    const { proxy, close } = await connected(3983)
    await t.throwsAsync(proxy.$write('update', 'nothing', { id: 'a', patch: {}, expect: RPC_WRITE_ANY }), { message: /accepts no writes - contacts accepts them for methods/ })
    await close()
})

test('the precondition is required, and having none is something a caller says out loud', async (t) => {
    const { held, proxy, close } = await connected(3984)

    // Omitted is refused. An optional precondition is one that gets left out the first time
    // somebody is in a hurry, and the edit it silently discards leaves no trace anywhere.
    await t.throwsAsync(proxy.$write('update', 'methods', { id: 'a', patch: { detail: 'x' } }), { message: /needs 'expect'/ })
    // A wrong one conflicts rather than overwriting.
    t.like(await proxy.$write('update', 'methods', { id: 'a', patch: { detail: 'x' }, expect: 'v9' }), { status: 'conflict' })
    // `'*'` is on the record: a value in the frame, visible in an audit line, refusable by a node
    // that does not want blind writes. An omitted field could be none of those things.
    t.like(await proxy.$write('update', 'methods', { id: 'a', patch: { detail: 'changed' }, expect: RPC_WRITE_ANY }), { status: 'ok' })
    t.deepEqual(held.order(), ['a', 'b', 'c'])
    await close()
})

test('a position that means nothing is refused before any store sees it', async (t) => {
    const { proxy, close } = await connected(3985)
    await t.throwsAsync(proxy.$write('move', 'methods', { id: 'a', position: -1, expect: RPC_WRITE_ANY }), { message: /where the row ends up, not how far it travelled/ })
    await t.throwsAsync(proxy.$write('move', 'methods', { id: 'a', position: 1.5, expect: RPC_WRITE_ANY }), { message: /whole, non-negative position/ })
    await close()
})
