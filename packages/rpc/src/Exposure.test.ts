import test from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { rpc, RpcClient, RpcServer, TransportEvent } from './index.js'

/**
 * Two things a peer must be able to rely on about its own exposure and its own link.
 *
 * Both were found while designing deferred replies and neither is about deferred replies: a name
 * that could be silently taken, and link events that went to a private emitter and stopped there.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

test('a name is claimed rather than assigned, so nothing silently displaces the plant', async (t) => {
    const server = new RpcServer({ name: peer('claim3934'), transports: [] })

    class Plant {
        @rpc({ semantics: 'query' })
        async where() {
            return 'the real one'
        }
    }
    class Impostor {
        @rpc({ semantics: 'query' })
        async where() {
            return 'not the plant'
        }
    }

    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    // The hole this closes: createRpcInstance is exposed to the network with the instance name as
    // a caller-chosen argument, so an authorized peer could name something `plant` and every later
    // call would go to it with nothing anywhere saying so.
    const displaced = t.throws(() => server.exposeClassInstance(new Impostor(), 'plant'))
    t.regex(String(displaced?.message), /already exposed by Plant/)
    t.regex(String(displaced?.message), /replace: true/, 'and it says what to do if the caller meant it')

    // Deliberate replacement is still possible - the refusal is about silence, not about policy.
    t.notThrows(() => server.exposeClassInstance(new Impostor(), 'plant', { replace: true }))

    // And re-exposing the same instance displaces nothing, so re-applying options is not a collision.
    t.notThrows(() => server.exposeClassInstance(plant, 'plant', { replace: true }))
    t.notThrows(() => server.exposeClassInstance(plant, 'plant'))

    await server.close()
})

test('a server that dials out can hear its own link, which is when it must reconcile', async (t) => {
    const hub = new RpcServer({ name: peer('hub3935'), transports: [{ port: 3935, host: '127.0.0.1' }] })
    await hub.ready()

    const dialler = new RpcServer({ name: peer('dial3935'), transports: [{ connect: 'http://localhost:3935' }] })
    const heard: string[] = []
    // RpcClient re-emitted these and this did not: they went to a private emitter driving component
    // channels and stopped there, so an application had to reach into transports[0] to learn it had
    // reconnected - exactly the moment it has to reconcile.
    for (const event of [TransportEvent.connected, TransportEvent.disconnected]) dialler.on(event, () => heard.push(event))
    await dialler.ready()

    await new Promise((resolve) => setTimeout(resolve, 200))
    t.true(heard.includes(TransportEvent.connected), `heard ${JSON.stringify(heard)}`)

    await dialler.close()
    await hub.close()
})

test('a withdrawn name stops answering, tells its watchers, and comes back as a new incarnation', async (t) => {
    const server = new RpcServer({ name: peer('retire3940'), transports: [{ port: 3940, host: '127.0.0.1' }] })

    // An emitter, because a retirement is delivered to watchers and only an emitter has any.
    class Job extends EventEmitter {
        @rpc({ semantics: 'query' })
        async where() {
            return 'first'
        }
    }
    class Replacement extends EventEmitter {
        @rpc({ semantics: 'query' })
        async where() {
            return 'second'
        }
    }

    const handle = server.exposeClassInstance(new Job(), 'job')
    await server.ready()

    const client = new RpcClient('http://localhost:3940', { name: peer('asker3940'), defaultTarget: peer('retire3940') })
    const job = await client.proxy<Job>('job')
    t.is(await job.where(), 'first')

    // Retirement has no frame of its own - removePeer covers the subscriber going, and nothing
    // covered the reverse - so without this a watcher cannot tell a retired instance from a live
    // one that has simply not emitted lately.
    const retirements: { namespace: string; generation: number }[] = []
    const watcher = await client.proxy<{ on(event: string, handler: (report: unknown) => void): Promise<unknown> }>('job')
    await watcher.on('$retired', (report) => retirements.push(report as { namespace: string; generation: number }))

    t.true(await handle.withdraw(), 'withdrawing says whether there was anything to withdraw')
    t.false(await handle.withdraw(), 'and a second call is a polite no rather than an error')

    // The record going is what stops new calls: every dispatch decision starts from it, so a call
    // arriving after this finds nothing and is refused like any unknown path.
    const gone = await t.throwsAsync(job.where())
    t.regex(String(gone?.message), /not exposed|ClassNotFound/)

    await new Promise((resolve) => setTimeout(resolve, 100))
    t.is(retirements.length, 1, 'and whoever was watching was told')
    t.is(retirements[0].namespace, 'job')

    // A name is not a thing; it is a place a thing stands. Coming back is a new incarnation, and a
    // client replaying subscriptions must not silently reattach to a different object wearing it.
    server.exposeClassInstance(new Replacement(), 'job')
    t.is(server.rpc.manageRpc.at('job')?.generation, 1, 'the generation moved')
    const again = await client.proxy<Replacement>('job')
    t.is(await again.where(), 'second')

    await client.close()
    await server.close()
})
