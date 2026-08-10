import test from 'ava'
import { randomUUID } from 'crypto'
import { rpc, rpcNamespace, rpcComponent, rpcPath, rpcRoot, RpcClient, RpcComponent, RpcServer } from './index.js'

/**
 * Per-subscriber projection: asking for the paths a screen shows instead of the whole state.
 *
 * The channel sends a snapshot whole on every change, which is free for a mode and a health and is
 * the link itself for three hundred tags - a 12 kB snapshot is eighty seconds at 1200 baud, so a
 * panel showing twenty values cannot be drawn at all. What comes back is still a *whole* snapshot,
 * of the projection, so nothing that makes this channel simple is given up: duplicate delivery is
 * still harmless and a reconnect is still one frame rather than a replay.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

type FieldProps = { label: string; tags: number }
type FieldState = { fast: number; sweep: number; zones: { top: { setpoint: number; temperature: number } }; tags: { [tag: string]: number } }

@rpcNamespace('field')
class Field extends RpcComponent<FieldProps, FieldState> {
    constructor() {
        const tags: { [tag: string]: number } = {}
        for (let index = 0; index < 300; index++) tags[`tag.${String(index).padStart(3, '0')}`] = index
        super({ label: 'f', tags: 300 }, { fast: 0, sweep: 0, zones: { top: { setpoint: 20, temperature: 19 } }, tags })
    }

    @rpc({ semantics: 'idempotent-command' })
    async tick() {
        this.setState((previous) => ({ fast: previous.fast + 1 }))
        return this.state.fast
    }
}

const state = rpcRoot<FieldState>()
/** Spelled from the root a path starts at, which is how a projection says props or state. */
const inState = (path: string[]) => ['state', ...path]

test('a projection narrows what arrives, and says so rather than looking like a state that shrank', async (t) => {
    const server = new RpcServer({ name: peer('field3901'), transports: [{ port: 3901, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3901', { name: peer('asker3901'), defaultTarget: peer('field3901') })
    const narrow = await client.component<Field>('field', undefined, {
        paths: [inState(rpcPath(state.fast)), inState(rpcPath(state.zones.top.setpoint)), ['props', 'label']]
    })
    const store = narrow[rpcComponent]

    const view = store.getSnapshot()
    t.deepEqual(view.state, { fast: 0, zones: { top: { setpoint: 20 } } }, 'only the named paths, and the branches they pass through')
    t.deepEqual(view.props, { label: 'f' })
    t.is(Object.keys(view.state.tags ?? {}).length, 0, 'three hundred tags nobody asked for do not travel')

    // The field that makes a partial snapshot readable as one. Without it a narrowed subscription
    // and a component that dropped half its state are the same bytes, and a cache merging them
    // would be inventing.
    t.deepEqual(view.projection, [
        ['state', 'fast'],
        ['state', 'zones', 'top', 'setpoint'],
        ['props', 'label']
    ])

    // Still an ordinary snapshot channel: a commit republishes, narrowed the same way, and the
    // revision moves as it always did.
    await narrow.tick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const moved = store.getSnapshot()
    t.is(moved.state.fast, 1)
    t.true(moved.revision > view.revision)
    t.is(Object.keys(moved.state.tags ?? {}).length, 0, 'and it stays narrow on every frame, not just the first')

    await store.close()
    await client.close()
    await server.close()
})

test('the whole snapshot is still the default, and one peer holds one projection per component', async (t) => {
    const server = new RpcServer({ name: peer('field3902'), transports: [{ port: 3902, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3902', { name: peer('asker3902'), defaultTarget: peer('field3902') })

    // Asking for nothing in particular is what every existing caller does, and must not change.
    const whole = await client.component<Field>('field')
    const view = whole[rpcComponent].getSnapshot()
    t.is(Object.keys(view.state.tags).length, 300)
    t.is(view.projection, undefined, 'a whole snapshot claims no projection, so nothing reads it as partial')

    // The server keys a subscription by (instance, event, peer), so a second view with different
    // paths would be one subscription whose contents depended on who opened first. Refused, naming
    // both, rather than silently serving the other one's paths.
    const conflict = await t.throwsAsync(client.component<Field>('field', undefined, { paths: [inState(['fast'])] }))
    t.regex(String(conflict?.message), /already observed here with a different projection/)
    t.regex(String(conflict?.message), /the whole snapshot against state\.fast/)

    // The same projection is the same subscription, which is what keeps two panes on one component
    // costing one of them.
    const again = await client.component<Field>('field')
    t.is(again[rpcComponent].getSnapshot().revision, view.revision)

    await whole[rpcComponent].close()
    await again[rpcComponent].close()
    await client.close()
    await server.close()
})

test('a record can be paged without ever being fetched whole', async (t) => {
    const server = new RpcServer({ name: peer('field3904'), transports: [{ port: 3904, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3904', { name: peer('asker3904'), defaultTarget: peer('field3904') })
    // The case the whole thing exists for: three hundred tags whose keys are data, not type. The
    // contract says `{ [tag: string]: number }` and stops, so a caller cannot name page two - the
    // only path reaching those entries is the record itself, which is all three hundred.
    const page = await client.component<Field>('field', undefined, { paths: [{ path: ['state', 'tags'], offset: 0, limit: 50 }] })
    const store = page[rpcComponent]

    const view = store.getSnapshot()
    t.is(Object.keys(view.state.tags).length, 50, 'a page, not the record')
    t.is(view.state.tags['tag.000'], 0)
    t.is(view.state.tags['tag.049'], 49)
    t.is(view.state.tags['tag.050'] as number | undefined, undefined, 'and nothing beyond it')

    // The one thing a caller cannot work out for itself: how many pages there are. Its own entries
    // say what is on this page and nothing about the size of the set they came from.
    t.deepEqual(view.slices?.length, 1)
    t.is(view.slices?.[0].total, 300)
    t.is(view.slices?.[0].offset, 0)
    t.is(view.slices?.[0].keys.length, 50)

    await store.close()
    await client.close()
    await server.close()
})

test('turning a page is a re-projection, and the keys keep a stable order across one', async (t) => {
    const server = new RpcServer({ name: peer('field3912'), transports: [{ port: 3912, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3912', { name: peer('asker3912'), defaultTarget: peer('field3912') })
    const first = await client.component<Field>('field', undefined, { paths: [{ path: ['state', 'tags'], offset: 0, limit: 10 }] })
    t.deepEqual(Object.keys(first[rpcComponent].getSnapshot().state.tags).sort().slice(0, 2), ['tag.000', 'tag.001'])
    await first[rpcComponent].close()

    // Only the offset changed. sameProjection compares by value rather than identity, and a paged
    // caller depends on exactly that: a comparison that missed it would leave the subscription on
    // page one while the grid showed page two, which is the kind of wrong that looks like working.
    const second = await client.component<Field>('field', undefined, { paths: [{ path: ['state', 'tags'], offset: 10, limit: 10 }] })
    const view = second[rpcComponent].getSnapshot()
    const keys = Object.keys(view.state.tags).sort()
    t.is(keys.length, 10)
    t.is(keys[0], 'tag.010', 'the next page, sorted so an offset means the same thing twice running')
    t.is(view.slices?.[0].offset, 10)
    t.is(view.slices?.[0].total, 300, 'and the size of the set is still reported')

    await second[rpcComponent].close()
    await client.close()
    await server.close()
})

test('a slice taking nothing is a count, for one number rather than a record', async (t) => {
    const server = new RpcServer({ name: peer('field3915'), transports: [{ port: 3915, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3915', { name: peer('asker3915'), defaultTarget: peer('field3915') })
    // How many pages are there, without paying for one. A caller deciding whether to page at all
    // should not have to fetch a page to find out, and the alternative - a count published as a
    // prop - needs the component's author to have thought of it.
    const counted = await client.component<Field>('field', undefined, { paths: [{ path: ['state', 'tags'], limit: 0 }] })
    const view = counted[rpcComponent].getSnapshot()

    t.is(view.slices?.[0].total, 300, 'the size of the record')
    t.is(view.slices?.[0].keys.length, 0, 'and not one key to pay for it')
    // Absent rather than an empty object, which is the more honest of the two: `{}` would say the
    // record is there and empty, where the slice beside it says it holds three hundred and that
    // none of them were asked for.
    t.is(view.state.tags as unknown, undefined)
    t.false(JSON.stringify(view).includes('tag.'), 'nothing of the record travels at all')

    await counted[rpcComponent].close()
    await client.close()
    await server.close()
})

test('a slice of something that is not a record is nothing, said out loud', async (t) => {
    const server = new RpcServer({ name: peer('field3913'), transports: [{ port: 3913, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3913', { name: peer('asker3913'), defaultTarget: peer('field3913') })
    const opened = await client.component<Field>('field', undefined, { paths: [{ path: ['state', 'fast'], limit: 5 }] })
    const view = opened[rpcComponent].getSnapshot()

    // Reported as an empty slice rather than omitted, so "the record is not there" and "nobody
    // asked" stay different answers - the same reason a projected snapshot says it is projected.
    t.deepEqual(view.state, {})
    t.is(view.slices?.[0].total, 0)
    t.deepEqual(view.slices?.[0].keys, [])

    await opened[rpcComponent].close()
    await client.close()
    await server.close()
})

test('a slice with a bad offset is refused rather than read as zero', async (t) => {
    const server = new RpcServer({ name: peer('field3914'), transports: [{ port: 3914, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3914', { name: peer('asker3914'), defaultTarget: peer('field3914') })
    // Clamping a negative offset to zero would hand back a page nobody asked for, with nothing to
    // notice it by - the same judgement the per-call timeout makes about a negative number.
    const refused = await t.throwsAsync(client.component<Field>('field', undefined, { paths: [{ path: ['state', 'tags'], offset: -1, limit: 5 }] }))
    t.regex(String(refused?.message), /offset must be a non-negative integer/)

    await client.close()
    await server.close()
})

test('a projection that names nothing is refused, rather than subscribing to silence', async (t) => {
    const server = new RpcServer({ name: peer('field3903'), transports: [{ port: 3903, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3903', { name: peer('asker3903'), defaultTarget: peer('field3903') })

    // An empty list is a caller that built its paths wrongly, and an empty snapshot forever looks
    // exactly like a component that has gone quiet - which is the wrong thing to spend a night on.
    const empty = await t.throwsAsync(client.component<Field>('field', undefined, { paths: [] }))
    t.regex(String(empty?.message), /subscribe to nothing/)

    // A path into nothing is simply absent, not an error: state is data, and a tag that has not
    // appeared yet is a legitimate thing to watch for.
    const missing = await client.component<Field>('field', undefined, { paths: [inState(['tags', 'tag.999'])] })
    t.deepEqual(missing[rpcComponent].getSnapshot().state, {}, 'nothing there yet, and the subscription still stands')

    await missing[rpcComponent].close()
    await client.close()
    await server.close()
})
