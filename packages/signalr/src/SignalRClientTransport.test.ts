import test from 'ava'
import { randomUUID } from 'crypto'
import { HubConnection } from '@microsoft/signalr'
import { FRAME_EVENT, FLAT_FRAME_VERSION, MessageType, PRESENCE_EVENT, RpcMessageType, TransportEvent, type Message, type WireFrame } from '@source-repo/rpc'
import { SignalRClientTransport } from './SignalRClientTransport.js'

/**
 * What can be proved without a hub.
 *
 * A SignalR *server* is ASP.NET Core, so there is nothing to start one with from here - see
 * `Interop.test.ts` for the part that needs one and how to run it. What is testable without one is
 * the whole of this transport's own job: turning a message into the frame the specification
 * describes, turning an arriving frame back, routing it, and refusing what it cannot read. SignalR
 * itself is Microsoft's to test, so the connection is a stub.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

/** A HubConnection as far as this transport is concerned: named messages in, named messages out. */
const stubConnection = (state = 'Connected') => {
    const sent: { method: string; arg: unknown }[] = []
    const handlers = new Map<string, (arg: never) => void>()
    const connection = {
        state,
        on: (method: string, handler: (arg: never) => void) => handlers.set(method, handler),
        send: async (method: string, arg: unknown) => void sent.push({ method, arg }),
        start: async () => undefined,
        stop: async () => undefined,
        onclose: () => undefined,
        onreconnected: () => undefined,
        onreconnecting: () => undefined
    }
    return { connection: connection as unknown as HubConnection, sent, handlers }
}

/**
 * A transport whose link is a stub, built through the same `createConnection` seam a caller would
 * use for a custom protocol or retry policy - so `open()` runs for real and registers its handlers
 * on the stub, rather than the test reaching past it.
 */
const transportOn = async (name: string, state = 'Connected') => {
    const stub = stubConnection(state)
    const transport = new SignalRClientTransport(name, 'http://localhost:0/rpc', undefined, {}, true, undefined, () => stub.connection)
    await transport.open()
    return { transport, ...stub }
}

const frameSent = (sent: { method: string; arg: unknown }[]) => sent.filter((one) => one.method === FRAME_EVENT).map((one) => one.arg as WireFrame)

test('a call goes out as the frame the specification describes', async (t) => {
    const { transport, sent } = await transportOn(peer('hmi'))
    const message: Message = {
        type: MessageType.RequestMessage,
        payload: { type: RpcMessageType.CallInstanceMethod, id: 'c-1', path: 'solution', method: 'open', params: ['Plant.sln'], ttl: 5000 }
    } as Message

    await transport.receive(message, peer('hmi'), peer('vs'))

    const [frame] = frameSent(sent)
    t.is(frame.v, FLAT_FRAME_VERSION)
    t.is(frame.src, peer('hmi'))
    t.is(frame.tgt, peer('vs'))
    t.is(frame.kind, 'call')
    t.is(frame.corr, 'c-1')
    t.is(frame.path, 'solution')
    t.is(frame.method, 'open')
    t.is(frame.ttl, 5000)
    t.deepEqual(frame.body, ['Plant.sln'], 'the argument array, and nothing else')
    // Sent as a frame rather than as bytes: the hub method takes a typed object, which is the
    // entire reason a C# author reaches for SignalR in the first place.
    t.is(typeof frame, 'object')
    await transport.close()
})

test('an arriving result is delivered to the peer it is addressed to', async (t) => {
    const { transport, handlers } = await transportOn(peer('hmi2'))
    const delivered: Message[] = []
    // Stands in for the RPC handler that would be piped in below the transport.
    transport.send = async (message: Message) => void delivered.push(message)
    transport.targetExists = () => transport as never

    handlers.get(FRAME_EVENT)!({
        v: FLAT_FRAME_VERSION,
        src: peer('vs2'),
        tgt: peer('hmi2'),
        kind: 'result',
        corr: 'c-1',
        body: 'C:\\src\\Plant.sln'
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))

    t.is(delivered.length, 1)
    t.is(delivered[0].type, MessageType.ResponseMessage)
    t.like(delivered[0].payload, { type: RpcMessageType.success, id: 'c-1', result: 'C:\\src\\Plant.sln' })
    await transport.close()
})

test('a frame this build cannot read is refused with a reason, not dropped', async (t) => {
    const { transport, handlers } = await transportOn(peer('hmi3'))
    const refused: { reason?: string }[] = []
    transport.on(TransportEvent.rejected, (info: { reason?: string }) => refused.push(info))

    handlers.get(FRAME_EVENT)!({ v: 99, src: 'x', tgt: peer('hmi3'), kind: 'result', corr: 'c' } as never)
    handlers.get(FRAME_EVENT)!({ v: FLAT_FRAME_VERSION, tgt: peer('hmi3'), kind: 'result' } as never)
    handlers.get(FRAME_EVENT)!({ v: FLAT_FRAME_VERSION, src: 'x', tgt: peer('hmi3'), kind: 'nonesuch' } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const reasons = refused.map((one) => one.reason ?? '').join(' | ')
    t.regex(reasons, /version 99/, 'a version this build does not accept says so rather than being read anyway')
    t.regex(reasons, /names no source/)
    t.regex(reasons, /nonesuch/)
    await transport.close()
})

test('presence announces the layout this peer speaks, so the hub can address it unprompted', async (t) => {
    // Announced by open() itself, on connect, which is the only moment it can be: the hub has to
    // know how to answer this peer before it has anything to answer.
    const { transport, sent, handlers } = await transportOn(peer('hmi4'))

    const announced = sent.find((one) => one.method === PRESENCE_EVENT)!.arg as { name: string; v: number }
    t.is(announced.name, peer('hmi4'))
    t.is(announced.v, FLAT_FRAME_VERSION, 'a peer that announces and then only listens is still addressable')

    // And the hub's answer is the snapshot that makes discovery work at all.
    const online: string[] = []
    transport.on(TransportEvent.peerOnline, (name: string) => online.push(name))
    handlers.get(PRESENCE_EVENT)!({ peers: [peer('vs4'), peer('other4')] } as never)
    t.deepEqual(online.sort(), [peer('other4'), peer('vs4')].sort())
    await transport.presenceSettled()
    t.pass('and the first picture having arrived is what settles the sweep')

    await transport.close()
})

test('a batch travels as one frame carrying many', async (t) => {
    const { transport, sent } = await transportOn(peer('hmi5'))
    const call = (id: string, tag: string) => ({ type: RpcMessageType.CallInstanceMethod, id, path: 'meter', method: 'read', params: [tag] })
    await transport.receive(
        { type: MessageType.RequestMessage, payload: { type: RpcMessageType.batch, payloads: [call('c-1', 'a'), call('c-2', 'b')] } } as Message,
        peer('hmi5'),
        peer('vs5')
    )

    const [frame] = frameSent(sent)
    t.is(frame.kind, 'batch')
    t.is(frame.batch?.length, 2)
    t.deepEqual(
        frame.batch?.map((one) => one.corr),
        ['c-1', 'c-2'],
        'each keeps its own correlation, because a batch is an envelope and not a transaction'
    )
    await transport.close()
})

test('sending with no link throws rather than discarding the call', async (t) => {
    const { transport } = await transportOn(peer('hmi6'), 'Disconnected')
    const call = {
        type: MessageType.RequestMessage,
        payload: { type: RpcMessageType.CallInstanceMethod, id: 'c-9', path: 'solution', method: 'open', params: [] }
    } as Message

    // The failure has to reach the caller. Sending used to be a promise that resolved having done
    // nothing, which left the call waiting out its whole timeout for a frame that was never going
    // to be sent - the same trap SocketIoClientTransport.requireSocket exists to close.
    await t.throwsAsync(transport.receive(call, peer('hmi6'), peer('vs6')), { message: /not connected/ })
    await transport.close()
})

test('the first connection retries too, because a peer may come up before its hub does', async (t) => {
    let attempts = 0
    const stub = stubConnection()
    // Fails twice and then succeeds, which is a hub finishing its own startup - or a maintenance
    // window ending - while a peer that wants it is already running.
    ;(stub.connection as unknown as { start: () => Promise<void> }).start = async () => {
        attempts++
        if (attempts < 3) throw new Error('hub is down')
    }
    const errors: unknown[] = []
    const transport = new SignalRClientTransport(peer('coldstart'), 'http://localhost:0/rpc', undefined, {}, true, [0, 0, 0], () => stub.connection)
    transport.on(TransportEvent.transportError, (e: unknown) => errors.push(e))

    // Must not reject. `withAutomaticReconnect` does not cover the initial start(), so this used to
    // be one attempt and then silence - and the caller had no way to tell a hub that was down from
    // one that was never coming.
    await t.notThrowsAsync(transport.open())

    const deadline = Date.now() + 5000
    while (!transport.connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))

    t.true(transport.connected, 'it kept trying and got there')
    t.is(attempts, 3, 'two failures and the attempt that worked')
    t.is(errors.length, 2, 'and each failure was reported rather than swallowed')

    await transport.close()
})

test('closing while it is still trying to connect does not leave a retry armed', async (t) => {
    let attempts = 0
    const stub = stubConnection()
    ;(stub.connection as unknown as { start: () => Promise<void> }).start = async () => {
        attempts++
        throw new Error('hub is down')
    }
    const transport = new SignalRClientTransport(peer('giveup'), 'http://localhost:0/rpc', undefined, {}, true, [5], () => stub.connection)
    await transport.open()
    await transport.close()

    // A timer left armed by the retry loop would bring the link back up under a transport its owner
    // has finished with - and would keep the process alive doing it.
    const after = attempts
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.is(attempts, after, 'nothing tried again after close()')
})
