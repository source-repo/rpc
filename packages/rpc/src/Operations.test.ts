import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, rpc, rpcNamespace, RpcOperations, type RpcInvocationHandle, type RpcOperation } from './index.js'

/**
 * What this peer asked other peers to do, and how each of those turned out.
 *
 * The registry is not new information - a client already mints the id, holds the promise, arms the
 * timer and classifies the failure. What it is, is the same information kept *after the promise
 * settles*, which is when the program stops caring and a person starts.
 *
 * So the questions here are the ones a tray has to answer correctly or not be worth having: does an
 * uncertain outcome say so rather than looking like a failure, does it survive a busy peer, and is
 * it possible to read one of these without reading the plant data that travelled with it.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

@rpcNamespace('gate')
class Gate {
    @rpc({ semantics: 'query' })
    async readMode(secret: string) {
        return `mode for ${secret}`
    }

    @rpc({ semantics: 'non-repeatable-command' })
    async startPump() {
        throw new Error('the interlock is open')
    }

    @rpc
    async silent() {
        await sleep(5000)
        return 'too late'
    }

    /** Answers twice: a ticket now, the outcome later. */
    @rpc({ injectInvocation: true })
    async survey(invocation?: RpcInvocationHandle) {
        const deferred = invocation!.defer<string>()
        setTimeout(() => deferred.resolve('done'), 40)
        return deferred
    }
}

const at = (operations: readonly RpcOperation[], method: string) => operations.filter((one) => one.method === method).at(-1)

test('a call is written down before it is sent, and moves through what actually happened', async (t) => {
    const server = new RpcServer({ name: peer('gate4101'), transports: [{ port: 4101, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Gate())
    await server.ready()
    const client = new RpcClient('http://localhost:4101', { name: peer('asker4101'), defaultTarget: peer('gate4101') })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const proxy = await client.proxy<Gate>('gate')
    t.is(await proxy.$with({ semantics: 'query', idempotencyKey: 'shift-7' }).readMode('hunter2'), 'mode for hunter2')

    const entry = at(client.operations.getSnapshot(), 'readMode')!
    t.is(entry.status, 'succeeded')
    t.is(entry.namespace, 'gate')
    t.is(entry.target, peer('gate4101'))
    t.is(entry.semantics, 'query', "the caller's claim, which travels nowhere and decides nothing")
    t.is(entry.idempotencyKey, 'shift-7')
    t.true(entry.deadlineMs! > 0, 'what the caller declared it would wait')
    t.true(entry.issuedAt > 0 && entry.sentAt! >= entry.issuedAt && entry.settledAt! >= entry.sentAt!)

    // The security property, and it is the reason this is worth stating as a test rather than a
    // comment: an `untap(token)` argument is a bearer capability and a `$data` answer is a page of
    // plant rows, so a peer-wide store holding either hands every screen in the process a read
    // surface that `authorize()` was protecting on the way in.
    t.false(JSON.stringify(entry).includes('hunter2'), 'not the arguments')
    t.false(JSON.stringify(entry).includes('mode for'), 'and not the result')
})

test('a refusal is a failure, and only an uncertain outcome is uncertain', async (t) => {
    const server = new RpcServer({ name: peer('gate4102'), transports: [{ port: 4102, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Gate())
    await server.ready()
    const client = new RpcClient('http://localhost:4102', { name: peer('asker4102'), defaultTarget: peer('gate4102') })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const proxy = await client.proxy<Gate>('gate')
    await t.throwsAsync(proxy.startPump())
    const refused = at(client.operations.getSnapshot(), 'startPump')!
    // The method threw, which is a fact about the plant and not about the outcome being unknown:
    // the answer arrived, and it said no.
    t.is(refused.status, 'failed')
    t.is(refused.code, 'Exception')
    t.regex(refused.message!, /interlock/, "the far end's sentence about the failure, which is not an argument")

    // A call that went out and was never answered is the one a tray must not lose. `Timeout` is kept
    // beside it because it says *why* nothing is known, which is more use than the general case -
    // but the status is what a screen sorts on, and both codes are the same fact about the plant.
    await t.throwsAsync(proxy.$with({ timeoutMs: 60, semantics: 'non-repeatable-command' }).silent())
    const lost = at(client.operations.getSnapshot(), 'silent')!
    t.is(lost.status, 'unknown-outcome')
    t.is(lost.code, 'Timeout')
    t.is(lost.semantics, 'non-repeatable-command', 'which is what makes this row the one to look at first')
})

test('a deferred method is not finished when the call is', async (t) => {
    const server = new RpcServer({ name: peer('gate4103'), transports: [{ port: 4103, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Gate())
    await server.ready()
    const client = new RpcClient('http://localhost:4103', { name: peer('asker4103'), defaultTarget: peer('gate4103') })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const proxy = await client.proxy<Gate>('gate')
    const ticket = (await proxy.survey()) as unknown as { result: Promise<string> }
    // The call succeeded and the operation did not, which one status could not say.
    t.is(at(client.operations.getSnapshot(), 'survey')!.status, 'deferred')
    t.is(await ticket.result, 'done')
    t.is(at(client.operations.getSnapshot(), 'survey')!.status, 'succeeded')
})

test('a server is a caller too, and its outward calls land in the same registry', async (t) => {
    const gate = new RpcServer({ name: peer('gate4104'), transports: [{ port: 4104, host: '127.0.0.1' }] })
    gate.exposeClassInstance(new Gate())
    await gate.ready()
    const other = new RpcServer({ name: peer('other4104'), transports: [{ connect: 'http://localhost:4104' }] })
    await other.ready()
    t.true(await other.awaitPeer(peer('gate4104')), 'presence first: a route is not a connection')
    t.teardown(async () => {
        await other.close()
        await gate.close()
    })

    const proxy = await other.proxy<Gate>('gate', peer('gate4104'))
    await proxy.readMode('x')
    // One hook at `callWith` covers a client's calls, a server-acting-as-caller's and a component
    // channel's - which is why there is no second implementation anywhere for this.
    t.is(at(other.operations.getSnapshot(), 'readMode')!.status, 'succeeded')
})

// ------------------------------------------------------------------ the bound, without a network

const made = (id: string, status: RpcOperation['status']): RpcOperation => ({ id, namespace: 'gate', method: 'm', issuedAt: 1, status })

test('what scrolls away first is what nobody has further business with', (t) => {
    const operations = new RpcOperations({ keep: 3 })
    operations.record(made('a', 'issued'))
    operations.advance('a', { status: 'unknown-outcome' })
    operations.record(made('b', 'issued'))
    operations.advance('b', { status: 'succeeded' })
    operations.record(made('c', 'issued'))
    operations.advance('c', { status: 'failed' })
    operations.record(made('d', 'issued'))

    // `b` went, though `a` is older: an unknown outcome is the one row a person still has business
    // with, and letting it scroll off while a succeeded call above it stayed would be the tray
    // failing at the only job it has.
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['a', 'c', 'd']
    )
    operations.record(made('e', 'issued'))
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['a', 'd', 'e'],
        'and an in-flight call outlives a settled one for the same reason'
    )
})

test('an uncertain outcome is given up only when there is nothing else to give up', (t) => {
    const operations = new RpcOperations({ keep: 2 })
    for (const id of ['a', 'b', 'c']) {
        operations.record(made(id, 'issued'))
        operations.advance(id, { status: 'unknown-outcome' })
    }
    // Bounded is bounded - a tray that grew without limit would be a leak with a user interface -
    // but the oldest goes last rather than first, and only against other uncertain ones.
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['b', 'c']
    )
})

test('a call still in flight is never the one that scrolls off', (t) => {
    const operations = new RpcOperations({ keep: 2 })
    for (const id of ['a', 'b']) {
        operations.record(made(id, 'issued'))
        operations.advance(id, { status: 'unknown-outcome' })
    }
    operations.record(made('c', 'issued'))
    // Evicting `c` would take a command off an operator's screen while it was still happening, and
    // would leave nowhere to record the uncertain outcome it may be about to become.
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['b', 'c']
    )

    // Which is why the registry is allowed to exceed `keep`: with nothing settled and nothing
    // uncertain left, there is nothing it may honestly forget. It costs nothing - the client is
    // already holding a promise for each of these, so this is bounded by concurrency and not uptime.
    operations.record(made('d', 'issued'))
    operations.record(made('e', 'issued'))
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['c', 'd', 'e']
    )
})

test('clearing what is over does not clear what nobody has answered', (t) => {
    const operations = new RpcOperations()
    operations.record(made('a', 'issued'))
    operations.advance('a', { status: 'unknown-outcome' })
    operations.record(made('b', 'issued'))
    operations.advance('b', { status: 'succeeded' })
    operations.record(made('c', 'issued'))

    operations.clearSettled()
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['a', 'c'],
        'a dismiss button must not quietly take the row it exists to keep'
    )
    // Which leaves getting rid of one as the deliberate act it should be.
    operations.forget('a')
    t.deepEqual(
        operations.getSnapshot().map((one) => one.id),
        ['c']
    )
})

test('an entry is frozen, and a consumer can compare by reference', (t) => {
    const operations = new RpcOperations()
    operations.record(made('a', 'issued'))
    const first = operations.getSnapshot()
    t.throws(() => ((first[0] as { status: string }).status = 'succeeded'))
    operations.advance('a', { status: 'sent' })
    t.not(operations.getSnapshot(), first, 'replaced whole, so a memoizing pane sees it move')
    t.is(operations.at('a')!.status, 'sent')
})

test('a selector narrows what a tray re-renders for', (t) => {
    const operations = new RpcOperations()
    const uncertain = operations.select((all) => all.filter((one) => one.status === 'unknown-outcome').length)
    let told = 0
    uncertain.subscribe(() => told++)
    t.is(uncertain.getSnapshot(), 0)

    operations.record(made('a', 'issued'))
    operations.advance('a', { status: 'sent' })
    t.is(told, 0, 'a call going through its ordinary stages is not news to a count of the uncertain ones')
    operations.advance('a', { status: 'unknown-outcome' })
    t.is(told, 1)
    t.is(uncertain.getSnapshot(), 1)
})
