import test from 'ava'
import { randomUUID } from 'crypto'
import { MessageType, rpc, rpcNamespace, RpcClient, RpcServer, type RpcInvocationHandle, type RpcTicket } from './index.js'

/**
 * Work that outlives the call that started it, answered to the peer that asked and to nobody else.
 *
 * The whole argument for this being in the library rather than in every application is the last
 * part. Hand-rolled, a result sink has to verify that whoever is reporting the result is the peer
 * the work was given to - a check somebody has to know to write, whose absence is invisible, and
 * which fails by letting anyone on the bus put a fabricated number on an operator's screen. Here it
 * is a property of how the reply travels: a ticket's id is the id of a call this peer made, so a
 * forged answer has nothing to attach itself to.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

type JobResult = { rows: number }

@rpcNamespace('jobs')
class Jobs {
    @rpc({ semantics: 'non-repeatable-command', injectInvocation: true })
    async start(rows: number, inv: RpcInvocationHandle): Promise<RpcTicket<JobResult, number>> {
        const reply = inv.defer<JobResult, number>()
        void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
            reply.progress(50)
            await new Promise((resolve) => setTimeout(resolve, 30))
            reply.resolve({ rows })
        })()
        return reply.ticket
    }

    @rpc({ semantics: 'non-repeatable-command', injectInvocation: true })
    async fail(inv: RpcInvocationHandle): Promise<RpcTicket<JobResult>> {
        const reply = inv.defer<JobResult>()
        void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            reply.reject(new Error('the scan hit a bad sector'))
        })()
        return reply.ticket
    }

    /** Reports that its caller left, which is a fact rather than an instruction to stop. */
    @rpc({ semantics: 'non-repeatable-command', injectInvocation: true })
    async watched(inv: RpcInvocationHandle): Promise<RpcTicket<JobResult>> {
        const reply = inv.defer<JobResult>()
        reply.on('abandoned', () => Jobs.abandoned.push('yes'))
        return reply.ticket
    }

    static readonly abandoned: string[] = []
}

test('a deferred method answers the call at once and the work later', async (t) => {
    const server = new RpcServer({ name: peer('jobs3936'), transports: [{ port: 3936, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Jobs())
    await server.ready()

    const client = new RpcClient('http://localhost:3936', { name: peer('asker3936'), defaultTarget: peer('jobs3936') })
    const jobs = await client.proxy<Jobs>('jobs')

    const ticket = await jobs.start(7)
    // The call has already answered - with a correlation id and an expiry, not with the work.
    t.is(typeof ticket.id, 'string')
    t.true(ticket.expiresAt > Date.now(), 'and the ticket has its own deadline, not the calldispatch one')

    const seen: number[] = []
    ticket.on('progress', (update) => seen.push(update))

    const result = await ticket.result
    t.deepEqual(result, { rows: 7 }, 'the answer is on the ticket rather than being the ticket, so the handle survives the first await')
    t.deepEqual(seen, [50], 'and what happened on the way arrived on the way')

    await client.close()
    await server.close()
})

test('a deferred failure reaches the caller as a rejection', async (t) => {
    const server = new RpcServer({ name: peer('jobs3937'), transports: [{ port: 3937, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Jobs())
    await server.ready()

    const client = new RpcClient('http://localhost:3937', { name: peer('asker3937'), defaultTarget: peer('jobs3937') })
    const jobs = await client.proxy<Jobs>('jobs')

    const ticket = await jobs.fail()
    const failure = await t.throwsAsync(ticket.result)
    t.regex(String(failure?.message), /bad sector/)

    await client.close()
    await server.close()
})

test('a ticket is answerable only by the peer it was issued by', async (t) => {
    const server = new RpcServer({ name: peer('jobs3938'), transports: [{ port: 3938, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Jobs())
    await server.ready()

    const client = new RpcClient('http://localhost:3938', { name: peer('asker3938'), defaultTarget: peer('jobs3938') })
    const jobs = await client.proxy<Jobs>('jobs')

    const ticket = await jobs.start(3)

    // The forgery: a third peer that knows the ticket id - which it could have seen on a shared bus
    // - answering it with a number of its own. This is the failure the library exists to make
    // impossible rather than to document, and it is refused because the caller knows which peer it
    // gave the work to and this is not that peer.
    const refused: { id: string; from: string }[] = []
    client.rpcClient!.on('ticketRefused', (report: { id: string; from: string }) => refused.push(report))
    const forger = new RpcClient('http://localhost:3938', { name: peer('forger3938'), defaultTarget: peer('asker3938') })
    await forger.ready()
    await forger.rpcClient!.sendPayload({ type: 'TICKET', id: ticket.id, outcome: 'resolved', value: { rows: 999999 } } as never, MessageType.ResponseMessage, peer('forger3938'), peer('asker3938'))

    // And the real answer still arrives, unaffected by the attempt.
    const result = await ticket.result
    t.deepEqual(result, { rows: 3 }, 'the peer that was asked is the peer that answered')
    t.is(refused.length, 1, 'and the attempt was reported rather than silently dropped')
    t.is(refused[0].from, peer('forger3938'))

    await forger.close()
    await client.close()
    await server.close()
})

test('a caller that goes away is reported to the handler as a fact, not as a cancellation', async (t) => {
    const server = new RpcServer({ name: peer('jobs3939'), transports: [{ port: 3939, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Jobs())
    await server.ready()

    const client = new RpcClient('http://localhost:3939', { name: peer('asker3939'), defaultTarget: peer('jobs3939') })
    const jobs = await client.proxy<Jobs>('jobs')
    await jobs.watched()

    await client.close()
    // The handler is told; whether it stops is its own business, which is the difference between
    // this and a cancel() the library could not honestly implement.
    for (let waited = 0; waited < 50 && !Jobs.abandoned.length; waited++) await new Promise((resolve) => setTimeout(resolve, 40))
    t.deepEqual(Jobs.abandoned, ['yes'])

    await server.close()
})
