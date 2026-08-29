import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MessageChannel, Worker } from 'node:worker_threads'
import { MessagePortTransport, rpc, RpcServer, rpcNamespace, TransportEvent } from '../index.js'

/**
 * A worker that is a peer in its own right, rather than an instance somebody else hosts.
 *
 * The difference is the whole point of this transport. A hosted component is reached by forwarding
 * one method call; a peer has a **name**, appears in presence, is addressed like anything else on
 * the network, and can call *out* to peers it has only ever heard of. These check both directions,
 * because a link that only carries calls inward is a hosting arrangement wearing a transport's
 * clothes.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const workerModule = fileURLToPath(new URL('../RPC/fixture/peerWorker.js', import.meta.url))

@rpcNamespace('gauge')
class Gauge {
    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'the gauge answered from the main thread'
    }
}

interface Kettle {
    boil(litres: number): Promise<string>
    askBack(): Promise<string>
}

const linked = async (t: ExecutionContext) => {
    const here = peer('host')
    const there = peer('kettle-peer')
    const channel = new MessageChannel()

    const link = new MessagePortTransport(here, channel.port1)
    const server = new RpcServer({ name: here, transports: [link] })
    server.exposeClassInstance(new Gauge(), 'gauge')
    await server.ready()

    const worker = new Worker(workerModule, { workerData: { port: channel.port2, name: there, partner: here }, transferList: [channel.port2] })
    t.teardown(async () => {
        await worker.terminate()
        await server.close()
    })
    const up = new Promise<void>((resolve) => worker.on('message', (message: { up?: boolean }) => message?.up && resolve()))
    await Promise.race([up, sleep(4_000)])
    await Promise.race([link.presenceSettled(), sleep(2_000)])
    return { server, link, worker, here, there }
}

test('a worker peer announces itself, and is known by name', async (t) => {
    const { link, there } = await linked(t)

    t.true(link.knownPeers.has(there), 'presence is an announcement each way, since there is no broker to ask')
    t.true(link.connected)
})

test('a call reaches a peer on another thread and comes back', async (t) => {
    const { server, there } = await linked(t)

    const kettle = await server.proxy<Kettle>('kettle', there)
    t.is(await kettle.boil(2), 'boiling 2 litres on a thread of my own', 'addressed by name, over a link that is a thread')
})

test('the worker peer calls back, to a peer it knows only from presence', async (t) => {
    const { server, there } = await linked(t)

    // The direction that makes this a peer rather than a hosting arrangement: the worker originates
    // a call, addressed to a name it learned when the link opened.
    const kettle = await server.proxy<Kettle>('kettle', there)
    t.is(await kettle.askBack(), 'the gauge answered from the main thread')
})

test('a peer that goes is reported gone, so nothing keeps routing to it', async (t) => {
    const { link, worker, there } = await linked(t)

    const gone: string[] = []
    link.on(TransportEvent.peerGone, (name: string) => gone.push(name))
    await worker.terminate()
    for (let waited = 0; waited < 2_000 && !gone.length; waited += 5) await sleep(5)

    t.deepEqual(gone, [there], 'a worker that exits closes its port, and this side learns the way it learns a socket dropped')
    t.false(link.knownPeers.has(there))
})

test('a frame carrying what no codec could carry is refused rather than sent', async (t) => {
    const { server, there } = await linked(t)
    const kettle = await server.proxy<Kettle>('kettle', there)

    // Structured clone would carry a Date; a remote peer would receive a string. Accepting it here
    // is what would make placement observable - the same call would mean two different things
    // depending on where the callee happened to be running.
    const refusal = await t.throwsAsync((kettle as unknown as { boil(v: unknown): Promise<unknown> }).boil(new Date()))
    t.regex(refusal!.message, /only a plain object crosses as itself|Date/)
})

test('a closed link stops being a route rather than swallowing what is sent down it', async (t) => {
    const { server, link, there } = await linked(t)
    const kettle = await server.proxy<Kettle>('kettle', there)
    t.is(await kettle.boil(1), 'boiling 1 litres on a thread of my own')

    await link.close()
    t.false(link.connected)
    // Refused rather than dropped: a frame discarded in silence is a caller waiting out its whole
    // deadline for an answer nobody was ever going to send.
    await t.throwsAsync(kettle.boil(1))
})
