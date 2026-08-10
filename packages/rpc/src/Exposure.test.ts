import test from 'ava'
import { randomUUID } from 'crypto'
import { rpc, RpcServer, TransportEvent } from './index.js'

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
