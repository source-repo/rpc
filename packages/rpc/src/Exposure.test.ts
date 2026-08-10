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

test('a call queued against a retired instance is told it certainly did not run', async (t) => {
    const server = new RpcServer({ name: peer('drain3941'), transports: [{ port: 3941, host: '127.0.0.1' }] })

    class Slow extends EventEmitter {
        @rpc({ semantics: 'idempotent-command' })
        async work(ms: number) {
            await new Promise((resolve) => setTimeout(resolve, ms))
            return 'ran'
        }
    }

    // Serialised, so a second call waits behind the first rather than running beside it - which is
    // what puts a call in the queue this test is about.
    const handle = server.exposeClassInstance(new Slow(), 'slow', { execution: 'serial' })
    await server.ready()

    const client = new RpcClient('http://localhost:3941', { name: peer('asker3941'), defaultTarget: peer('drain3941') })
    const slow = await client.proxy<Slow>('slow')

    const first = slow.work(300)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const queued = slow.work(1)

    // Phase one stops new calls; phase two is this. The queued call holds a bound handler and would
    // otherwise run happily into an instance nobody can reach any more.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await handle.withdraw()

    t.is(await first, 'ran', 'the call already running is left alone')
    const refused = await t.throwsAsync(queued)
    // A posture rather than a timeout: OwnershipChanged already means *certainly did not run*,
    // which is exactly true here and is the one thing the caller needs to decide what to do next.
    t.is((refused as { code?: string })?.code, 'OwnershipChanged')
    t.regex(String(refused?.message), /retired.*certainly did not run/)

    await client.close()
    await server.close()
})

test('an exposure bound to a peer outlives a flap and not a departure', async (t) => {
    const server = new RpcServer({ name: peer('bound3942'), transports: [{ port: 3942, host: '127.0.0.1' }] })

    class Job extends EventEmitter {
        @rpc({ semantics: 'query' })
        async where() {
            return 'here'
        }
    }

    server.exposeClassInstance(new Job(), 'bound', { lifetime: { peer: peer('owner3942'), graceMs: 120 } })
    await server.ready()

    // A flap: gone and back inside the grace. Retiring on the event itself would destroy running
    // work over a wifi handover, which is why the window exists at all.
    server.rpc.peerLifetime(peer('owner3942'), false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    server.rpc.peerLifetime(peer('owner3942'), true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    t.truthy(server.rpc.manageRpc.at('bound')?.instance, 'a peer that came back keeps its work')

    // A departure: gone, and stays gone past the grace.
    server.rpc.peerLifetime(peer('owner3942'), false)
    await new Promise((resolve) => setTimeout(resolve, 250))
    t.falsy(server.rpc.manageRpc.at('bound')?.instance, 'and one that does not, does not')

    await server.close()
})
