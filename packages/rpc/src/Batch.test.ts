import test from 'ava'
import { randomUUID } from 'crypto'
import { rpc, rpcNamespace, RpcClient, RpcServer } from './index.js'
import { RpcMessageType } from './RPC/Messages.js'
import { TransportEvent } from './RPC/Core.js'

/**
 * Calls issued in one tick travel in one frame.
 *
 * What this buys is bytes, not round trips, and the distinction matters enough to state where it
 * can be seen: concurrent calls are already pipelined, so twenty of them cost one round trip either
 * way. What they do not share today is twenty envelopes - a POST carries a uuid, the namespace, the
 * method name and the params, and MQTT adds a request topic, a response topic and correlation data
 * beneath that, so moving a single number spends most of the frame on saying where it is going.
 *
 * The tests count frames rather than assert that results arrive, because results arrived before
 * this feature existed. A test that only checked the answers would pass with batching switched off
 * and prove nothing at all.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

@rpcNamespace('meter')
class Meter {
    @rpc({ semantics: 'query' })
    async read(tag: string) {
        return `${tag}=1`
    }

    @rpc({ semantics: 'idempotent-command' })
    async fail() {
        throw new Error('this one was always going to fail')
    }
}

/** Count what actually crosses, by kind. The transport reports every frame it relays. */
const framesAt = (server: RpcServer) => {
    const seen: string[] = []
    for (const transport of server.transports)
        transport.on(TransportEvent.relayed, (relayed: { message?: { payload?: { type?: string } } }) => {
            const type = relayed?.message?.payload?.type
            if (type) seen.push(type)
        })
    return seen
}

test('twenty calls issued together cross as one frame, and answer individually', async (t) => {
    const hub = new RpcServer({ name: peer('hub3905'), transports: [{ port: 3905, host: '127.0.0.1' }] })
    await hub.ready()
    const relayed = framesAt(hub)

    const device = new RpcServer({ name: peer('meter3905'), transports: [{ connect: 'http://localhost:3905' }] })
    device.exposeClassInstance(new Meter())
    await device.ready()

    const client = new RpcClient('http://localhost:3905', { name: peer('asker3905'), defaultTarget: peer('meter3905'), batchCalls: true })
    const meter = await client.proxy<Meter>('meter')

    // Issued together, which is the precondition. A loop that awaited each in turn could not be
    // batched by anything at this layer, because the second call is not issued until the first
    // has answered - that is what plural methods are for, not this.
    const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => meter.read(`tag.${index}`)))
    t.is(answers.length, 20)
    t.is(answers[7], 'tag.7=1', 'every call still gets its own answer, matched by its own id')

    const posts = relayed.filter((type) => type === RpcMessageType.CallInstanceMethod).length
    const batches = relayed.filter((type) => type === RpcMessageType.batch).length
    t.is(batches, 1, 'one envelope for the twenty')
    t.is(posts, 0, 'and none of them went on its own')

    await client.close()
    await device.close()
    await hub.close()
})

test('batchCalls: false is the escape hatch for a peer that cannot answer a BATCH', async (t) => {
    const hub = new RpcServer({ name: peer('hub3906'), transports: [{ port: 3906, host: '127.0.0.1' }] })
    await hub.ready()
    const relayed = framesAt(hub)

    const device = new RpcServer({ name: peer('meter3906'), transports: [{ connect: 'http://localhost:3906' }] })
    device.exposeClassInstance(new Meter())
    await device.ready()

    // Batching is on by default now, so turning it off is the deliberate act. The reason to is a
    // property of the far end - a peer built before BATCH existed cannot unpack one - and there is
    // no negotiation, so the caller has to be told.
    const client = new RpcClient('http://localhost:3906', { name: peer('asker3906'), defaultTarget: peer('meter3906'), batchCalls: false })
    const meter = await client.proxy<Meter>('meter')
    await Promise.all(Array.from({ length: 5 }, (_, index) => meter.read(`tag.${index}`)))

    t.is(relayed.filter((type) => type === RpcMessageType.batch).length, 0, 'nothing may be wrapped once a caller has said it must not be')
    t.is(relayed.filter((type) => type === RpcMessageType.CallInstanceMethod).length, 5, 'five calls, five frames, exactly as before batching existed')

    await client.close()
    await device.close()
    await hub.close()
})

test('batching is on without being asked for, which is what makes it worth having', async (t) => {
    const hub = new RpcServer({ name: peer('hub3909'), transports: [{ port: 3909, host: '127.0.0.1' }] })
    await hub.ready()
    const relayed = framesAt(hub)

    const device = new RpcServer({ name: peer('meter3909'), transports: [{ connect: 'http://localhost:3909' }] })
    device.exposeClassInstance(new Meter())
    await device.ready()

    // No batchCalls anywhere. The point of a default is that nobody has to have heard of it.
    const client = new RpcClient('http://localhost:3909', { name: peer('asker3909'), defaultTarget: peer('meter3909') })
    const meter = await client.proxy<Meter>('meter')
    await Promise.all(Array.from({ length: 8 }, (_, index) => meter.read(`tag.${index}`)))

    t.is(relayed.filter((type) => type === RpcMessageType.batch).length, 1)
    t.is(relayed.filter((type) => type === RpcMessageType.CallInstanceMethod).length, 0)

    await client.close()
    await device.close()
    await hub.close()
})

test('a batch is an envelope, not a transaction: one failure settles one call', async (t) => {
    const hub = new RpcServer({ name: peer('hub3907'), transports: [{ port: 3907, host: '127.0.0.1' }] })
    await hub.ready()
    const device = new RpcServer({ name: peer('meter3907'), transports: [{ connect: 'http://localhost:3907' }] })
    device.exposeClassInstance(new Meter())
    await device.ready()

    const client = new RpcClient('http://localhost:3907', { name: peer('asker3907'), defaultTarget: peer('meter3907'), batchCalls: true })
    const meter = await client.proxy<Meter>('meter')

    // Deliberately mixed, and issued together so they share a frame. Nothing about travelling
    // together makes them succeed or fail together, and anybody reading a batch as atomic would
    // expect the reads to have been rolled back.
    const settled = await Promise.allSettled([meter.read('a'), meter.fail(), meter.read('b')])
    t.deepEqual(
        settled.map((one) => one.status),
        ['fulfilled', 'rejected', 'fulfilled']
    )
    t.is((settled[0] as PromiseFulfilledResult<string>).value, 'a=1')
    t.is((settled[2] as PromiseFulfilledResult<string>).value, 'b=1')

    await client.close()
    await device.close()
    await hub.close()
})

test('a lone call is never wrapped, so batching costs nothing when there is nothing to batch', async (t) => {
    const hub = new RpcServer({ name: peer('hub3908'), transports: [{ port: 3908, host: '127.0.0.1' }] })
    await hub.ready()
    const relayed = framesAt(hub)

    const device = new RpcServer({ name: peer('meter3908'), transports: [{ connect: 'http://localhost:3908' }] })
    device.exposeClassInstance(new Meter())
    await device.ready()

    const client = new RpcClient('http://localhost:3908', { name: peer('asker3908'), defaultTarget: peer('meter3908'), batchCalls: true })
    const meter = await client.proxy<Meter>('meter')

    t.is(await meter.read('only'), 'only=1')
    t.is(relayed.filter((type) => type === RpcMessageType.batch).length, 0, 'one call in a tick goes as itself')
    t.is(relayed.filter((type) => type === RpcMessageType.CallInstanceMethod).length, 1)

    // Awaited in turn, so each is its own tick and there is nothing to group. Stated as a test
    // because it is the shape people will expect batching to fix, and it cannot.
    for (const tag of ['x', 'y', 'z']) await meter.read(tag)
    t.is(relayed.filter((type) => type === RpcMessageType.batch).length, 0, 'a sequential caller batches nothing, by construction')

    await client.close()
    await device.close()
    await hub.close()
})
