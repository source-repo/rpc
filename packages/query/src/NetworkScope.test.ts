import test from 'ava'
import type { ServerDescription } from '@source-repo/rpc'
import { NetworkScopeCatalogue, networkRowFromKey, networkRowKey, networkScopeFromKey, networkScopeKey, type NetworkScopeNode, type NetworkScopeRef } from './NetworkScope.js'

const component = (name: string, parent: string | null = '$host', options: { capabilities?: string[]; state?: boolean } = {}) => ({
    name,
    created: false,
    emitter: false,
    component: {
        subscribers: 0,
        ...(options.state === false ? {} : { state: { kind: 'object' as const, fields: { value: { type: { kind: 'number' as const } } } } })
    },
    topology: {
        parent: parent === null ? null : { peer: 'alpha', instance: parent },
        owner: null,
        parentEpoch: 'parent',
        ownerEpoch: 'owner'
    },
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    methods: [],
    events: []
})

const alpha: ServerDescription = {
    name: 'alpha',
    validating: true,
    host: {
        root: { peer: 'alpha', instance: '$host' },
        parent: null,
        label: 'Line A',
        capabilities: { authorityScope: 'host', cycleGuarantee: 'detected', reverseIndex: 'eventual', deletion: 'tombstone', durability: 'volatile' }
    },
    namespaces: [
        component('line', '$host', { capabilities: ['plant.Line'] }),
        {
            ...component('oven', 'line', { capabilities: ['plant.Oven'] }),
            component: {
                subscribers: 0,
                props: { kind: 'object', fields: { model: { type: { kind: 'string' } } } },
                state: { kind: 'object', fields: { temperature: { type: { kind: 'number' } } } },
                resources: [
                    { path: ['orders'], verbs: ['getList', 'getOne'], label: 'Orders', row: { kind: 'object', fields: { product: { type: { kind: 'string' } } } } },
                    { path: ['addressSpace'], verbs: ['getChildren'], shape: 'tree', label: 'Address space' },
                    { path: ['hidden'], verbs: ['getMany'] }
                ]
            }
        }
    ]
}

const beta: ServerDescription = {
    name: 'beta',
    validating: true,
    host: {
        root: { peer: 'beta', instance: '$host' },
        parent: { peer: 'alpha', instance: '$host' },
        capabilities: { authorityScope: 'host', cycleGuarantee: 'detected', reverseIndex: 'eventual', deletion: 'tombstone', durability: 'volatile' }
    },
    namespaces: [
        {
            ...component('drive'),
            topology: { parent: { peer: 'beta', instance: '$host' }, owner: null, parentEpoch: 'parent', ownerEpoch: 'owner' }
        }
    ]
}

const refs = (nodes: readonly NetworkScopeNode[]) => nodes.map((node) => networkScopeKey(node.ref))

test('scope and row keys retain the complete structured identity', (t) => {
    const a: NetworkScopeRef = { kind: 'resource', peer: 'a', namespace: 'shop', resource: ['orders', 'open'] }
    const b: NetworkScopeRef = { kind: 'resource', peer: 'a', namespace: 'shop.orders', resource: ['open'] }
    t.not(networkScopeKey(a), networkScopeKey(b))
    t.not(
        networkRowKey({ peer: 'a', namespace: 'shop', resource: ['orders'], id: '1' }),
        networkRowKey({ peer: 'b', namespace: 'shop', resource: ['orders'], id: '1' })
    )
    t.deepEqual(networkScopeFromKey(networkScopeKey(a)), a)
    const row = { peer: 'a', namespace: 'shop', resource: ['orders'], id: '1' }
    t.deepEqual(networkRowFromKey(networkRowKey(row)), row)
    t.is(networkScopeFromKey('["resource","a"]'), undefined)
    t.is(networkRowFromKey('not json'), undefined)
})

test('the catalogue nests peers and components by topology without using placement as identity', (t) => {
    const catalogue = new NetworkScopeCatalogue(['beta', 'alpha'], { alpha, beta })
    t.deepEqual(refs(catalogue.roots()), [networkScopeKey({ kind: 'network' })])
    t.deepEqual(refs(catalogue.children({ kind: 'network' })), [networkScopeKey({ kind: 'peer', peer: 'alpha' })])
    t.deepEqual(refs(catalogue.children({ kind: 'peer', peer: 'alpha' })), [
        networkScopeKey({ kind: 'peer', peer: 'beta' }),
        networkScopeKey({ kind: 'resource', peer: 'alpha', namespace: '$peer', resource: ['interfaces'] }),
        networkScopeKey({ kind: 'component', peer: 'alpha', namespace: 'line' })
    ])
    t.deepEqual(refs(catalogue.children({ kind: 'component', peer: 'alpha', namespace: 'line' })), [networkScopeKey({ kind: 'component', peer: 'alpha', namespace: 'oven' }), networkScopeKey({ kind: 'resource', peer: 'alpha', namespace: 'line', resource: ['state'] })])
    t.deepEqual(catalogue.node({ kind: 'component', peer: 'alpha', namespace: 'oven' }).interfaces, ['plant.Oven'])
    t.deepEqual(catalogue.node({ kind: 'peer', peer: 'alpha' }).value, { name: 'alpha', validating: true, namespaces: 2 })
    t.deepEqual(catalogue.node({ kind: 'component', peer: 'alpha', namespace: 'oven' }).value, {
        name: 'oven',
        created: false,
        emitter: false,
        subscribers: 0,
        capabilities: ['plant.Oven']
    })
})

test('props, state and declared providers become resources while unusable declarations do not', (t) => {
    const catalogue = new NetworkScopeCatalogue(['alpha'], { alpha })
    const resources = catalogue.resourcesUnder({ kind: 'component', peer: 'alpha', namespace: 'oven' })
    t.deepEqual(
        resources.map((resource) => `${resource.resource.join('.')}:${resource.shape}`),
        ['addressSpace:tree', 'Orders:list', 'props:tree', 'state:tree'].map((entry) => entry.replace('Orders', 'orders')).sort((a, b) => a.localeCompare(b))
    )
    t.false(resources.some((resource) => resource.resource[0] === 'hidden'))
    t.is(resources.find((resource) => resource.resource[0] === 'props')?.componentRecord, 'props')
    t.deepEqual(resources.find((resource) => resource.resource[0] === 'orders')?.interfaces, ['plant.Oven'])
})

test('each described peer exposes its RPC namespaces as one synthetic tree resource', (t) => {
    const catalogue = new NetworkScopeCatalogue(['alpha'], { alpha })
    const resources = catalogue.resourcesUnder({ kind: 'peer', peer: 'alpha' })
    const interfaces = resources.find((resource) => resource.namespace === '$peer' && resource.resource[0] === 'interfaces')

    t.truthy(interfaces)
    t.is(interfaces?.shape, 'tree')
    t.deepEqual(interfaces?.verbs, ['getChildren', 'getList', 'getOne'])
    t.deepEqual(
        interfaces?.synthetic?.namespaces.map((namespace) => namespace.name),
        ['line', 'oven']
    )
    t.deepEqual(interfaces?.synthetic?.transports, [])
})

test('a network selection resolves resources through child peers and child components', (t) => {
    const catalogue = new NetworkScopeCatalogue(['alpha', 'beta'], { alpha, beta })
    const addresses = catalogue.resourcesUnder({ kind: 'network' }).map((resource) => `${resource.peer}/${resource.namespace}/${resource.resource.join('.')}`)
    // The aggregate follows the tree exactly: the child peer labelled `beta` sorts before the
    // component labelled `line`, so its resources are visited first too. Arrival time is never an
    // ordering input.
    t.deepEqual(addresses, [
        'beta/drive/state',
        'beta/$peer/interfaces',
        'alpha/$peer/interfaces',
        'alpha/oven/addressSpace',
        'alpha/oven/orders',
        'alpha/oven/props',
        'alpha/oven/state',
        'alpha/line/state'
    ])
})

test('unknown descriptions and unresolved parents remain visible at a root', (t) => {
    const orphan: ServerDescription = {
        ...beta,
        name: 'orphan',
        host: { ...beta.host!, root: { peer: 'orphan', instance: '$host' }, parent: { peer: 'missing', instance: '$host' } },
        namespaces: []
    }
    const catalogue = new NetworkScopeCatalogue(['unknown', 'orphan'], { orphan })
    const roots = catalogue.children({ kind: 'network' })
    t.deepEqual(refs(roots), [networkScopeKey({ kind: 'peer', peer: 'orphan' }), networkScopeKey({ kind: 'peer', peer: 'unknown' })])
    t.deepEqual(catalogue.node({ kind: 'peer', peer: 'unknown' }).issues, [{ kind: 'undescribed' }])
    t.deepEqual(catalogue.node({ kind: 'peer', peer: 'orphan' }).issues, [{ kind: 'unresolved-parent', parent: 'missing/$host' }])
})

test('cyclic peer placement is broken into visible roots and named as invalid', (t) => {
    const one: ServerDescription = {
        ...alpha,
        name: 'one',
        host: { ...alpha.host!, root: { peer: 'one', instance: '$host' }, parent: { peer: 'two', instance: '$host' } },
        namespaces: []
    }
    const two: ServerDescription = {
        ...alpha,
        name: 'two',
        host: { ...alpha.host!, root: { peer: 'two', instance: '$host' }, parent: { peer: 'one', instance: '$host' } },
        namespaces: []
    }
    const catalogue = new NetworkScopeCatalogue(['one', 'two'], { one, two })
    t.deepEqual(refs(catalogue.children({ kind: 'network' })), [networkScopeKey({ kind: 'peer', peer: 'one' }), networkScopeKey({ kind: 'peer', peer: 'two' })])
    t.deepEqual(catalogue.node({ kind: 'peer', peer: 'one' }).issues, [{ kind: 'cycle' }])
    t.deepEqual(catalogue.node({ kind: 'peer', peer: 'two' }).issues, [{ kind: 'cycle' }])
})
