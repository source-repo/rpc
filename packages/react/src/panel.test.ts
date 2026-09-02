import { afterAll, expect, test } from 'vitest'
import { matchesFilter, rpcComponent, RpcClient, RpcComponent, RpcServer, type RpcGetListParams, type RpcGetListResult } from '@source-repo/rpc'
import { leavesUnder } from './scope.js'
import { compileFilter } from './filter.js'
import type { DescribedComponent, TypeNode } from './types.js'

/**
 * What the panel asks the network for, against a network that answers.
 *
 * `scope.test.ts` proves the walk reads a contract correctly, which is a claim about a function.
 * This is the claim that matters on a slow link: that the *plan* the panel derives from that
 * contract - subscribe to these paths, ask for that page - moves a page of bytes and not a record.
 *
 * The failure it exists to catch cannot be seen in the browser. A panel that subscribed to the whole
 * snapshot and paged the grid correctly would look perfect and would still carry all three hundred
 * tags on every commit, forever - the feature apparently working while the link it was built for is
 * exactly as full as it was before.
 */

type FieldProps = { label: string; tags: number }
type Reading = { value: number; unit: string; quality: string }
type FieldState = { fast: number; zones: { top: { setpoint: number; temperature: number } }; tags: { [tag: string]: Reading } }

/** Decorator-free, since the app is bundled rather than compiled with the library's settings. */
class Field extends RpcComponent<FieldProps, FieldState> {
    constructor() {
        const tags: FieldState['tags'] = {}
        for (let index = 0; index < 300; index++)
            tags[`tag.${String(index).padStart(3, '0')}`] = { value: index, unit: '°C', quality: index % 10 === 0 ? 'bad' : 'good' }
        super({ label: 'f', tags: 300 }, { fast: 0, zones: { top: { setpoint: 20, temperature: 19 } }, tags })
    }
}

const number: TypeNode = { kind: 'number' }
const reading: TypeNode = { kind: 'object', fields: { value: { type: number }, unit: { type: { kind: 'string' } }, quality: { type: { kind: 'string' } } } }

/** The same component as `describe()` publishes it, which is all the panel ever sees. */
const contract: DescribedComponent = {
    subscribers: 0,
    props: { kind: 'object', fields: { label: { type: { kind: 'string' } }, tags: { type: number } } },
    state: {
        kind: 'object',
        fields: {
            fast: { type: number },
            zones: { type: { kind: 'object', fields: { top: { type: { kind: 'object', fields: { setpoint: { type: number }, temperature: { type: number } } } } } } },
            tags: { type: { kind: 'record', values: reading } }
        }
    }
}

/** Exactly what ComponentPanel computes for its subscription, and for the same reasons. */
const projectionOf = (component: DescribedComponent) =>
    (['props', 'state'] as const)
        .flatMap((root) => (component[root] ? leavesUnder(component[root], [root]) : []))
        .filter((leaf) => !leaf.collection)
        .map((leaf) => leaf.path)

const server = new RpcServer({ name: 'panelfield3931', transports: [{ port: 3931, host: '127.0.0.1' }] })
const client = new RpcClient('http://localhost:3931', { name: 'panelasker3931', defaultTarget: 'panelfield3931' })

afterAll(async () => {
    await client.close()
    await server.close()
})

test('the panel subscribes to the typed leaves and never to the record', async () => {
    server.exposeClassInstance(new Field(), 'field')
    await server.ready()

    const projection = projectionOf(contract)
    expect(projection.map((path) => path.join('.'))).toEqual([
        'props.label',
        'props.tags',
        'state.fast',
        'state.zones.top.setpoint',
        'state.zones.top.temperature'
    ])

    const observed = await client.component<Field>('field', undefined, { paths: projection })
    const view = observed[rpcComponent].getSnapshot()

    // The typed half arrives and stays live, which is what it is subscribed for.
    expect(view.state.fast).toBe(0)
    expect(view.props.label).toBe('f')
    expect(view.state.zones.top.setpoint).toBe(20)

    // And the three hundred entries the grid pages do not travel with it. This is the assertion the
    // whole split exists for: the record is data, so it is asked for, never pushed.
    expect(view.state.tags).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('tag.000')

    await observed[rpcComponent].close()
})

test('and asks for the page it is showing, which costs a page', async () => {
    const proxy = await client.proxy<{ $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult> }>('field')

    const page = await proxy.$data('getList', ['state', 'tags'], { pagination: { page: 0, pageSize: 50 } })
    expect(page.ids.length).toBe(50)
    expect(page.total).toBe(300)
    expect(page.ids[0]).toBe('tag.000')
    expect(page.data[0]).toEqual({ value: 0, unit: '°C', quality: 'bad' })

    // Measured rather than assumed, for the same reason as on the library side: an implementation
    // that fetched the record and sliced it here would pass every assertion above. Compared against
    // the record rather than a constant, so the claim cannot drift as a row grows a field.
    const carried = JSON.stringify(page)
    const whole = JSON.stringify(await proxy.$data('getList', ['state', 'tags']))
    expect(carried.length * 5).toBeLessThan(whole.length)
    expect(carried).not.toContain('tag.050')
})

test('what the filter box compiles narrows on the peer, not in the browser', async () => {
    const proxy = await client.proxy<{ $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult> }>('field')

    // The whole path, end to end: what an operator types, through the grammar, onto the wire, to a
    // component that answers only the matches. `quality:bad` is the one that cannot be done here -
    // discovering which thirty of three hundred are bad is exactly what a local filter would have
    // to receive all three hundred to find out.
    const bad = await proxy.$data('getList', ['state', 'tags'], { filter: compileFilter('quality:bad'), pagination: { page: 0, pageSize: 50 } })
    expect(bad.total).toBe(30)
    expect(bad.data.every((row) => (row as Reading).quality === 'bad')).toBe(true)

    // And the property the pull was chosen for, measured: a search that matches nothing is a
    // sentence on the wire, where filtering in the browser would have cost the whole record first.
    const none = await proxy.$data('getList', ['state', 'tags'], { filter: compileFilter('nosuchtag') })
    expect(none.total).toBe(0)
    expect(JSON.stringify(none).length).toBeLessThan(120)

    // Typing narrows: `.05 & quality:bad` is tag.050 alone, and the count the pager reads is the
    // count of matches rather than of the collection.
    const narrowed = await proxy.$data('getList', ['state', 'tags'], { filter: compileFilter('.05 & quality:bad') })
    expect([...narrowed.ids]).toEqual(['tag.050'])
    expect(narrowed.total).toBe(1)
})

test('one box means one thing on both halves of the grid', async () => {
    const proxy = await client.proxy<{ $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult> }>('field')

    // The typed fields are held rather than asked for, so the console filters them itself - and the
    // id of a typed leaf is its path, which is what makes `setp` find a setpoint two levels down.
    const setp = compileFilter('setp')!
    const fields = leavesUnder(contract.state, ['state'])
        .filter((leaf) => !leaf.collection)
        .filter((leaf) => matchesFilter(setp, undefined, leaf.path.join('.')))
        .map((leaf) => leaf.path.join('.'))
    expect(fields).toEqual(['state.zones.top.setpoint'])

    // And the property that makes one box honest: the matcher the console runs over what it holds
    // agrees exactly with the one the peer runs over what it does not. A search that meant two
    // different things either side of the same pane would be worse than no search at all.
    const filter = compileFilter('quality:bad')!
    const answered = await proxy.$data('getList', ['state', 'tags'], { filter })
    const whole = await proxy.$data('getList', ['state', 'tags'])
    const locally = whole.ids.filter((id, index) => matchesFilter(filter, whole.data[index], id))
    expect(locally).toEqual([...answered.ids])
    expect(locally.length).toBe(30)
})
