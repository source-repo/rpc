import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, SCHEMA_VERSION, rpc, rpcNamespace, type RpcSchema } from '../index.js'
import { RpcComponent, componentHost } from './Component.js'
import { replaceEqualDeep, rpcComponent, type RpcComponentChannelOptions } from './ComponentClient.js'
import type { RpcPersistedSnapshot } from './Snapshots.js'
import type { SocketIoClientTransport } from '../Transports/SocketIoClientTransport.js'
import { TransportEvent } from './Core.js'

/**
 * The observable component: cached reads, one shared channel, and a status that tells the truth.
 * Ordering is proven with held state and counters, not timing, wherever the transport allows it.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

type OvenProps = { unit: string; maximum: number }
type OvenState = { temperature: number; mode: string }

@rpcNamespace('oven')
class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: '°C', maximum: 200 }, { temperature: 20, mode: 'idle' })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }

    /** Several commits in one turn, so coalescing has something to coalesce. */
    @rpc({ semantics: 'idempotent-command' })
    async warm(steps: number) {
        for (let step = 0; step < steps; step++) this.setState((previous) => ({ temperature: previous.temperature + 1 }))
        return this.state.temperature
    }

    @rpc({ semantics: 'query' })
    async ping() {
        return 'pong'
    }

    /** Unmarked, so never exposed: the bug under test is local server code, not a caller. */
    corrupt() {
        this.setState({ temperature: 'boiling' as unknown as number })
    }
}

type FieldProps = { site: string }
type FieldState = { mode: string; zones: { top: { setpoint: number }; bottom: { setpoint: number } } }

/** Nested on purpose: flat state cannot show the difference between a branch that moved and one that did not. */
@rpcNamespace('field')
class Field extends RpcComponent<FieldProps, FieldState> {
    constructor() {
        super({ site: 'bakery' }, { mode: 'idle', zones: { top: { setpoint: 180 }, bottom: { setpoint: 170 } } })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setTop(celsius: number) {
        this.setState((previous) => ({ zones: { ...previous.zones, top: { setpoint: celsius } } }))
        return celsius
    }
}

class Ordinary {
    async ping() {
        return 'pong'
    }
}

/** The store is injected for exactly this: the behaviour is testable without a browser. */
const memoryStore = () => {
    const held = new Map<string, RpcPersistedSnapshot>()
    return {
        held,
        read: (key: string) => Promise.resolve(held.get(key)),
        write: (key: string, snapshot: RpcPersistedSnapshot) => {
            held.set(key, snapshot)
            return Promise.resolve()
        },
        remove: (key: string) => {
            held.delete(key)
            return Promise.resolve()
        }
    }
}

/** An activity signal a test can drive, which is the whole reason the real one is injected. */
const controllable = () => {
    let active = true
    const listeners = new Set<(next: boolean) => void>()
    return {
        get active() {
            return active
        },
        subscribe: (onChange: (next: boolean) => void) => {
            listeners.add(onChange)
            return () => listeners.delete(onChange)
        },
        set: (next: boolean) => {
            active = next
            for (const listener of [...listeners]) listener(next)
        }
    }
}

const pair = async (port: number, client?: Partial<{ components: RpcComponentChannelOptions }>) => {
    const server = new RpcServer({ name: peer(`host${port}`), transports: [{ port }] })
    await server.ready()
    const oven = new Oven()
    server.exposeClassInstance(oven)
    server.exposeClassInstance(new Field())
    server.exposeClassInstance(new Ordinary(), 'ordinary')
    const watcher = new RpcClient(`http://localhost:${port}`, { name: peer(`watcher${port}`), defaultTarget: peer(`host${port}`), ...client })
    await watcher.ready()
    return {
        server,
        oven,
        client: watcher,
        socket: () => (watcher.options.transport as SocketIoClientTransport).socket!,
        dispose: async () => {
            await watcher.close()
            await server.close()
        }
    }
}

/**
 * A hub, a producer that dials into it, and an observer on the hub.
 *
 * This is the topology `pair` cannot express, and the one the peer-return defect lived in. `pair`
 * puts the client on the very server it watches, so killing that server takes the observer's link
 * with it and the reconnect does the repair. Behind a bus the observer's link is never touched when
 * the observed peer restarts - so nothing replayed, and nothing was listening for the peer itself.
 */
const bus = async (port: number, producerName: string) => {
    const hub = new RpcServer({ name: peer(`hub${port}`), transports: [{ port }] })
    await hub.ready()
    const start = async () => {
        const producer = new RpcServer({ name: peer(producerName), transports: [{ connect: `http://localhost:${port}` }] })
        const oven = new Oven()
        producer.exposeClassInstance(oven)
        await producer.ready()
        return { producer, oven }
    }
    let running: Awaited<ReturnType<typeof start>> | undefined = await start()
    const observer = new RpcClient(`http://localhost:${port}`, { name: peer(`observer${port}`), defaultTarget: peer(producerName), callTimeout: 4000 })
    const seen: string[] = []
    observer.on(TransportEvent.peerOnline, (found: string) => seen.push(found))
    await observer.ready()
    await waitFor(() => seen.includes(peer(producerName)))
    return {
        observer,
        /** The live instance, which is a different object after a restart - which is the point. */
        oven: () => running!.oven,
        stop: async () => {
            await running!.producer.close()
            running = undefined
        },
        startAgain: async () => void (running = await start()),
        restart: async () => {
            await running!.producer.close()
            running = await start()
        },
        dispose: async () => {
            await observer.close()
            await running?.producer.close()
            await hub.close()
        }
    }
}

test('component() resolves with a readable snapshot, and commits flow to the cache', async (t) => {
    const { oven, client, dispose } = await pair(3861)
    const remote = await client.component<Oven>('oven')

    // Synchronous reads, no network hop, from the first line that can execute.
    t.is(remote.props.unit, '°C')
    t.is(remote.state.mode, 'idle')

    t.is(await remote.setMode('heating'), 'heating')
    await waitFor(() => remote.state.mode === 'heating')
    t.is(oven.state.mode, 'heating', 'the server-side view should agree')

    const store = remote[rpcComponent]
    t.is(store.getSnapshot().status, 'live')
    await store.close()
    await dispose()
})

test('same-turn commits publish once, and local state never lags', async (t) => {
    const { client, dispose } = await pair(3862)
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]

    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)

    t.is(await remote.warm(5), 25, 'the server saw every commit immediately')
    await waitFor(() => remote.state.temperature === 25)
    // Five commits, one microtask window, one snapshot on the wire. The revision may skip - it
    // must only never move backwards - so the count of notifications is what proves coalescing.
    t.is(notifications, 1, `five same-turn commits published ${notifications} snapshots`)

    unsubscribe()
    await store.close()
    await dispose()
})

test('the host replaces props and every watcher learns it', async (t) => {
    const { oven, client, dispose } = await pair(3863)
    const remote = await client.component<Oven>('oven')

    const host = componentHost(oven)
    host.replaceProps((props) => ({ ...props, maximum: 250 }))
    await waitFor(() => remote.props.maximum === 250)
    t.is(remote.props.unit, '°C', 'replacement is whole-snapshot, not a lossy patch')

    await remote[rpcComponent].close()
    await dispose()
})

test('a dropped link marks the view stale, keeps it readable, and reconnect heals it', async (t) => {
    const { oven, client, socket, dispose } = await pair(3864)
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]
    await remote.setMode('heating')
    await waitFor(() => remote.state.mode === 'heating')

    const reconnected = new Promise<void>((resolve) => client.once(TransportEvent.connected, () => resolve()))
    socket().disconnect()
    await waitFor(() => store.getSnapshot().status === 'stale')
    // Last known beats undefined: the number is still there, with its age on it.
    t.is(remote.state.mode, 'heating')
    t.true((store.getSnapshot().staleSince ?? 0) > 0)

    // A commit made while unreachable is exactly what the resubscription snapshot must repair -
    // one frame carrying current state, not a replay of everything missed.
    await oven.setMode('cooling')
    socket().connect()
    await reconnected
    await waitFor(() => store.getSnapshot().status === 'live')
    t.is(remote.state.mode, 'cooling', 'the reconnect snapshot should carry what changed while away')

    await store.close()
    await dispose()
})

test('a reconnect with nothing to report still clears stale, without ageing the value', async (t) => {
    const { client, socket, dispose } = await pair(3871)
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]
    await remote.setMode('heating')
    await waitFor(() => remote.state.mode === 'heating')
    const before = store.getSnapshot()

    const reconnected = new Promise<void>((resolve) => client.once(TransportEvent.connected, () => resolve()))
    socket().disconnect()
    await waitFor(() => store.getSnapshot().status === 'stale')

    // The test above commits while the link is down, so its repair carries a higher revision and
    // takes the ordinary path. This is the case that does not, and it is the common one: nothing
    // moved while away, so the targeted snapshot answering the re-subscribe is the revision the
    // observer already holds. Discarding it - which is what the acceptance rules used to do -
    // left a perfectly healthy feed reading `stale` for ever, indistinguishable from a peer that
    // had gone quiet.
    socket().connect()
    await reconnected
    await waitFor(() => store.getSnapshot().status === 'live')

    const after = store.getSnapshot()
    t.is(after.revision, before.revision, 'nothing was published, so nothing moved')
    t.is(after.receivedAt, before.receivedAt, 'the value is no newer than it was')
    t.true(after.confirmedAt > before.confirmedAt, 'but the feed has just proved it is current')
    t.is(after.staleSince, undefined, 'and it is no longer stale since anything')
    t.is(after.state, before.state, 'identities survive a confirmation, so a memoizing reader sees nothing move')

    await store.close()
    await dispose()
})

test('a peer that restarts behind a bus is recovered, though the observer never lost its link', async (t) => {
    const { observer, oven, restart, dispose } = await bus(3872, 'producer3872')
    const remote = await observer.component<Oven>('oven')
    const store = remote[rpcComponent]
    await remote.setMode('heating')
    await waitFor(() => remote.state.mode === 'heating')
    const before = store.getSnapshot().epoch

    // Asserted rather than assumed, because the whole defect is that this is the one thing that
    // does not move: if the observer's link dropped, `connected` would replay the subscription and
    // the test would pass for a reason that has nothing to do with the fix.
    let link = 0
    observer.on(TransportEvent.disconnected, () => link++)
    observer.on(TransportEvent.connected, () => link++)

    // Recorded as it happens rather than polled for. `restart` returns only once the replacement is
    // ready, so the recovery can outrun a poll and the stale window be over before anyone looks -
    // which would make the interesting half of this invisible rather than absent.
    const transitions: { status: string; mode: unknown }[] = []
    const stop = store.subscribe(() => transitions.push({ status: store.getSnapshot().status, mode: (store.getSnapshot().state as OvenState).mode }))

    await restart()
    // peerOnline, and nothing else, has to do this.
    await waitFor(() => store.getSnapshot().status === 'live' && store.getSnapshot().epoch !== before)
    stop()

    const stale = transitions.find((seen) => seen.status === 'stale')
    t.truthy(stale, `the peer going should have staled the view: ${JSON.stringify(transitions)}`)
    t.is(stale?.mode, 'heating', 'and last known stays readable while it is stale, as it does for a lost link')
    t.is(link, 0, 'the observer never lost its link - only the peer went')
    t.is(remote.state.mode, 'idle', 'the fresh snapshot is the new world rather than the old one')

    // The strong half: one repaired frame proves a snapshot arrived, and a commit afterwards proves
    // the subscription is real. Without the replay the revived peer holds none, so this never lands.
    await oven().setMode('cooling')
    await waitFor(() => remote.state.mode === 'cooling')
    t.is(remote.state.mode, 'cooling', 'and the feed keeps pushing afterwards')

    await store.close()
    await dispose()
})

test('a replay that went out too early is retried, and the retry alone brings the channel back', async (t) => {
    const { observer, oven, stop, startAgain, dispose } = await bus(3873, 'producer3873')
    // Only the numbers are shortened; the chain under test is the shipped one.
    observer.rpcClient!.resubscribeRetry = { attempts: 10, baseMs: 60, capMs: 300 }
    const remote = await observer.component<Oven>('oven')
    const store = remote[rpcComponent]
    const before = store.getSnapshot().epoch

    await stop()
    await waitFor(() => store.getSnapshot().status === 'stale')

    // A replay issued while the peer is not there to answer it - in a plant, a peer still booting
    // when the reconnect's replay went out, which is a race; here it is arranged instead. The
    // failure is timing rather than a decision, so a retry chain takes it from there.
    await observer.rpcClient!.resubscribe()

    // And with peerOnline taken off, that chain is the only thing that can restore this: the
    // producer really does come back, and this observer is told nothing about it.
    observer.options.transport!.removeAllListeners(TransportEvent.peerOnline)
    await startAgain()

    await waitFor(() => store.getSnapshot().status === 'live' && store.getSnapshot().epoch !== before, 15000)
    t.not(store.getSnapshot().epoch, before, 'the retry alone restored it')

    await oven().setMode('cooling')
    await waitFor(() => remote.state.mode === 'cooling')
    t.is(remote.state.mode, 'cooling', 'and what it restored is a real subscription, not one repaired frame')

    await store.close()
    await dispose()
})

test('replaceEqualDeep reproduces the frame exactly, and only identities change', (t) => {
    const previous = { a: { x: 1 }, b: [1, 2], d: new Date(5), bin: new Uint8Array([1, 2]) }

    // Same values throughout, all freshly built: every node shares, so the root itself comes back.
    t.is(replaceEqualDeep(previous, { a: { x: 1 }, b: [1, 2], d: new Date(5), bin: previous.bin }), previous)

    // One leaf moved. The branch above it is new, its sibling is not, and the result is deep-equal
    // to the frame - which is the invariant the whole thing turns on.
    const next = { a: { x: 2 }, b: [1, 2], d: new Date(5), bin: previous.bin }
    const shared = replaceEqualDeep(previous, next)
    t.not(shared, previous)
    t.deepEqual(shared, next)
    t.is(shared.b, previous.b, 'the untouched array keeps its identity')
    t.not(shared.a, previous.a)

    // A buffer is compared by reference and never walked, so a decoded copy is a different value.
    // That is deliberate: walking a waveform on every publish would cost more than sharing saves.
    t.not(replaceEqualDeep(previous, { ...next, a: previous.a, bin: new Uint8Array([1, 2]) }).bin, previous.bin)

    // The same number of keys is not the same keys. Sharing the root here would hand back `{ a }`
    // where the frame said `{ z }`, which is the frame being contradicted rather than reproduced.
    t.deepEqual(replaceEqualDeep({ a: undefined }, { z: undefined }), { z: undefined })

    // And a field the frame no longer carries is gone rather than retained - the one behaviour that
    // separates this from a merge, and the reason a re-projected channel cannot strand a value.
    t.deepEqual(replaceEqualDeep({ a: 1, b: 2 }, { a: 1 }), { a: 1 })
})

test('an unchanged branch keeps its identity across a publish, and a changed one does not', async (t) => {
    const { client, dispose } = await pair(3874)
    const field = await client.component<Field>('field')
    const store = field[rpcComponent]
    const before = store.getSnapshot()

    t.is(await field.setTop(190), 190)
    await waitFor(() => store.getSnapshot().state.zones.top.setpoint === 190)
    const after = store.getSnapshot()

    t.not(after.state, before.state, 'state moved, so state is a new object')
    t.not(after.state.zones, before.state.zones, 'and so is every branch above what moved')
    t.not(after.state.zones.top, before.state.zones.top)
    t.is(after.state.zones.bottom, before.state.zones.bottom, 'the sibling that did not move keeps its identity')
    t.is(after.props, before.props, 'and props, which nothing touched at all')

    await store.close()
    await dispose()
})

test('a selector re-renders for what it selected and nothing else, and never loses the status', async (t) => {
    const { client, socket, dispose } = await pair(3875)
    const field = await client.component<Field>('field')
    const store = field[rpcComponent]

    const bottom = store.at<{ setpoint: number }>(['state', 'zones', 'bottom'])
    let notified = 0
    const stop = bottom.subscribe(() => notified++)
    const first = bottom.getSnapshot()
    t.deepEqual(first.value, { setpoint: 170 })
    t.is(first.status, 'live')

    // A commit elsewhere in the same snapshot: a publish, a new view, and nothing this selector is
    // looking at. Only correct because the object it selected kept its identity underneath.
    t.is(await field.setTop(195), 195)
    await waitFor(() => store.getSnapshot().state.zones.top.setpoint === 195)
    t.is(notified, 0, 'a branch that did not move must not re-render')
    t.is(bottom.getSnapshot(), first, 'and the selected value keeps its identity')

    // The link going is not a change of value, and it still has to reach the selector: a pane
    // drawing 170 with nothing to say it is no longer current is exactly what this channel exists
    // to prevent, and an optimisation that swallowed the transition would reintroduce it.
    socket().disconnect()
    await waitFor(() => store.getSnapshot().status === 'stale')
    t.true(notified > 0, 'a feed going stale must re-render a pane bound to one value')
    t.is(bottom.getSnapshot().status, 'stale')
    t.deepEqual(bottom.getSnapshot().value, { setpoint: 170 }, 'last known, still readable')

    stop()
    await store.close()
    await dispose()
})

test('a channel closed and reopened inside the keep-alive window never left', async (t) => {
    const { oven, client, dispose } = await pair(3876, { components: { keepAliveMs: 2000 } })
    const first = await client.component<Oven>('oven')
    const store = first[rpcComponent]
    t.is(await first.setMode('heating'), 'heating')
    await waitFor(() => first.state.mode === 'heating')
    const revision = store.getSnapshot().revision

    await store.close()
    // Not `closed`: nobody unsubscribed, so there is nothing to restore and nothing to say about it.
    t.is(store.getSnapshot().status, 'live', 'the window holds the subscription rather than dropping it')

    const again = await client.component<Oven>('oven')
    t.is(again[rpcComponent], store, 'the reopen is the same channel rather than a new one')
    t.is(store.getSnapshot().revision, revision, 'so nothing crossed the wire to rebuild it')

    // And it is a real subscription underneath rather than a cache that merely looks live.
    await oven.setMode('cooling')
    await waitFor(() => again.state.mode === 'cooling')
    t.is(again.state.mode, 'cooling')

    await again[rpcComponent].close()
    await dispose()
})

test('an inactive peer stops listening, and coming back is one snapshot rather than a replay', async (t) => {
    const activity = controllable()
    const { oven, client, dispose } = await pair(3877, { components: { activity, activityGraceMs: 10 } })
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]
    t.is(store.getSnapshot().status, 'live')

    activity.set(false)
    await waitFor(() => store.getSnapshot().status === 'stale')
    // Paused is not live. Nothing is arriving, so the freshness is unknown and the view says so
    // rather than going on claiming a number nobody is telling it about any more.
    t.is(remote.state.mode, 'idle', 'and last known stays readable, as it does for a lost link')

    // Committed while nobody was listening. It must not arrive - that is the entire point, and the
    // bandwidth it saves is the reason the option exists.
    await oven.setMode('heating')
    await new Promise((resolve) => setTimeout(resolve, 150))
    t.is(remote.state.mode, 'idle', 'a paused channel must not still be receiving')

    activity.set(true)
    await waitFor(() => store.getSnapshot().status === 'live')
    t.is(remote.state.mode, 'heating', 'and the resume is repaired by one targeted snapshot, not a replay')

    await store.close()
    await dispose()
})

test('a reload comes back with last known values and their age, never with a live claim', async (t) => {
    const store = memoryStore()
    const { client, dispose } = await pair(3878, { components: { persistence: { store, scope: 'operator@site-a', maxAgeMs: 60_000, writeEveryMs: 0 } } })
    const remote = await client.component<Oven>('oven')
    t.is(await remote.setMode('heating'), 'heating')
    await waitFor(() => remote.state.mode === 'heating')
    const view = remote[rpcComponent].getSnapshot()

    // Written on the way past rather than on demand: the page that needs it is not running yet.
    t.is(store.held.size, 1)
    const record = [...store.held.values()][0]
    t.is((record.state as OvenState).mode, 'heating')
    // A lease carries an expiry stamped on somebody else's clock, and the plant may have been handed
    // to another panel while this page was not running. Values keep; arbitration does not.
    t.false('authority' in record, 'a held lease must not survive a reload')

    const back = await client.lastKnown<Oven>('oven')
    t.is(back?.status, 'stale', 'a restored view is never live')
    t.is(back?.state.mode, 'heating')
    t.is(back?.receivedAt, view.receivedAt, 'the values keep the age they actually had')
    t.is(back?.staleSince, record.writtenAt, 'stale since it was written, not since the page started')

    // A different projection is a different question, and answering it from this record would be
    // handing back something claiming a shape it does not have.
    t.is(await client.lastKnown<Oven>('oven', undefined, { paths: [['state', 'mode']] }), undefined)

    await remote[rpcComponent].close()
    await dispose()
})

test('a record too old, or from a clock that ran backwards, is not drawn at all', async (t) => {
    const store = memoryStore()
    const { client, dispose } = await pair(3879, { components: { persistence: { store, scope: 'operator@site-a', maxAgeMs: 60_000, writeEveryMs: 0 } } })
    const remote = await client.component<Oven>('oven')
    await waitFor(() => store.held.size === 1)
    const key = [...store.held.keys()][0]
    const record = store.held.get(key)!

    // Older than the deployment says is worth showing.
    store.held.set(key, { ...record, writtenAt: Date.now() - 120_000 })
    t.is(await client.lastKnown<Oven>('oven'), undefined)
    t.is(store.held.size, 0, 'and dropped on the way past rather than refused again on every reload')

    // From the future. A clock that moved backwards is not evidence about a plant, and a value
    // whose age nobody can reason about is worse than no value.
    store.held.set(key, { ...record, writtenAt: Date.now() + 120_000 })
    t.is(await client.lastKnown<Oven>('oven'), undefined)

    await remote[rpcComponent].close()
    await dispose()
})

test('two watchers share one subscription, and one leaving does not blind the other', async (t) => {
    const { server, client, dispose } = await pair(3865)
    const first = await client.component<Oven>('oven')
    const second = await client.component<Oven>('oven')

    t.is(server.rpc.eventProxies.size, 1, 'two component() calls should share one remote subscription')

    await first[rpcComponent].close()
    t.is(server.rpc.eventProxies.size, 1, 'the first watcher leaving should not unsubscribe the second')
    await second.setMode('heating')
    await waitFor(() => second.state.mode === 'heating')

    await second[rpcComponent].close()
    await waitFor(() => server.rpc.eventProxies.size === 0)
    t.is(second[rpcComponent].getSnapshot().status, 'closed')

    await dispose()
})

test('$with keeps the component surface, and assignment is refused', async (t) => {
    const { client, dispose } = await pair(3866)
    const remote = await client.component<Oven>('oven')

    const optioned = remote.$with({ timeoutMs: 5000 })
    t.is(await optioned.setMode('manual'), 'manual')
    await waitFor(() => optioned.state.mode === 'manual')
    t.is(optioned.props.unit, '°C', '$with dropped the cached snapshot surface')

    t.throws(() => void ((remote as { state: unknown }).state = {}), { instanceOf: TypeError })
    t.throws(() => void ((remote as { props: unknown }).props = {}), { instanceOf: TypeError })

    await remote[rpcComponent].close()
    await dispose()
})

test('the protected helpers are not remotely callable, and ordinary instances are not components', async (t) => {
    const { client, dispose } = await pair(3867)

    const bare = await client.proxy<Oven>('oven')
    // The allow-list is the guarantee: setState is unmarked, so it is not on the method map.
    const refusal = await t.throwsAsync((bare as unknown as { setState: (u: unknown) => Promise<unknown> }).setState({ mode: 'hacked' }))
    t.regex(String(refusal?.message), /MethodNotFound/)

    // And an ordinary instance refuses component() with a name, not a hang.
    const wrong = await t.throwsAsync(client.component('ordinary'))
    t.regex(String(wrong?.message), /not an observable component/)

    // Having refused it, it leaves nothing behind. Both halves of a subscription are registered
    // before the call is issued - the server attaches its listener before answering with a
    // snapshot, so a handler put on after the reply could miss what landed between them - which
    // makes unwinding the only way a refusal can avoid leaving a phantom that every later
    // reconnect replays, against a namespace that has already said no and with no channel behind it.
    t.is(client.rpcClient!.subscriptions.size, 0, 'a refused subscribe must leave no subscription to replay')

    await dispose()
})

test('a restarted component is a new epoch, and the fresh snapshot replaces the old world', async (t) => {
    const { server, client, dispose } = await pair(3868)
    const remote = await client.component<Oven>('oven')
    const firstEpoch = remote[rpcComponent].getSnapshot().epoch

    // A real restart: the server dies and a new process takes its name and port. The client's
    // transport reconnects on its own, resubscription replays the snapshot subscription, and the
    // answering snapshot carries a new epoch - which must win over everything the old world sent.
    await server.close()
    const revived = new RpcServer({ name: peer('host3868'), transports: [{ port: 3868 }] })
    const rebuilt = new Oven()
    await rebuilt.setMode('recovered')
    revived.exposeClassInstance(rebuilt)
    await revived.ready()

    await waitFor(() => remote.state.mode === 'recovered', 10000)
    t.not(remote[rpcComponent].getSnapshot().epoch, firstEpoch)
    t.is(remote[rpcComponent].getSnapshot().status, 'live')

    await remote[rpcComponent].close()
    await client.close()
    await revived.close()
    // The first server is already closed; dispose would close the client again, harmlessly.
    await dispose().catch(() => undefined)
})

test('an invalid snapshot commit is refused before it becomes current', async (t) => {
    const schema: RpcSchema = {
        schema: SCHEMA_VERSION,
        namespaces: {
            oven: {
                methods: {},
                component: {
                    snapshot: 1,
                    props: { kind: 'object', fields: { unit: { type: { kind: 'string' } }, maximum: { type: { kind: 'number' } } } },
                    state: { kind: 'object', fields: { temperature: { type: { kind: 'number' } }, mode: { type: { kind: 'string' } } } }
                }
            }
        }
    }
    const server = new RpcServer({ name: peer('checked'), transports: [{ port: 3869 }], schema, validateComponentSnapshots: true, validation: 'off' })
    await server.ready()
    const oven = new Oven()
    server.exposeClassInstance(oven)

    // The bad commit throws at the setState call site - where the bug is - and changes nothing.
    const failure = t.throws(() => oven.corrupt())
    t.regex(String(failure?.message), /snapshot rejected/)
    t.is(oven.state.temperature, 20, 'the previous snapshot should remain current')

    // A valid commit still flows, so the validator gates rather than jams.
    await oven.setMode('heating')
    t.is(oven.state.mode, 'heating')

    await server.close()
})

test('a server observes a component over its own dialled link, like a console page does', async (t) => {
    const host = new RpcServer({ name: peer('host3870'), transports: [{ port: 3870 }] })
    await host.ready()
    const oven = new Oven()
    host.exposeClassInstance(oven)

    // The observer is itself a server that dials out - the browser console's exact shape, which is
    // the peer this surface exists for: it serves chat and observes components over one link.
    const page = new RpcServer({ name: peer('page3870'), transports: [{ connect: 'http://localhost:3870' }] })
    await page.ready()
    // Presence arrives after the link does, and calling before it lands is a routing error by
    // design - the TransportError says to await it. Windows CI is where the gap is real.
    await waitFor(() => page.peers.get(peer('host3870')) !== undefined)
    const remote = await page.component<Oven>('oven', peer('host3870'))

    t.is(remote.props.unit, '°C')
    t.is(await remote.setMode('heating'), 'heating')
    await waitFor(() => remote.state.mode === 'heating')

    const store = remote[rpcComponent]
    t.is(store.getSnapshot().status, 'live')

    // The host going away must read as staleness, not as a number that stopped moving.
    await host.close()
    await waitFor(() => store.getSnapshot().status === 'stale')
    t.is(remote.state.mode, 'heating', 'last known stays readable while stale')

    await page.close()
    t.is(store.getSnapshot().status, 'closed', 'closing the observer tells its stores')
})
