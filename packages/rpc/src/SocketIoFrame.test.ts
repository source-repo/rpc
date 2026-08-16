import test from 'ava'
import { randomUUID } from 'crypto'
import EventEmitter from 'events'
import { io as socketIoClient, Socket } from 'socket.io-client'
import { decode as msgPackDecode, encode as msgPackEncode } from '@msgpack/msgpack'
import { rpc, rpcNamespace, RpcClient, RpcServer } from './index.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import type { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'
import { FRAME_EVENT, LEGACY_FRAME_EVENT, SOCKET_FRAME_VERSION, type WireFrame } from './Transports/SocketIoFrame.js'
import { PRESENCE_EVENT } from './Transports/Presence.js'

/**
 * The socket.io frame, from the outside.
 *
 * The point of the flat layout is the same as the MQTT 5 one's: a peer needs no msgrpc code to take
 * part. So the load-bearing tests here use a vanilla socket.io client and `@msgpack/msgpack` and
 * nothing else, the way `Mqtt5.test.ts` uses vanilla mqtt.js - asserting that this library can talk
 * to itself would prove nothing about whether anybody else can talk to it.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const until = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('until timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

class Meter {
    async read(tag: string) {
        return `${tag}=42`
    }
    async blow() {
        throw new Error('the sensor is on fire')
    }
}

/** Everything a third-party caller has to do, with no msgrpc code in it. */
const outsider = (port: number, name: string) => {
    const socket: Socket = socketIoClient(`http://localhost:${port}`)
    const heard: WireFrame[] = []
    socket.on(FRAME_EVENT, (bytes: ArrayBufferLike) => heard.push(msgPackDecode(new Uint8Array(bytes)) as WireFrame))
    socket.on(LEGACY_FRAME_EVENT, () => heard.push({ v: 0, src: '', tgt: '', kind: 'legacy-layout-was-used' }))
    const send = (frame: Partial<WireFrame>) =>
        socket.emit(FRAME_EVENT, msgPackEncode({ v: SOCKET_FRAME_VERSION, src: name, ...frame }, { ignoreUndefined: true }))
    return { socket, heard, send }
}

test('a plain socket.io client with no msgrpc code can call an msgrpc server', async (t) => {
    const server = new RpcServer({ name: peer('meterHost'), transports: [{ port: 3961, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Meter(), 'meter')
    await server.ready()

    // ---- the whole third-party caller ----
    const { socket, heard, send } = outsider(3961, peer('outsider'))
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.emit(PRESENCE_EVENT, { name: peer('outsider'), v: SOCKET_FRAME_VERSION })
    send({ tgt: peer('meterHost'), kind: 'call', corr: 'c-1', path: 'meter', method: 'read', body: ['flow'] })
    // ---- end of third-party code ----

    await until(() => heard.length > 0)
    // One decode of one map. No delimiter to find, no header to parse with JSON's quoting rules,
    // no nested envelope - which is the entire argument for this layout over the `$` one.
    t.is(heard[0].kind, 'result')
    t.is(heard[0].corr, 'c-1', 'answered against the correlation the caller chose')
    t.is(heard[0].src, peer('meterHost'))
    t.is(heard[0].tgt, peer('outsider'))
    t.is(heard[0].body, 'flow=42', 'and the body is the return value, bare')

    // A failure is the same shape with the code in a field, so a caller can tell a refusal from a
    // thrown error without decoding anything it does not already have.
    send({ tgt: peer('meterHost'), kind: 'call', corr: 'c-2', path: 'meter', method: 'blow', body: [] })
    await until(() => heard.length > 1)
    t.is(heard[1].kind, 'error')
    t.is(heard[1].corr, 'c-2')
    t.is((heard[1].body as { message: string }).message, 'the sensor is on fire')

    // A method nobody exposed is refused by name rather than by silence.
    send({ tgt: peer('meterHost'), kind: 'call', corr: 'c-3', path: 'meter', method: 'nonesuch', body: [] })
    await until(() => heard.length > 2)
    t.is(heard[2].kind, 'error')
    t.is(heard[2].code, 'MethodNotFound')

    socket.disconnect()
    await server.close()
})

test('a plain socket.io client can subscribe, and events arrive as frames it can read', async (t) => {
    @rpcNamespace('alarm')
    class AlarmPanel extends EventEmitter {
        @rpc({ semantics: 'query' })
        async ping() {
            return 'ok'
        }
        raise(level: number) {
            this.emit('raised', level)
        }
    }
    const panel = new AlarmPanel()
    const server = new RpcServer({ name: peer('alarmHost'), transports: [{ port: 3962, host: '127.0.0.1' }] })
    server.exposeClassInstance(panel)
    await server.ready()

    const { socket, heard, send } = outsider(3962, peer('listener'))
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.emit(PRESENCE_EVENT, { name: peer('listener'), v: SOCKET_FRAME_VERSION })

    // Subscribing is an ordinary request whose kind says what it is, so every request has one shape
    // - the same bargain the MQTT layout makes with `mr-kind: subscribe`.
    send({ tgt: peer('alarmHost'), kind: 'subscribe', corr: 's-1', path: 'alarm', method: 'on', body: ['raised'] })
    await until(() => heard.some((frame) => frame.corr === 's-1'))

    panel.raise(9)
    await until(() => heard.some((frame) => frame.kind === 'event'))
    const event = heard.find((frame) => frame.kind === 'event')!
    t.is(event.event, 'raised')
    t.is(event.path, 'alarm')
    t.deepEqual(event.body, [9], 'the emit arguments, and nothing else')
    t.is(typeof event.seq, 'number', 'with the cursor that lets a watcher claim it missed nothing')
    t.truthy(event.epoch)
    t.is(event.corr, undefined, 'an event is unsolicited, so it correlates with nothing')

    socket.disconnect()
    await server.close()
})

test('a listen-only peer is answered in the layout it announced, having sent no frame', async (t) => {
    const server = new RpcServer({ name: peer('pushHost'), transports: [{ port: 3963, host: '127.0.0.1' }] })
    await server.ready()

    // This peer announces and then says nothing at all. Nothing it sends can teach the server its
    // dialect, so the announcement is the only thing that can - which is why presence carries `v`.
    const listener = server.transports[0] as unknown as SocketIoServerTransport
    const { socket, heard } = outsider(3963, peer('quiet'))
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.emit(PRESENCE_EVENT, { name: peer('quiet'), v: SOCKET_FRAME_VERSION })
    await until(() => listener.reachablePeers().includes(peer('quiet')))

    // Addressed out of the blue, the way an event push reaches a subscriber that never called.
    await listener.receive({ type: 'EVENT', payload: { type: 'EVENT', event: 'tick', params: [1] } } as never, peer('pushHost'), peer('quiet'))
    await until(() => heard.length > 0)
    t.is(heard[0].kind, 'event', 'and it arrived as a v2 frame, not the legacy layout')
    t.not(heard[0].kind, 'legacy-layout-was-used')

    socket.disconnect()
    await server.close()
})

test('one listener serves a v1 peer and a v2 peer at once, each in its own layout', async (t) => {
    const server = new RpcServer({ name: peer('mixedHost'), transports: [{ port: 3964, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Meter(), 'meter')
    await server.ready()

    // The upgrade path: a peer built against the older layout keeps working against a server that
    // has moved on, because the two populations arrive on different socket.io events and a server
    // registering both can never confuse one for the other.
    const old = new RpcClient(undefined, {
        name: peer('oldPeer'),
        defaultTarget: peer('mixedHost'),
        transport: new SocketIoClientTransport(peer('oldPeer'), 'http://localhost:3964', undefined, {}, true, false, 1)
    })
    const current = new RpcClient('http://localhost:3964', { name: peer('newPeer'), defaultTarget: peer('mixedHost') })
    await Promise.all([old.ready(), current.ready()])

    const [fromOld, fromNew] = await Promise.all([
        old.proxy<Meter>('meter').then((m) => m.read('a')),
        current.proxy<Meter>('meter').then((m) => m.read('b'))
    ])
    t.is(fromOld, 'a=42')
    t.is(fromNew, 'b=42')

    await old.close()
    await current.close()
    await server.close()
})

test('a batch travels as one frame carrying many, rather than as many frames', async (t) => {
    const server = new RpcServer({ name: peer('batchHost'), transports: [{ port: 3965, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Meter(), 'meter')
    await server.ready()

    // Counted on the wire, because the saving is the whole reason a batch exists and it is
    // invisible from the answers. MQTT 5 has to unpack a batch into one publish per call - one
    // correlation per publish is its rule - so this is the transport where the envelope pays.
    const seen: WireFrame[] = []
    server.transports[0].on('connection', (socket: { on(event: string, handler: (bytes: ArrayBufferLike) => void): void }) =>
        socket.on(FRAME_EVENT, (bytes: ArrayBufferLike) => seen.push(msgPackDecode(new Uint8Array(bytes)) as WireFrame))
    )

    const client = new RpcClient('http://localhost:3965', { name: peer('batcher'), defaultTarget: peer('batchHost') })
    await client.ready()
    const meter = await client.proxy<Meter>('meter')

    const answers = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => meter.read(tag)))
    t.deepEqual(answers, ['a=42', 'b=42', 'c=42', 'd=42'])

    const batched = seen.find((frame) => frame.kind === 'batch')
    t.truthy(batched, 'the four calls went out as one batch frame')
    t.is(batched!.batch?.length, 4)
    t.deepEqual(
        batched!.batch?.map((one) => one.method),
        ['read', 'read', 'read', 'read']
    )
    // Each keeps its own correlation, because a batch is an envelope and not a transaction: they
    // are answered separately and each carries its own deadline and idempotency key.
    t.is(new Set(batched!.batch?.map((one) => one.corr)).size, 4)

    await client.close()
    await server.close()
})

test('a frame that is not one is refused with a reason, not dropped', async (t) => {
    const server = new RpcServer({ name: peer('strictHost'), transports: [{ port: 3966, host: '127.0.0.1' }] })
    await server.ready()
    const refused: { reason?: string }[] = []
    server.transports[0].on('rejected', (info: { reason?: string }) => refused.push(info))

    const socket: Socket = socketIoClient('http://localhost:3966')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))

    // A frame from a future version is refused rather than read on the assumption that the parts
    // this build recognises still mean what they used to.
    socket.emit(FRAME_EVENT, msgPackEncode({ v: 99, src: 'x', tgt: peer('strictHost'), kind: 'call' }))
    socket.emit(FRAME_EVENT, msgPackEncode({ v: SOCKET_FRAME_VERSION, tgt: peer('strictHost'), kind: 'call' }))
    socket.emit(FRAME_EVENT, msgPackEncode({ v: SOCKET_FRAME_VERSION, src: 'x', tgt: peer('strictHost'), kind: 'nonesuch' }))
    socket.emit(FRAME_EVENT, msgPackEncode(['not', 'a', 'frame']))
    await until(() => refused.length >= 4)

    const reasons = refused.map((one) => one.reason ?? '').join(' | ')
    t.regex(reasons, /version 99/, 'a version this build does not accept says so')
    t.regex(reasons, /names no source/)
    t.regex(reasons, /nonesuch/, 'an unknown kind is named rather than ignored')
    t.regex(reasons, /not an object/)

    socket.disconnect()
    await server.close()
})
