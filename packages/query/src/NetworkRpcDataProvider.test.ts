import test from 'ava'
import type { RpcDataAnswer, RpcQuestion } from './index.js'
import type { ServerDescription } from '@source-repo/rpc'
import { NetworkDataProvider } from './NetworkDataProvider.js'
import { NETWORK_RESOURCE, NetworkRpcDataProvider } from './NetworkRpcDataProvider.js'
import { NetworkScopeCatalogue, networkRowFromKey, networkScopeFromKey } from './NetworkScope.js'

const described: ServerDescription = {
    name: 'peer',
    validating: true,
    namespaces: [
        {
            name: 'oven',
            created: false,
            emitter: false,
            component: {
                subscribers: 0,
                state: { kind: 'object', fields: { temperature: { type: { kind: 'number' } } } },
                resources: [
                    {
                        path: ['tags'],
                        verbs: ['getChildren', 'getList', 'getOne'],
                        shape: 'tree',
                        row: { kind: 'object', fields: { title: { type: { kind: 'string' } }, value: { type: { kind: 'number' } } } },
                        presentation: { representation: 'title' }
                    }
                ]
            },
            topology: { parent: { peer: 'peer', instance: '$host' }, owner: null, parentEpoch: 'p', ownerEpoch: 'o' },
            capabilities: ['plant.Oven'],
            methods: [],
            events: []
        }
    ]
}

const setup = (ask: (question: RpcQuestion) => Promise<RpcDataAnswer>, description: ServerDescription = described) => {
    const catalogue = new NetworkScopeCatalogue(['peer'], { peer: description })
    const network = new NetworkDataProvider({ catalogue, ask })
    return new NetworkRpcDataProvider({ provider: network, epoch: 'view', revision: 3 })
}

test('the adapter declares one tree resource for the existing generic view', (t) => {
    const adapter = setup(async () => ({ ids: [], data: [], epoch: 'e', revision: 0 }))
    t.deepEqual(adapter.dataResources(), [NETWORK_RESOURCE])
})

test('structural children are encoded as provider-owned grouping rows', async (t) => {
    const adapter = setup(async () => ({ ids: [], data: [], epoch: 'e', revision: 0 }))
    const answer = await adapter.dataRequest('getChildren', ['network'], {})
    if (!('ids' in answer) || !('hasChildren' in answer)) return t.fail('expected a branch answer')
    t.is(answer.ids.length, 1)
    t.deepEqual(networkScopeFromKey(answer.ids[0]), { kind: 'peer', peer: 'peer' })
    t.deepEqual(answer.grouping, [true])
    t.deepEqual(answer.hasChildren, [true])
    t.deepEqual(answer.data, [{ name: 'peer', validating: true, namespaces: 1, kind: 'peer' }])
    t.is(answer.epoch, 'view')
    t.is(answer.revision, 3)
})

test('a branch selection becomes an ordinary recursive list in the existing grid', async (t) => {
    const asked: RpcQuestion[] = []
    const adapter = setup(async (question) => {
        asked.push(question)
        return { ids: ['temperature'], data: [{ title: 'Temperature', value: 71 }], total: 1, epoch: 'component', revision: 8 }
    })
    const componentChildren = await adapter.dataRequest('getChildren', ['network'], {
        parentId: '["component","peer","oven"]',
        pagination: { page: 0, pageSize: 50 }
    })
    if (!('ids' in componentChildren)) return t.fail('expected children')
    const tags = componentChildren.ids.find((id) => {
        const ref = networkScopeFromKey(id)
        return ref?.kind === 'resource' && ref.resource[0] === 'tags'
    })
    t.truthy(tags)
    const rows = await adapter.dataRequest('getList', ['network'], { under: tags, recursive: true, pagination: { page: 0, pageSize: 50 } })
    if (!('ids' in rows)) return t.fail('expected rows')
    t.is(rows.ids.length, 1)
    t.deepEqual(networkRowFromKey(rows.ids[0]), { peer: 'peer', namespace: 'oven', resource: ['tags'], id: 'temperature' })
    t.deepEqual(rows.data, [{ title: 'Temperature', value: 71, peer: 'peer', namespace: 'oven', resource: 'tags', id: 'temperature', name: 'Temperature' }])
    t.deepEqual(adapter.getStatus(), {
        settled: true,
        scope: { kind: 'resource', peer: 'peer', namespace: 'oven', resource: ['tags'] },
        asked: 1,
        rows: 1,
        total: 1,
        hasMore: false,
        partial: false,
        refused: [],
        columns: ['id', 'title', 'value']
    })
    t.deepEqual(asked[0], {
        target: 'peer',
        namespace: 'oven',
        method: 'getList',
        resource: ['tags'],
        params: { pagination: { page: 0, pageSize: 50 }, recursive: true }
    })
})

test('opening a synthetic row delegates to its original provider locator', async (t) => {
    let asked: RpcQuestion | undefined
    const adapter = setup(async (question) => {
        asked = question
        return { data: { title: 'Temperature', value: 71 }, epoch: 'component', revision: 8 }
    })
    const id = '["peer","oven",["tags"],"temperature"]'
    const answer = await adapter.dataRequest('getOne', ['network'], { id })
    t.deepEqual(answer, { data: { title: 'Temperature', value: 71 }, epoch: 'component', revision: 8 })
    t.deepEqual(asked, { target: 'peer', namespace: 'oven', method: 'getOne', resource: ['tags'], params: { id: 'temperature' } })
})

test('bounded continuation is reported beside the grid without offering an invalid next page', async (t) => {
    const adapter = setup(async () => ({ ids: ['one'], data: [1], hasMore: true, epoch: 'component', revision: 8 }))
    let changes = 0
    const unsubscribe = adapter.subscribe(() => changes++)
    const answer = await adapter.dataRequest('getList', ['network'], { pagination: { page: 0, pageSize: 1 } })
    unsubscribe()

    if (!('ids' in answer)) return t.fail('expected rows')
    t.false(answer.hasMore)
    t.false('total' in answer)
    t.is(changes, 1)
    t.true(adapter.getStatus().partial)
    t.true(adapter.getStatus().hasMore)
    t.deepEqual(adapter.getStatus().columns, [
        'peer',
        'namespace',
        'resource',
        'id',
        'name',
        'interface',
        'method',
        'parameters',
        'rest',
        'returns',
        'semantics',
        'effect',
        'sets',
        'requiresAuthority',
        'capabilities',
        'transport',
        'role',
        'endpoint',
        'kind',
        'title',
        'value'
    ])
})

test('an object from an undeclared row shape retains the value fallback', async (t) => {
    const adapter = setup(async (question) => ({
        ids: ['one'],
        data: [question.resource[0] === 'state' ? { nested: 7 } : { title: 'One', value: 1 }],
        total: 1,
        epoch: 'component',
        revision: 8
    }))
    const answer = await adapter.dataRequest('getList', ['network'], { pagination: { page: 0, pageSize: 10 } })
    if (!('ids' in answer)) return t.fail('expected rows')
    const state = answer.ids.findIndex((id) => networkRowFromKey(id)?.resource[0] === 'state')
    t.not(state, -1)
    t.deepEqual((answer.data[state] as { value: unknown }).value, { nested: 7 })
})

test('the adapter preserves interface branch records and exposes method leaves to the generic view', async (t) => {
    const namespace = described.namespaces[0]
    const withMethod: ServerDescription = {
        ...described,
        namespaces: [
            {
                ...namespace,
                version: '3',
                className: 'Oven',
                methods: [
                    {
                        name: 'heat',
                        params: [{ kind: 'number' }],
                        paramNames: ['setpoint'],
                        returns: { kind: 'boolean' },
                        semantics: 'idempotent-command',
                        effect: 'operate'
                    }
                ]
            }
        ]
    }
    let remoteQuestions = 0
    const adapter = setup(async () => {
        remoteQuestions++
        throw new Error('interface descriptions are local')
    }, withMethod)

    const peerChildren = await adapter.dataRequest('getChildren', ['network'], {
        parentId: '["peer","peer"]',
        pagination: { page: 0, pageSize: 50 }
    })
    if (!('ids' in peerChildren)) return t.fail('expected peer children')
    const interfaces = peerChildren.ids.find((id) => {
        const ref = networkScopeFromKey(id)
        return ref?.kind === 'resource' && ref.namespace === '$peer'
    })
    t.truthy(interfaces)

    const interfaceChildren = await adapter.dataRequest('getChildren', ['network'], {
        parentId: interfaces,
        pagination: { page: 0, pageSize: 50 }
    })
    if (!('ids' in interfaceChildren)) return t.fail('expected interface branches')
    t.deepEqual(interfaceChildren.data, [
        {
            name: 'oven',
            version: '3',
            className: 'Oven',
            created: false,
            emitter: false,
            capabilities: ['plant.Oven'],
            kind: 'branch',
            interfaces: ['plant.Oven']
        }
    ])

    const rows = await adapter.dataRequest('getList', ['network'], {
        under: interfaceChildren.ids[0],
        recursive: true,
        pagination: { page: 0, pageSize: 50 }
    })
    if (!('ids' in rows)) return t.fail('expected method rows')
    t.is(rows.ids.length, 1)
    t.deepEqual(rows.data[0], {
        interface: 'oven',
        method: 'heat',
        parameters: [{ name: 'setpoint', type: { kind: 'number' } }],
        returns: { kind: 'boolean' },
        semantics: 'idempotent-command',
        effect: 'operate',
        capabilities: ['plant.Oven'],
        kind: 'rpc.method',
        peer: 'peer',
        namespace: '$peer',
        resource: 'interfaces',
        id: '["oven","heat"]',
        name: 'heat'
    })
    const opened = await adapter.dataRequest('getOne', ['network'], { id: rows.ids[0] })
    t.deepEqual(opened, {
        data: {
            name: 'heat',
            interface: 'oven',
            method: 'heat',
            parameters: [{ name: 'setpoint', type: { kind: 'number' } }],
            returns: { kind: 'boolean' },
            semantics: 'idempotent-command',
            effect: 'operate',
            capabilities: ['plant.Oven'],
            kind: 'rpc.method'
        },
        epoch: 'network-interfaces',
        revision: 0
    })
    t.is(remoteQuestions, 0)
})
