import test from 'ava'
import type { RpcGetListParams, ServerDescription } from '@source-repo/rpc'
import type { RpcDataAnswer } from './Cache.js'
import type { RpcQuestion } from './Key.js'
import { NetworkDataProvider, networkFilterForSource } from './NetworkDataProvider.js'
import { NetworkScopeCatalogue } from './NetworkScope.js'

const description = (peer: string, resource: string, options: { parent?: string; capabilities?: string[]; treeOnly?: boolean } = {}): ServerDescription => ({
    name: peer,
    validating: true,
    host: {
        root: { peer, instance: '$host' },
        parent: options.parent ? { peer: options.parent, instance: '$host' } : null,
        capabilities: { authorityScope: 'host', cycleGuarantee: 'detected', reverseIndex: 'eventual', deletion: 'tombstone', durability: 'volatile' }
    },
    namespaces: [
        {
            name: 'plant',
            created: false,
            emitter: false,
            capabilities: options.capabilities,
            component: {
                subscribers: 0,
                state: { kind: 'object', fields: { running: { type: { kind: 'boolean' } } } },
                resources: [
                    {
                        path: [resource],
                        verbs: options.treeOnly ? ['getChildren'] : ['getList', 'getOne'],
                        ...(options.treeOnly ? { shape: 'tree' as const } : {}),
                        row: { kind: 'object', fields: { name: { type: { kind: 'string' } } } },
                        presentation: { representation: 'name' }
                    }
                ]
            },
            topology: { parent: { peer, instance: '$host' }, owner: null, parentEpoch: 'p', ownerEpoch: 'o' },
            methods: [],
            events: []
        }
    ]
})

const catalogue = new NetworkScopeCatalogue(['alpha', 'beta'], {
    alpha: description('alpha', 'tags', { capabilities: ['plant.Tags'] }),
    beta: description('beta', 'documents', { parent: 'alpha', capabilities: ['plant.Documents'] })
})

test('a network list asks each concrete provider and keeps stable source identity on rows', async (t) => {
    const questions: RpcQuestion[] = []
    const ask = async (question: RpcQuestion): Promise<RpcDataAnswer> => {
        questions.push(question)
        const id = `${question.target}-${question.resource.join('.')}`
        return { ids: [id], data: [{ name: id }], total: 1, epoch: question.target, revision: 1 }
    }
    const provider = new NetworkDataProvider({ catalogue, ask, pageSize: 20 })
    const answer = await provider.getList({ kind: 'network' })

    // Child-peer resources occur before the local component in the displayed tree, irrespective of
    // completion order. State is a first-class base-class provider beside declared resources.
    t.deepEqual(
        answer.rows.map((row) => `${row.locator.peer}/${row.locator.resource.join('.')}/${row.locator.id}`),
        ['beta/documents/beta-documents', 'beta/state/beta-state', 'alpha/state/alpha-state', 'alpha/tags/alpha-tags']
    )
    t.deepEqual(answer.rows[0].source.interfaces, ['plant.Documents'])
    t.is(answer.rows[0].representation, 'name')
    t.true(questions.filter((question) => question.resource[0] === 'state').every((question) => (question.params as { recursive?: boolean }).recursive === true))
    t.deepEqual(answer, { ...answer, asked: 4, total: 4, hasMore: false, partial: false, refused: [] })
})

test('network predicates prune sources and row predicates keep their Boolean meaning', async (t) => {
    const questions: RpcQuestion[] = []
    const provider = new NetworkDataProvider({
        catalogue,
        ask: async (question) => {
            questions.push(question)
            return { ids: [], data: [], total: 0, epoch: 'e', revision: 1 }
        }
    })

    const answer = await provider.getList(
        { kind: 'network' },
        {
            filter: {
                all: [
                    { field: 'interface', op: 'contains', operand: 'plant.Tags' },
                    { field: 'row.quality', op: 'contains', operand: 'bad', fold: true }
                ]
            }
        }
    )

    t.is(answer.asked, 2)
    t.true(questions.every((question) => question.target === 'alpha'))
    t.true(
        questions.every(
            (question) =>
                JSON.stringify((question.params as RpcGetListParams).filter) ===
                JSON.stringify({ field: 'quality', op: 'contains', operand: 'bad', fold: true })
        )
    )
})

test('a matching source arm in an or makes that source unconditional', (t) => {
    const sources = catalogue.resourcesUnder({ kind: 'network' })
    const alpha = sources.find((source) => source.peer === 'alpha')!
    const beta = sources.find((source) => source.peer === 'beta')!
    const filter = {
        any: [
            { field: 'source.peer', op: 'contains' as const, operand: 'alpha' },
            { field: 'quality', op: 'contains' as const, operand: 'bad' }
        ]
    }

    t.is(networkFilterForSource(filter, alpha), true)
    t.deepEqual(networkFilterForSource(filter, beta), { field: 'quality', op: 'contains', operand: 'bad' })
})

test('aggregate sorting orders the bounded merge and does not send source columns to row providers', async (t) => {
    const questions: RpcQuestion[] = []
    const provider = new NetworkDataProvider({
        catalogue,
        ask: async (question) => {
            questions.push(question)
            return {
                ids: ['2', '1'],
                data: [{ name: 'Zulu' }, { name: 'Alpha' }],
                total: 2,
                epoch: 'e',
                revision: 1
            }
        }
    })

    const byPeer = await provider.getList({ kind: 'network' }, { sort: { field: 'peer', order: 'DESC' } })
    t.deepEqual(byPeer.rows.map((row) => row.locator.peer), ['beta', 'beta', 'beta', 'beta', 'alpha', 'alpha', 'alpha', 'alpha'])
    t.true(questions.every((question) => (question.params as RpcGetListParams).sort === undefined))

    questions.length = 0
    const byName = await provider.getList({ kind: 'network' }, { sort: { field: 'row.name', order: 'ASC' } })
    t.deepEqual(byName.rows.map((row) => (row.value as { name: string }).name), ['Alpha', 'Alpha', 'Alpha', 'Alpha', 'Zulu', 'Zulu', 'Zulu', 'Zulu'])
    t.true(questions.every((question) => JSON.stringify((question.params as RpcGetListParams).sort) === JSON.stringify({ field: 'name', order: 'ASC' })))
})

test('one failed source is carried beside successful rows rather than rejecting the scope', async (t) => {
    const provider = new NetworkDataProvider({
        catalogue,
        ask: async (question) => {
            if (question.target === 'beta') throw new Error('beta is offline')
            return { ids: ['ok'], data: [7], epoch: 'e', revision: 1 }
        }
    })
    const answer = await provider.getList({ kind: 'network' }, { pagination: { pageSize: 10 } })
    t.deepEqual(answer.rows.map((row) => row.locator.peer), ['alpha', 'alpha'])
    t.is(answer.refused.length, 2)
    t.true(answer.refused.every((refusal) => refusal.reason === 'beta is offline'))
    t.true(answer.partial)
    t.false(answer.hasMore)
    t.false('total' in answer)
})

test('a provider that cannot recursively list leaves makes the bounded aggregate explicitly partial', async (t) => {
    const tree = new NetworkScopeCatalogue(['tree'], { tree: description('tree', 'addressSpace', { treeOnly: true }) })
    const provider = new NetworkDataProvider({
        catalogue: tree,
        ask: async () => ({ ids: ['running'], data: [true], total: 1, epoch: 'e', revision: 1 })
    })
    const answer = await provider.getList({ kind: 'peer', peer: 'tree' })
    t.is(answer.asked, 1)
    t.is(answer.refused.length, 1)
    t.regex(answer.refused[0].reason, /cannot list all leaves/)
    t.true(answer.partial)
})

test('the aggregate bound truncates honestly and a non-zero offset is refused', async (t) => {
    const provider = new NetworkDataProvider({
        catalogue,
        ask: async (question) => ({ ids: [`${question.target}-1`, `${question.target}-2`], data: [1, 2], hasMore: true, epoch: 'e', revision: 1 })
    })
    const answer = await provider.getList({ kind: 'network' }, { pagination: { pageSize: 3 } })
    t.is(answer.rows.length, 3)
    t.true(answer.hasMore)
    t.true(answer.partial)
    await t.throwsAsync(() => provider.getList({ kind: 'network' }, { pagination: { page: 1, pageSize: 3 } }), { message: /continuation cursor/ })
})

test('opening a row retains its peer, namespace, resource and id', async (t) => {
    let asked: RpcQuestion | undefined
    const provider = new NetworkDataProvider({
        catalogue,
        ask: async (question) => {
            asked = question
            return { data: { name: 'Tag 7' }, epoch: 'e', revision: 2 }
        }
    })
    const answer = await provider.getOne({ peer: 'alpha', namespace: 'plant', resource: ['tags'], id: '7' })
    t.deepEqual(answer.data, { name: 'Tag 7' })
    t.deepEqual(asked, { target: 'alpha', namespace: 'plant', method: 'getOne', resource: ['tags'], params: { id: '7' } })
})

test('provider grouping decides which structured rows are branches', async (t) => {
    const tree = new NetworkScopeCatalogue(['tree'], { tree: description('tree', 'addressSpace', { treeOnly: true }) })
    let asked: RpcQuestion | undefined
    const provider = new NetworkDataProvider({
        catalogue: tree,
        ask: async (question) => {
            asked = question
            return {
                ids: ['folder', 'object-leaf', 'empty-folder'],
                data: [{ name: 'Area A' }, { name: 'Motor' }, { name: 'Spare' }],
                grouping: [true, false, true],
                hasChildren: [true, true, false],
                defaultChild: 'folder',
                epoch: 'e',
                revision: 1
            }
        }
    })
    const answer = await provider.getChildren({ kind: 'resource', peer: 'tree', namespace: 'plant', resource: ['addressSpace'] }, 25)
    t.deepEqual(
        answer.nodes.map((node) => ({ label: node.label, expandable: node.expandable })),
        [
            { label: 'Area A', expandable: true },
            { label: 'Spare', expandable: false }
        ]
    )
    t.is(answer.defaultChild, 'folder')
    t.deepEqual(asked, {
        target: 'tree',
        namespace: 'plant',
        method: 'getChildren',
        resource: ['addressSpace'],
        params: { pagination: { page: 0, pageSize: 25 } }
    })
})

test('a branch scopes both its child question and its recursive leaf list', async (t) => {
    const original = description('tree', 'addressSpace')
    const namespace = original.namespaces[0]
    const resource = namespace.component!.resources![0]
    const described: ServerDescription = {
        ...original,
        namespaces: [
            {
                ...namespace,
                component: { ...namespace.component!, resources: [{ ...resource, shape: 'tree', verbs: ['getChildren', 'getList'] }] }
            }
        ]
    }
    const tree = new NetworkScopeCatalogue(['tree'], { tree: described })
    const questions: RpcQuestion[] = []
    const provider = new NetworkDataProvider({
        catalogue: tree,
        ask: async (question) => {
            questions.push(question)
            if (question.method === 'getChildren') return { ids: [], data: [], hasChildren: [], epoch: 'e', revision: 1 }
            return { ids: ['leaf'], data: [{ name: 'Leaf' }], epoch: 'e', revision: 1 }
        }
    })
    const scope = { kind: 'branch' as const, peer: 'tree', namespace: 'plant', resource: ['addressSpace'], id: 'area-a' }
    await provider.getChildren(scope)
    await provider.getList(scope)
    t.deepEqual(questions.map((question) => question.params), [
        { parentId: 'area-a', pagination: { page: 0, pageSize: 100 } },
        { pagination: { page: 0, pageSize: 100 }, recursive: true, under: 'area-a' }
    ])
})

test('opening a row falls back to getMany when the source deliberately has no getOne', async (t) => {
    const original = description('table', 'suppliers')
    const namespace = original.namespaces[0]
    const resource = namespace.component!.resources![0]
    const described: ServerDescription = {
        ...original,
        namespaces: [
            {
                ...namespace,
                component: { ...namespace.component!, resources: [{ ...resource, verbs: ['getList', 'getMany', 'getManyReference'] }] }
            }
        ]
    }
    const questions: RpcQuestion[] = []
    const provider = new NetworkDataProvider({
        catalogue: new NetworkScopeCatalogue(['table'], { table: described }),
        ask: async (question) => {
            questions.push(question)
            return { ids: ['7'], data: [{ name: 'Cyberdyne' }], epoch: 'table', revision: 2, queryMs: 3 }
        }
    })

    const answer = await provider.getOne({ peer: 'table', namespace: 'plant', resource: ['suppliers'], id: '7' })
    t.deepEqual(answer, { data: { name: 'Cyberdyne' }, epoch: 'table', revision: 2, queryMs: 3 })
    t.deepEqual(questions, [{ target: 'table', namespace: 'plant', method: 'getMany', resource: ['suppliers'], params: { ids: ['7'] } }])
})

test('RPC namespaces are object branches and their methods are locally served leaves', async (t) => {
    const original = description('api', 'records', { capabilities: ['plant.Api'] })
    const namespace = original.namespaces[0]
    const described: ServerDescription = {
        ...original,
        transports: [{ name: 'api', protocol: 'socket.io', role: 'listen', endpoint: 'http://127.0.0.1:7843' }],
        namespaces: [
            {
                ...namespace,
                version: '2',
                className: 'PlantApi',
                methods: [
                    {
                        name: 'start',
                        params: [{ kind: 'string' }],
                        paramNames: ['recipe'],
                        returns: { kind: 'boolean' },
                        semantics: 'idempotent-command',
                        effect: 'operate',
                        requiresAuthority: true
                    },
                    { name: 'status', params: [], paramNames: [], returns: { kind: 'string' }, semantics: 'query', effect: 'observe' }
                ]
            }
        ]
    }
    let remoteQuestions = 0
    const provider = new NetworkDataProvider({
        catalogue: new NetworkScopeCatalogue(['api'], { api: described }),
        ask: async () => {
            remoteQuestions++
            throw new Error('the described interface is answered locally')
        }
    })
    const peer = { kind: 'peer' as const, peer: 'api' }
    const resource = { kind: 'resource' as const, peer: 'api', namespace: '$peer', resource: ['interfaces'] as const }

    // The branch carries description metadata even though the tree renders only its label.
    const children = await provider.getChildren(resource)
    t.deepEqual(children.nodes.map((node) => node.label), ['plant', 'Transports'])
    t.deepEqual(children.nodes[0].value, {
        name: 'plant',
        version: '2',
        className: 'PlantApi',
        created: false,
        emitter: false,
        capabilities: ['plant.Api']
    })
    t.false(children.nodes[0].expandable)

    const branch = { kind: 'branch' as const, peer: 'api', namespace: '$peer', resource: ['interfaces'] as const, id: JSON.stringify(['interface', 'plant']) }
    const listed = await provider.getList(branch, {
        filter: { field: 'method', op: 'contains', operand: 'sta' },
        sort: { field: 'method', order: 'DESC' }
    })
    t.is(listed.asked, 0)
    t.is(listed.total, 2)
    t.deepEqual(listed.rows.map((row) => (row.value as { method: string }).method), ['status', 'start'])
    t.deepEqual(listed.rows[1].value, {
        name: 'start',
        interface: 'plant',
        method: 'start',
        parameters: [{ name: 'recipe', type: { kind: 'string' } }],
        returns: { kind: 'boolean' },
        semantics: 'idempotent-command',
        effect: 'operate',
        requiresAuthority: true,
        capabilities: ['plant.Api'],
        kind: 'rpc.method'
    })

    const filtered = await provider.getList(resource, { filter: { field: 'interface', op: 'eq', operand: 'plant' } })
    t.is(filtered.rows.length, 2)
    const transportBranch = children.nodes.find((node) => node.label === 'Transports')!
    t.deepEqual(transportBranch.value, { name: 'Transports', transports: 1, protocols: ['socket.io'] })
    const transports = await provider.getList(transportBranch.ref)
    t.is(transports.total, 1)
    t.deepEqual(transports.rows[0].value, {
        name: 'socket.io listen',
        interface: 'Transports',
        transport: 'socket.io',
        role: 'listen',
        endpoint: 'http://127.0.0.1:7843',
        kind: 'rpc.transport'
    })
    const opened = await provider.getOne(listed.rows[1].locator)
    t.deepEqual(opened.data, listed.rows[1].value)
    t.is(remoteQuestions, 0)
    t.true((await provider.getChildren(peer)).nodes.some((node) => node.ref.kind === 'resource' && node.ref.namespace === '$peer'))
})
