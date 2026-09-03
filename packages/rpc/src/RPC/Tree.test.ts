import test from 'ava'
import { randomUUID } from 'node:crypto'
import { RpcClient, RpcComponent, RpcServer, groupFields, matchesFilter, rpc, rpcNamespace, type RpcFilter } from '../index.js'
import type { RpcDataMethod, RpcDataResource, RpcGetChildrenParams, RpcGetChildrenResult, RpcResource } from './DataProvider.js'

/**
 * A resource that answers a branch at a time.
 *
 * `shape: 'tree'` has been declarable since resources were added and has never been served, which
 * the declaration said in as many words. This is that seam closed: `getChildren` is `getList` for
 * one parent's children, with the same filter, sort and paging applied among them.
 *
 * The fixture is a documentation tree on purpose, rather than a table with a self-join. The case
 * this verb exists for is a node answering about a hierarchy it does not hold as rows - a folder of
 * markdown, a workspace on another service, a security zoning of things that are physically
 * elsewhere - where nobody can say how many descendants a node has until somebody asks, and so
 * `getList` is a question with no bounded answer.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

interface Page {
    id: string
    title: string
    kind: 'folder' | 'document'
    words: number
}

/** id -> its children, which is all a branch-at-a-time resource needs to know. */
const pages: { [id: string]: Page[] } = {
    '': [
        { id: 'guide', title: 'Guide', kind: 'folder', words: 0 },
        { id: 'specs', title: 'Specifications', kind: 'folder', words: 0 },
        { id: 'readme', title: 'Read me first', kind: 'document', words: 120 }
    ],
    guide: [
        { id: 'guide/start', title: 'Getting started', kind: 'document', words: 900 },
        { id: 'guide/deep', title: 'Going deeper', kind: 'folder', words: 0 },
        { id: 'guide/faq', title: 'Questions', kind: 'document', words: 300 }
    ],
    'guide/deep': [{ id: 'guide/deep/internals', title: 'Internals', kind: 'document', words: 4000 }],
    specs: [{ id: 'specs/wire', title: 'The wire format', kind: 'document', words: 2200 }]
}

// A component, because `$data` is served for observable components - a resource is something a
// component publishes alongside its state, not a second kind of instance.
@rpcNamespace('docs')
class Docs extends RpcComponent<{ title: string }, { pages: number }> {
    constructor() {
        super({ title: 'Documentation' }, { pages: 8 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['pages'],
                verbs: ['getChildren'],
                shape: 'tree',
                label: 'Documentation',
                presentation: { defaultColumns: ['title', 'words'] },
                row: {
                    kind: 'object',
                    fields: {
                        id: { type: { kind: 'string' } },
                        title: { type: { kind: 'string' } },
                        kind: { type: { kind: 'string' } },
                        words: { type: { kind: 'number' } }
                    }
                }
            }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetChildrenParams): RpcGetChildrenResult {
        if (method !== 'getChildren' || resource[0] !== 'pages') throw new Error(`docs.pages does not answer ${method}`)
        let rows = pages[params.parentId ?? ''] ?? []
        const condition = params.filter as { field?: string; op?: string; operand?: string } | undefined
        if (condition?.field === 'title' && condition.op === 'contains')
            rows = rows.filter((page) => page.title.toLowerCase().includes(String(condition.operand).toLowerCase()))
        if (params.sort?.field === 'words') rows = [...rows].sort((a, b) => (params.sort?.order === 'DESC' ? b.words - a.words : a.words - b.words))
        const total = rows.length
        const { page = 0, pageSize } = params.pagination ?? {}
        if (pageSize !== undefined) rows = rows.slice(page * pageSize, page * pageSize + pageSize)
        return {
            data: rows,
            ids: rows.map((row) => row.id),
            hasChildren: rows.map((row) => (pages[row.id]?.length ?? 0) > 0),
            total,
            epoch: run,
            revision: 1
        }
    }
}

/** Answers a branch, but with one flag too few - the mistake the dispatcher exists to catch. */
@rpcNamespace('wonky')
class Wonky extends RpcComponent<{ title: string }, { rows: number }> {
    constructor() {
        super({ title: 'Wonky' }, { rows: 2 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [{ path: ['rows'], verbs: ['getChildren'], shape: 'tree' }]
    }

    dataRequest(): RpcGetChildrenResult {
        return { data: [{ id: 'a' }, { id: 'b' }], ids: ['a', 'b'], hasChildren: [true], total: 2, epoch: run, revision: 1 }
    }
}

/** Names a column its row type does not have, which is what happens after a rename. */
@rpcNamespace('renamed')
class Renamed extends RpcComponent<{ title: string }, { rows: number }> {
    constructor() {
        super({ title: 'Renamed' }, { rows: 0 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['rows'],
                verbs: ['getChildren'],
                shape: 'tree',
                presentation: { defaultColumns: ['title', 'headline'] },
                row: { kind: 'object', fields: { id: { type: { kind: 'string' } }, title: { type: { kind: 'string' } } } }
            }
        ]
    }

    dataRequest(): RpcGetChildrenResult {
        return { data: [], ids: [], hasChildren: [], total: 0, epoch: run, revision: 1 }
    }
}

/** One component whose references are right, and two ways of being wrong. */
@rpcNamespace('referring')
class Referring extends RpcComponent<{ title: string }, { rows: number }> {
    constructor() {
        super({ title: 'Referring' }, { rows: 0 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        const row = { kind: 'object' as const, fields: { id: { type: { kind: 'string' as const } }, ownerId: { type: { kind: 'string' as const } } } }
        return [
            { path: ['people'], verbs: ['getList', 'getMany'], row },
            {
                path: ['orders'],
                verbs: ['getList'],
                row,
                references: [
                    { field: 'ownerId', target: ['people'] },
                    { field: 'nosuchfield', target: ['people'] },
                    { field: 'ownerId', target: ['ghosts'] }
                ]
            }
        ]
    }

    dataRequest(): RpcGetChildrenResult {
        return { data: [], ids: [], hasChildren: [], total: 0, epoch: run, revision: 1 }
    }
}

/** One resource naming a representation that is there and one that is not. */
@rpcNamespace('named')
class Named extends RpcComponent<{ title: string }, { rows: number }> {
    constructor() {
        super({ title: 'Named' }, { rows: 0 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['good'],
                verbs: ['getList'],
                presentation: { representation: 'title' },
                row: { kind: 'object', fields: { id: { type: { kind: 'string' } }, title: { type: { kind: 'string' } } } }
            },
            {
                path: ['bad'],
                verbs: ['getList'],
                presentation: {
                    representation: 'headline',
                    detail: ['title', 'absent'],
                    edit: ['title', 'nowhere'],
                    sections: [
                        { label: 'What it is', fields: ['title', 'missing'] },
                        { label: 'Again', fields: ['title'] }
                    ]
                },
                row: { kind: 'object', fields: { id: { type: { kind: 'string' } }, title: { type: { kind: 'string' } } } }
            }
        ]
    }

    dataRequest(): RpcGetChildrenResult {
        return { data: [], ids: [], hasChildren: [], total: 0, epoch: run, revision: 1 }
    }
}

/**
 * A row that says it carries more than it names, which is what an aspect provider's row is.
 *
 * The occurrence has five fields of its own and then whatever the arrangement puts on it - a value,
 * a node class, the path that reached it - and those are the provider's rather than the contract's.
 */
@rpcNamespace('open')
class Open extends RpcComponent<{ title: string }, { rows: number }> {
    constructor() {
        super({ title: 'Open' }, { rows: 0 })
    }

    @rpc({ semantics: 'query', effect: 'observe' })
    ping(): string {
        return 'here'
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['rows'],
                verbs: ['getChildren'],
                shape: 'tree',
                presentation: { defaultColumns: ['title', 'path', 'value'] },
                row: { kind: 'object', fields: { id: { type: { kind: 'string' } }, title: { type: { kind: 'string' } } }, additional: true }
            }
        ]
    }

    dataRequest(): RpcGetChildrenResult {
        return { data: [], ids: [], hasChildren: [], total: 0, epoch: run, revision: 1 }
    }
}

const linked = async (t: { teardown: (fn: () => Promise<void>) => void }, port: number, instance: object, namespace: string) => {
    const server = new RpcServer({ name: peer(`host${port}`), transports: [{ port, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(instance, namespace)
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`host${port}`) })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { server, client }
}

interface DataFace {
    $data(verb: string, resource: string[], params: unknown): Promise<RpcGetChildrenResult>
}

const children = async (client: RpcClient, namespace: string, parentId?: string, params: Partial<RpcGetChildrenParams> = {}) => {
    const face = await client.proxy<DataFace>(namespace)
    return face.$data('getChildren', ['pages'], { ...(parentId !== undefined ? { parentId } : {}), ...params })
}

test('an absent parentId asks for the roots', async (t) => {
    const { client } = await linked(t, 4971, new Docs(), 'docs')

    const roots = await children(client, 'docs')
    t.deepEqual(roots.ids, ['guide', 'specs', 'readme'])
    // The flag a viewer draws an expander from, before anyone has asked to expand.
    t.deepEqual(roots.hasChildren, [true, true, false], 'positional against ids, so the leaf gets no expander')
})

test('a branch is fetched on its own, and does not carry its descendants', async (t) => {
    const { client } = await linked(t, 4972, new Docs(), 'docs')

    const branch = await children(client, 'docs', 'guide')
    t.deepEqual(branch.ids, ['guide/start', 'guide/deep', 'guide/faq'])
    t.deepEqual(branch.hasChildren, [false, true, false])
    // The point of the verb: expanding `guide` said nothing about what is under `guide/deep`.
    t.false(JSON.stringify(branch).includes('Internals'))

    const deeper = await children(client, 'docs', 'guide/deep')
    t.deepEqual(deeper.ids, ['guide/deep/internals'])
})

test('filter, sort and paging apply among one parent’s children', async (t) => {
    const { client } = await linked(t, 4973, new Docs(), 'docs')

    const filtered = await children(client, 'docs', 'guide', { filter: { field: 'title', op: 'contains', operand: 'ing' } })
    t.deepEqual(filtered.ids, ['guide/start', 'guide/deep'], 'the same closed filter vocabulary, scoped to a branch')

    const sorted = await children(client, 'docs', 'guide', { sort: { field: 'words', order: 'DESC' } })
    t.deepEqual(sorted.ids, ['guide/start', 'guide/faq', 'guide/deep'])

    const paged = await children(client, 'docs', 'guide', { pagination: { page: 1, pageSize: 2 } })
    t.deepEqual(paged.ids, ['guide/faq'])
    t.is(paged.total, 3, 'the total is the branch, not the tree')
})

test('a parentId that is not a string is refused rather than read as the roots', async (t) => {
    const { client } = await linked(t, 4974, new Docs(), 'docs')

    const face = await client.proxy<DataFace>('docs')
    const refused = await t.throwsAsync(face.$data('getChildren', ['pages'], { parentId: 7 }))
    t.regex(String(refused?.message), /non-empty string parentId/)
    // Because answering the roots instead would look exactly like a node that has no children,
    // which is the failure this check exists to prevent.
})

test('a resource that did not declare the verb says what it does answer', async (t) => {
    const { client } = await linked(t, 4975, new Docs(), 'docs')

    const face = await client.proxy<DataFace>('docs')
    const refused = await t.throwsAsync(face.$data('getChildren', ['props'], {}))
    t.regex(String(refused?.message), /getChildren is answered by a resource that declares shape 'tree'/)
})

test('a branch whose flags do not line up with its rows is refused at the peer that served it', async (t) => {
    const { client } = await linked(t, 4976, new Wonky(), 'wonky')

    const face = await client.proxy<DataFace>('wonky')
    const refused = await t.throwsAsync(face.$data('getChildren', ['rows'], {}))
    t.regex(String(refused?.message), /2 rows and 1 hasChildren flags/)
    t.regex(String(refused?.message), /positionally/, 'and says why it matters, since the viewer reads them by index')
})

test('the tree shape and the default columns reach a viewer through describe', async (t) => {
    const { client } = await linked(t, 4977, new Docs(), 'docs')

    const introspection = await client.proxy<{ describe(): Promise<{ namespaces: { name: string; component?: { resources?: RpcDataResource[] } }[] }> }>('msgrpc')
    const described = await introspection.describe()
    const resource = described.namespaces.find((namespace) => namespace.name === 'docs')?.component?.resources?.[0]

    t.is(resource?.shape, 'tree', 'so a viewer knows to draw a tree rather than a long list')
    t.deepEqual(resource?.verbs, ['getChildren'])
    t.deepEqual(resource?.presentation?.defaultColumns, ['title', 'words'], 'which four of the columns to open on')
    t.truthy(resource?.row, 'while the possible columns still come from the row type, not from the hint')
})

test.serial('a default column the row type does not have is ignored, and said so', async (t) => {
    // A hint is advice: a node that refused to start because somebody renamed a field in a
    // preference would be a worse failure than a table opening on a default. But not silently -
    // a column that quietly stopped appearing is exactly what nobody notices.
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const { client } = await linked(t, 4978, new Renamed(), 'renamed')
        const introspection = await client.proxy<{ describe(): Promise<{ namespaces: { name: string; component?: { resources?: RpcDataResource[] } }[] }> }>('msgrpc')
        await introspection.describe()
    } finally {
        console.warn = warn
    }

    const complaint = said.find((line) => line.includes('presentation.defaultColumns'))
    t.truthy(complaint, 'the mismatch is reported rather than swallowed')
    t.regex(String(complaint), /'headline'/, 'and names the column, which is what somebody has to go and fix')
    t.regex(String(complaint), /still selectable/, 'while saying the rest of the row is unaffected')
})

test.serial('a representation that names nothing is reported, and says what it costs', async (t) => {
    // A different consequence from a missing column, so a different sentence: one leaves a table a
    // column short, the other leaves every confirmation naming a row by its id.
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const { client } = await linked(t, 4981, new Named(), 'named')
        const introspection = await client.proxy<{ describe(): Promise<{ namespaces: unknown[] }> }>('msgrpc')
        await introspection.describe()
    } finally {
        console.warn = warn
    }

    const complaint = said.find((line) => line.includes('presentation.representation'))
    t.truthy(complaint, 'reported rather than swallowed')
    t.regex(String(complaint), /'headline'/, 'and names the path somebody has to go and fix')
    t.regex(String(complaint), /named by their id instead/)
    t.false(said.some((line) => line.includes('named.good')), 'the resource whose hints are all real says nothing at all')

    // Every hint that names a path is checked the same way, and each says what its own absence
    // costs - a missing column is not a missing editable field, and being told "ignored" for both
    // is being told nothing.
    t.regex(String(said.find((line) => line.includes('presentation.detail'))), /'absent'.+still shows everything/s)
    const edit = String(said.find((line) => line.includes('presentation.edit')))
    t.regex(edit, /'nowhere'/)
    t.regex(edit, /settled by the write rules, never here/, 'and says where the authority actually is')

    const sections = said.filter((line) => line.includes('presentation.sections'))
    t.regex(String(sections.find((line) => line.includes("'missing'"))), /drawn after the groups that are/)
    // A field in two groups is a different mistake from a field that is not there, and it is the
    // one a reader would see: the same field twice, with no way to tell which is which.
    t.regex(String(sections.find((line) => line.includes("'title'"))), /only be drawn once/)
})

test.serial('a reference is checked at both ends, and a target nobody serves is the louder one', async (t) => {
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const { client } = await linked(t, 4982, new Referring(), 'referring')
        const introspection = await client.proxy<{ describe(): Promise<{ namespaces: unknown[] }> }>('msgrpc')
        await introspection.describe()
    } finally {
        console.warn = warn
    }

    // Precisely: the *field* check did not fire for it. The bad-target line below names `ownerId`
    // too, because that is the field whose target is missing.
    t.false(said.some((line) => line.includes("names 'ownerId' in presentation.references")), 'a reference whose field and target are both real says nothing')
    t.regex(String(said.find((line) => line.includes("'nosuchfield'"))), /reference is not drawn/)
    // The worse of the two, and the one only this check can see: the id is right, the field is
    // right, and a viewer following it asks a resource nobody is serving.
    const dead = String(said.find((line) => line.includes("refers to 'ghosts'")))
    t.regex(dead, /does not serve/)
    t.regex(dead, /would ask for a resource that is not here/)
})

test('fields are arranged into the groups the resource declared, and nothing is lost doing it', (t) => {
    const sections = [
        { label: 'What it is', fields: ['title', 'vendor'] },
        { label: 'How it runs', fields: ['baudrate', 'parity'] }
    ]

    t.deepEqual(groupFields(['baudrate', 'title', 'errors', 'parity'], sections), [
        { label: 'What it is', fields: ['title'] },
        { label: 'How it runs', fields: ['baudrate', 'parity'] },
        // Last and unlabelled rather than dropped: a grouping hint decides what is beside what, and
        // letting it decide what may be *seen* would make an omission a way to hide a field.
        { fields: ['errors'] }
    ])

    // A group with nothing left in it is not a heading over nothing. An edit form showing three of
    // twenty fields would otherwise be mostly empty headings.
    t.deepEqual(groupFields(['errors'], sections), [{ fields: ['errors'] }])

    // No opinion is one group, so a caller never branches on whether the resource had one.
    t.deepEqual(groupFields(['a', 'b']), [{ fields: ['a', 'b'] }])
    t.deepEqual(groupFields([], sections), [])
})

test.serial('a row that admits fields it did not name is not missing them', async (t) => {
    // The aspect providers' case, and before this every column they advertise was reported as a
    // mistake: an occurrence's fields are the arrangement's, so the row names the five it always
    // has and `additional` for the rest. A warning that fires on correct declarations is one people
    // learn to scroll past, which costs the case it was written for.
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const { client } = await linked(t, 4980, new Open(), 'open')
        const introspection = await client.proxy<{ describe(): Promise<{ namespaces: unknown[] }> }>('msgrpc')
        await introspection.describe()
    } finally {
        console.warn = warn
    }

    t.false(
        said.some((line) => line.includes('presentation.defaultColumns')),
        'nothing to complain about: the row said there would be more'
    )
})

test.serial('a default column that is really there says nothing at all', async (t) => {
    const said: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => said.push(args.join(' '))
    try {
        const { client } = await linked(t, 4979, new Docs(), 'docs')
        const introspection = await client.proxy<{ describe(): Promise<{ namespaces: unknown[] }> }>('msgrpc')
        await introspection.describe()
    } finally {
        console.warn = warn
    }

    t.false(
        said.some((line) => line.includes('presentation.defaultColumns')),
        'a hint that is correct is not worth a line of anybody’s log'
    )
})

test('a folded comparison is asked for, never inherited', (t) => {
    const rows = [{ name: 'Acme Ltd' }, { name: 'borg' }, { name: 'Borg AB' }]
    const matching = (filter: RpcFilter) => rows.filter((row) => matchesFilter(filter, row, row.name)).map((row) => row.name)

    // The default stays what a filter has to be. Two rows differ only by case and they are two rows.
    t.deepEqual(matching({ field: 'name', op: 'contains', operand: 'borg' }), ['borg'])
    t.deepEqual(matching({ field: 'name', op: 'contains', operand: 'borg', fold: true }), ['borg', 'Borg AB'])
    // Both sides, so a shouted operand finds a row that is not shouting.
    t.deepEqual(matching({ field: 'name', op: 'startsWith', operand: 'ACME', fold: true }), ['Acme Ltd'])
})

test.serial('fold is refused where it would mean nothing, rather than ignored there', async (t) => {
    const { client } = await linked(t, 4983, new Docs(), 'refusing')
    const face = await client.proxy<DataFace>('refusing')

    // A caller who asked for a folded comparison and silently got a sensitive one would be reading a
    // wrong answer as a right one. "Case-insensitively less than" is a collation, not a comparison.
    const refusal = await t.throwsAsync(
        face.$data('getChildren', ['pages'], { filter: { field: 'title', op: 'gt', operand: 'a', fold: true } } as never)
    )
    t.regex(String(refusal?.message), /fold applies to startsWith and contains/)
    await t.notThrowsAsync(face.$data('getChildren', ['pages'], { filter: { field: 'title', op: 'contains', operand: 'a', fold: true } } as never))
})

/**
 * `under` says where, `recursive` says how deep, and the four combinations of them are the whole of
 * what a hierarchy can be asked.
 *
 * Which makes `getChildren` the corner where the depth is one, rather than a verb of its own. It
 * stays on the wire - a caller browsing a branch at a time is not wrong and does not have to change
 * - but nothing new needs it, and a resource that can be browsed can now be browsed by the verb
 * that also filters, sorts and pages.
 *
 * Tested here against a component's **own record**, where the hierarchy is the shape of the data
 * rather than something a provider browses, because that is the case every component has and no
 * provider is needed to exercise it.
 */

class Zones extends RpcComponent<{ line: string }, { mode: string; zones: { top: { setpoint: number; heating: boolean }; bottom: { setpoint: number } } }> {
    constructor() {
        super({ line: 'one' }, { mode: 'auto', zones: { top: { setpoint: 180, heating: true }, bottom: { setpoint: 165 } } })
    }
}

test('one level unless the depth was asked for, which is the change of default', async (t) => {
    const { client } = await linked(t, 4991, new Zones(), 'zones')
    const face = await client.proxy<DataFace>('zones')

    const shallow = (await face.$data('getList', ['state'], { pagination: { page: 0, pageSize: 20 } })) as unknown as { ids: string[] }
    // The members of the record, one level down - which is what `getList` over props and state has
    // always answered, and is now what it answers because nobody asked for more.
    t.deepEqual(shallow.ids, ['mode', 'zones'])

    const deep = (await face.$data('getList', ['state'], { pagination: { page: 0, pageSize: 20 }, recursive: true })) as unknown as { ids: string[]; data: unknown[]; total?: number }
    // Dotted paths, because that is what identifies a leaf here and what a caller hands back to
    // `getOne`. A plain object is descended into and everything else is a leaf.
    //
    // In key order at every level, which is the same order the shallow answer comes in and is why
    // paging a deep list is stable: the walk is a function of the record, not of the order somebody
    // happened to build it in.
    t.deepEqual(deep.ids, ['mode', 'zones.bottom.setpoint', 'zones.top.heating', 'zones.top.setpoint'])
    t.deepEqual(deep.data, ['auto', 165, true, 180])
    t.is(deep.total, 4)
})

test('where says where and recursive says how deep, and they are independent', async (t) => {
    const { client } = await linked(t, 4992, new Zones(), 'zones')
    const face = await client.proxy<DataFace>('zones')

    // A path narrows the record; the flag decides the depth under it. Neither substitutes for the
    // other, which is the whole reason there are two of them.
    const under = (await face.$data('getList', ['state', 'zones'], { pagination: { page: 0, pageSize: 20 } })) as unknown as { ids: string[] }
    t.deepEqual(under.ids, ['bottom', 'top'])

    const underDeep = (await face.$data('getList', ['state', 'zones'], { pagination: { page: 0, pageSize: 20 }, recursive: true })) as unknown as { ids: string[] }
    t.deepEqual(underDeep.ids, ['bottom.setpoint', 'top.heating', 'top.setpoint'])
})

test('the filter is applied to what the depth gathered, and before the page is cut', async (t) => {
    const { client } = await linked(t, 4993, new Zones(), 'zones')
    const face = await client.proxy<DataFace>('zones')

    // Order matters and none of the three is interchangeable: gathering, then filtering, then
    // paging. A filter over one level would be a filter over a different question.
    const found = (await face.$data('getList', ['state'], { pagination: { page: 0, pageSize: 20 }, recursive: true, filter: { field: 'id', op: 'contains', operand: 'setpoint' } })) as unknown as { ids: string[]; total?: number }
    t.deepEqual(found.ids, ['zones.bottom.setpoint', 'zones.top.setpoint'])
    t.is(found.total, 2, 'the count is of what matched at that depth, not of the page')
})

test('getChildren refuses the flag rather than picking one of its two readings', async (t) => {
    const { client } = await linked(t, 4994, new Docs(), 'docs')
    const face = await client.proxy<DataFace>('docs')

    // `recursive: true` asks it to stop being itself and `recursive: false` restates it, so either
    // reading surprises somebody. The choice lives on `getList`, which is where it is offered.
    await t.throwsAsync(face.$data('getChildren', ['pages'], { recursive: true }), { message: /one level by definition/ })
    await t.throwsAsync(face.$data('getChildren', ['pages'], { recursive: false }), { message: /one level by definition/ })
    await t.throwsAsync(face.$data('getList', ['state'], { recursive: 'yes' }), { message: /how deep to go, not how far/ })
})
