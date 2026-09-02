import test from 'ava'
import { DataType, OPCUAServer, StatusCodes, Variant } from 'node-opcua'
import { IEC81346, isRefusal, type AspectLocation } from '@source-repo/aspects'
import { OpcUaAspectProvider, portableNodeIdFromText, portableNodeIdToText, toSessionNodeId, type DerivedAspect, type PortableNodeId } from './index.js'
import { RpcClient, RpcServer } from '@source-repo/rpc'
import type { ObjectDetail } from '@source-repo/aspects'
import type { AspectRef, RpcGetChildrenResult } from './testing.js'

/**
 * A real OPC UA server, started in this process.
 *
 * `node-opcua` ships the server as well as the client, so this suite needs nothing external - the
 * property that made the documentation provider a good first one and that a Linear adapter could
 * never have had. What is exercised is a genuine Browse over a genuine address space, not a model
 * of one, which is the only way the questions worth asking here can be answered.
 */

const ENDPOINT_PORT = 14840
const NAMESPACE_URI = 'urn:source-rpc:test:plant'
const provider = { peer: 'plant', instance: 'opcua' }

let server: OPCUAServer
let endpointUrl: string

test.before(async () => {
    server = new OPCUAServer({ port: ENDPOINT_PORT, buildInfo: { productName: 'source-rpc-test' } })
    await server.initialize()

    const space = server.engine.addressSpace!
    const namespace = space.registerNamespace(NAMESPACE_URI)
    const objects = space.rootFolder.objects

    // A shallow plant: two lines, one with a device that has variables under it. Enough to have a
    // branch, a leaf, and a node whose children are only reachable by asking.
    const line1 = namespace.addFolder(objects, { browseName: 'Line1', nodeId: `s=Line1` })
    namespace.addFolder(objects, { browseName: 'Line2', nodeId: `s=Line2` })
    const filler = namespace.addObject({ organizedBy: line1, browseName: 'Filler01', nodeId: `s=Filler01` })
    namespace.addVariable({
        componentOf: filler,
        browseName: 'Speed',
        nodeId: `s=Filler01.Speed`,
        dataType: 'Double',
        // Readable and not writable, which is what a measurement is - and what lets the write tests
        // below exercise a refusal that comes from the server rather than from this package.
        accessLevel: 'CurrentRead',
        userAccessLevel: 'CurrentRead',
        value: { get: () => new Variant({ dataType: DataType.Double, value: 42 }) }
    })
    namespace.addVariable({
        componentOf: filler,
        browseName: 'Running',
        nodeId: `s=Filler01.Running`,
        dataType: 'Boolean',
        value: { get: () => new Variant({ dataType: DataType.Boolean, value: true }) }
    })

    // A value the server actually holds, so a write has somewhere to land. Everything above is a
    // getter, which a server rightly refuses to write - and refusing is its own test below.
    let setpoint = 50
    namespace.addVariable({
        componentOf: filler,
        browseName: 'Setpoint',
        nodeId: `s=Filler01.Setpoint`,
        dataType: 'Double',
        minimumSamplingInterval: 1000,
        value: {
            get: () => new Variant({ dataType: DataType.Double, value: setpoint }),
            set: (variant: Variant) => {
                setpoint = Number(variant.value)
                return StatusCodes.Good
            }
        }
    })
    namespace.addMethod(filler, { browseName: 'Recalibrate', nodeId: `s=Filler01.Recalibrate`, inputArguments: [], outputArguments: [] })

    await server.start()
    endpointUrl = server.getEndpointUrl()!
})

test.after.always(async () => {
    await server?.shutdown()
})

const connected = async (t: { teardown: (fn: () => Promise<void>) => void }, options: { childrenProbe?: 'browse' | 'node-class'; browseBudget?: number } = {}) => {
    const opcua = new OpcUaAspectProvider({ endpointUrl, identity: provider, label: 'Test plant', ...options })
    await opcua.connect()
    t.teardown(async () => {
        await opcua.disconnect()
    })
    return opcua
}

const branch = async (opcua: OpcUaAspectProvider, parent?: string) =>
    (await opcua.dataRequest('getChildren', ['address-space'], parent === undefined ? {} : { parentId: parent })) as RpcGetChildrenResult

const rows = (answer: RpcGetChildrenResult) => answer.data as { title: string; id: string; nodeClass: string; occurrenceId: string }[]

/** Every leaf beneath a node, which is `getList` rather than a branch at a time. */
const beneath = async (
    opcua: OpcUaAspectProvider,
    under?: string,
    page?: { page: number; pageSize: number },
    filter?: { field: string; op: string; operand: unknown }
) =>
    (await opcua.dataRequest('getList', ['address-space'], {
        ...(under === undefined ? {} : { under }),
        ...(page ? { pagination: page } : {}),
        ...(filter ? { filter } : {})
    } as never)) as RpcGetChildrenResult

test.serial('the address space is one aspect, published as a lazy tree', async (t) => {
    const opcua = await connected(t)

    t.is(opcua.state.status, 'connected')
    t.true(opcua.state.namespaces >= 2, 'the base namespace and at least the one this test registered')

    const resources = opcua.dataResources()
    t.is(resources.length, 1)
    t.is(resources[0].path[0], 'address-space')
    t.is(resources[0].shape, 'tree')
    // Both, because this provider can answer for a subtree as well as for a branch: `getChildren`
    // is a level at a time and `getList` is every leaf beneath one, walked until the page is full.
    // A provider that could not afford the second would declare only the first.
    t.deepEqual(resources[0].verbs, ['getChildren', 'getList'])
})

test.serial('a branch is browsed when it is opened, and not before', async (t) => {
    const opcua = await connected(t)

    const roots = await branch(opcua)
    const names = rows(roots).map((row) => row.title)
    t.true(names.includes('Line1'), `the Objects folder holds the plant: ${names.join(', ')}`)
    t.true(names.includes('Line2'))
    // Opening the Objects folder said nothing about what is inside Line1 - that is the whole point.
    t.false(JSON.stringify(roots).includes('Filler01'))

    const line1 = rows(roots).find((row) => row.title === 'Line1')!
    const inside = await branch(opcua, line1.occurrenceId)
    t.deepEqual(rows(inside).map((row) => row.title), ['Filler01'])

    const filler = rows(inside)[0]
    const variables = await branch(opcua, filler.occurrenceId)
    t.deepEqual(rows(variables).map((row) => row.title).sort(), ['Recalibrate', 'Running', 'Setpoint', 'Speed'])
})

test.serial('a node is identified by its namespace URI, never by the index', async (t) => {
    const opcua = await connected(t)

    const roots = await branch(opcua)
    const line1 = rows(roots).find((row) => row.title === 'Line1')!

    // The identity carries the URI. An id containing `ns=2` would be a fact about this session's
    // namespace array and would point at somebody else's nodes the day a namespace is added.
    t.true(line1.id.startsWith(`nsu=${NAMESPACE_URI};`), line1.id)
    t.false(line1.id.includes('ns='), 'no session-local index anywhere in it')

    const portable = portableNodeIdFromText(line1.id)!
    t.is(portable.namespaceUri, NAMESPACE_URI)
    t.is(portable.identifierType, 's')
    t.is(portable.identifier, 'Line1')
})

test.serial('an identity outlives a namespace array that has moved underneath it', async (t) => {
    const opcua = await connected(t)
    const line1 = rows(await branch(opcua)).find((row) => row.title === 'Line1')!
    const portable = portableNodeIdFromText(line1.id)!

    // The claim the whole identity design rests on, made concrete: the same portable id resolves to
    // a different session id when the server's namespace array is a different shape. A saved link
    // survives a server that gained a namespace; an `ns=2` would have followed the index instead.
    const asToday = toSessionNodeId(portable, ['http://opcfoundation.org/UA/', 'urn:host', NAMESPACE_URI])
    const asTomorrow = toSessionNodeId(portable, ['http://opcfoundation.org/UA/', 'urn:host', 'urn:something:new', NAMESPACE_URI])
    t.is(asToday, 'ns=2;s=Line1')
    t.is(asTomorrow, 'ns=3;s=Line1')

    // And a server that no longer has that namespace at all resolves to nothing rather than to
    // whatever now sits at that index.
    t.is(toSessionNodeId(portable, ['http://opcfoundation.org/UA/']), undefined)
})

test.serial('hasChildren is answered, and the two probes cost differently', async (t) => {
    const browsing = await connected(t, { childrenProbe: 'browse' })
    const before = browsing.browseCount()
    const roots = await branch(browsing)
    const browseCost = browsing.browseCount() - before

    const flagged = rows(roots).map((row, at) => [row.title, roots.hasChildren[at]] as const)
    t.deepEqual(flagged.find(([title]) => title === 'Line1')?.[1], true, 'Line1 holds Filler01')
    t.deepEqual(flagged.find(([title]) => title === 'Line2')?.[1], false, 'Line2 is empty, and says so')

    const inferring = await connected(t, { childrenProbe: 'node-class' })
    const inferBefore = inferring.browseCount()
    const inferred = await branch(inferring)
    const inferCost = inferring.browseCount() - inferBefore

    // The trade, measured rather than asserted: browsing is one extra request per expansion and is
    // right about an empty folder; the class heuristic is free and calls every folder expandable.
    t.is(browseCost, 2, 'one browse for the branch, one batched browse for its children')
    t.is(inferCost, 1, 'the branch only')
    t.true(inferred.hasChildren.every((flag) => flag === true), 'both folders look expandable by class alone')
})

test.serial('opening a node reads it as an object rather than a placement', async (t) => {
    const opcua = await connected(t)
    const line1 = rows(await branch(opcua)).find((row) => row.title === 'Line1')!

    const opened = await opcua.openObject({ provider, resource: ['nodes'], id: line1.id } as AspectRef)
    t.is(opened.title, 'Line1')
    t.is(opened.kind, 'opcua.object')
    t.is(opened.origin.system, 'opcua')
    t.is(opened.origin.externalId, line1.id)
    // The BrowseName without its namespace index, deliberately: a QualifiedName renders as
    // `1:Line1`, and that 1 is the session-local index this package refuses to put in anything
    // durable. The node id beside it already carries the namespace, as a URI.
    t.is((opened.fields as { browseName: string }).browseName, 'Line1')
})

test.serial('a placement is a path, found by walking up', async (t) => {
    const opcua = await connected(t)
    const line1 = rows(await branch(opcua)).find((row) => row.title === 'Line1')!
    const filler = rows(await branch(opcua, line1.occurrenceId))[0]

    const where = await opcua.placements({ provider, resource: ['nodes'], id: filler.id } as AspectRef, 'address-space')
    t.is(where.length, 1)
    t.is(where[0], filler.occurrenceId, 'the same string a browse produced for the same placement')
})

test.serial('an unparseable id is refused rather than read as namespace zero', async (t) => {
    const opcua = await connected(t)

    t.is(portableNodeIdFromText('not a node id'), undefined)
    const nothing = await opcua.open({ provider, resource: ['nodes'], id: 'not a node id' } as AspectRef)
    t.is(nothing, undefined, 'because guessing would browse somebody else’s address space')
})

test('the portable form round-trips, including the base namespace', (t) => {
    const cases: PortableNodeId[] = [
        { namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Filler01' },
        { namespaceUri: '', identifierType: 'i', identifier: '85' },
        { namespaceUri: 'urn:x', identifierType: 'g', identifier: '09087e75-8e5e-499b-954f-f2a8624db28a' },
        // A string identifier containing the separator the text form uses, which is why the parser
        // takes everything after the first `=` rather than splitting on every one.
        { namespaceUri: 'urn:x', identifierType: 's', identifier: 'a=b;c=d' }
    ]
    for (const original of cases) t.deepEqual(portableNodeIdFromText(portableNodeIdToText(original)), original)
})

/**
 * Functional and location arrangements, derived by rules this deployment supplies.
 *
 * The server publishes neither, which is the ordinary case: a generic UA server has a browse tree
 * somebody built and nothing that says what a node *does* or where it *stands*. So the rules read
 * what is there - the browse path and the names - and the arrangements are what they produce.
 */

const byFunction: DerivedAspect = {
    id: 'functional',
    label: 'By function',
    semantics: IEC81346.function,
    // Everything under a line is functional equipment; a variable is not a function, it is a
    // reading of one, so it is left out. That omission is the aspect saying what it is about.
    groups: (node) => (node.nodeClass === 'Object' && node.path.length > 0 ? [['Filling', node.path[node.path.length - 1]]] : undefined)
}

const byLocation: DerivedAspect = {
    id: 'location',
    label: 'By location',
    semantics: IEC81346.location,
    // A naming convention, which is what a plant usually has instead of a location model: the line
    // a node sits under is its hall. A node in two lines would appear under both.
    groups: (node) => (node.path.length > 0 ? [['Hall 2', node.path[0]]] : undefined)
}

const arranged = async (t: { teardown: (fn: () => Promise<void>) => void }) => {
    const opcua = new OpcUaAspectProvider({ endpointUrl, identity: provider, derived: [byFunction, byLocation] })
    await opcua.connect()
    t.teardown(async () => {
        await opcua.disconnect()
    })
    return opcua
}

test.serial('the arrangements are offered before anything has been indexed', async (t) => {
    const opcua = await arranged(t)

    t.deepEqual(opcua.aspects().map((aspect) => aspect.id), ['address-space', 'functional', 'location'])
    t.deepEqual(opcua.aspects()[1].semantics, IEC81346.function)
    t.deepEqual(opcua.aspects()[2].semantics, IEC81346.location)

    // Offered, and honest about not being built: an empty tree would say the rule found nothing,
    // which is a different statement from nobody having looked.
    const refused = await t.throwsAsync(opcua.dataRequest('getChildren', ['functional'], {}))
    t.regex(String(refused?.message), /has not been built - call index\(\)/)
})

test.serial('indexing walks once and builds every arrangement from it', async (t) => {
    const opcua = await arranged(t)

    const seen = await opcua.index()
    t.true(seen >= 5, `Line1, Line2, Filler01 and its two variables at least: ${seen}`)
    t.is(opcua.state.indexed, seen)
    t.truthy(opcua.state.indexedAt)
    t.falsy(opcua.state.indexTruncated)

    const functional = (await opcua.dataRequest('getChildren', ['functional'], {})) as RpcGetChildrenResult
    t.deepEqual(rows(functional).map((row) => row.title), ['Filling'])

    const location = (await opcua.dataRequest('getChildren', ['location'], {})) as RpcGetChildrenResult
    t.deepEqual(rows(location).map((row) => row.title), ['Hall 2'])
})

test.serial('one node, three arrangements, one identity', async (t) => {
    const opcua = await arranged(t)
    await opcua.index()

    const inAddressSpace = rows(await branch(opcua, rows(await branch(opcua)).find((row) => row.title === 'Line1')!.occurrenceId))[0]

    const filling = rows((await opcua.dataRequest('getChildren', ['functional'], {})) as RpcGetChildrenResult)[0]
    const functionLines = rows((await opcua.dataRequest('getChildren', ['functional'], { parentId: filling.occurrenceId })) as RpcGetChildrenResult)
    const inFunction = rows((await opcua.dataRequest('getChildren', ['functional'], { parentId: functionLines.find((row) => row.title === 'Line1')!.occurrenceId })) as RpcGetChildrenResult)
    const line1Group = rows((await opcua.dataRequest('getChildren', ['location'], {})) as RpcGetChildrenResult)[0]
    const halls = rows((await opcua.dataRequest('getChildren', ['location'], { parentId: line1Group.occurrenceId })) as RpcGetChildrenResult)
    const inLocation = rows((await opcua.dataRequest('getChildren', ['location'], { parentId: halls.find((row) => row.title === 'Line1')!.occurrenceId })) as RpcGetChildrenResult)

    const filler = inFunction.find((row) => row.title === 'Filler01')!
    const same = inLocation.find((row) => row.title === 'Filler01')!

    // The claim the whole model rests on, now across a machine hierarchy rather than a folder of
    // documents: three ways of looking, three placements, one object.
    t.is(inAddressSpace.id, filler.id)
    t.is(filler.id, same.id)
    t.not(filler.occurrenceId, same.occurrenceId)
    t.not(inAddressSpace.occurrenceId, filler.occurrenceId)
})

test.serial('an arrangement that leaves a node out says so, rather than pretending', async (t) => {
    const opcua = await arranged(t)
    await opcua.index()

    const speed = { provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Filler01.Speed' }) } as AspectRef

    // A variable is a reading of a function rather than a function, so the functional arrangement
    // does not place it - and that emptiness is the aspect's answer, not a failure to look.
    t.deepEqual(await opcua.placements(speed, 'functional'), [])
    t.true((await opcua.placements(speed, 'location')).length > 0, 'while it is somewhere, because everything is somewhere')
})

test.serial('following a link keeps the arrangement the reader is in', async (t) => {
    const opcua = await arranged(t)
    await opcua.index()

    const filler = { provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Filler01' }) } as AspectRef
    const speed = { provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Filler01.Speed' }) } as AspectRef
    const line2 = { provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Line2' }) } as AspectRef
    const reading: AspectLocation = { target: filler, aspectId: 'location', occurrenceId: (await opcua.placements(filler, 'location'))[0], inherited: false }

    // Reading the plant by location and following a link to something that is also placed there:
    // stay by location, which is why the reader was there.
    const stayed = await opcua.follow({ id: 'l1', target: speed }, reading)
    t.false(isRefusal(stayed))
    if (isRefusal(stayed)) return
    t.is(stayed.aspectId, 'location')
    t.true(stayed.inherited)

    // And where selection bites: `Line2` sits directly under Objects, so the location rule never
    // placed it. Following that link cannot keep the arrangement, and the answer says so rather
    // than dropping the reader somewhere without comment.
    const moved = await opcua.follow({ id: 'l2', target: line2 }, reading)
    t.false(isRefusal(moved))
    if (isRefusal(moved)) return
    t.not(moved.aspectId, 'location')
    t.false(moved.inherited)
    t.truthy(moved.fallbackUsed)
})

test.serial('a node says how it can be reached, and an object says nothing', async (t) => {
    const opcua = await connected(t)
    const ref = (identifier: string) => ({ provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier }) }) as AspectRef

    const speed = await opcua.openObject(ref('Filler01.Speed'))
    t.is(speed.bindings?.length, 1)
    const [binding] = speed.bindings!
    t.is(binding.kind, 'opcua.node')
    // The library's own word, not a parallel one: authorization is written in these, and a console
    // showing `command` beside methods marked `operate` would leave nobody sure they meant the same.
    t.is(binding.role, 'observe')
    t.deepEqual(binding.target, { type: 'external', system: 'opcua', id: speed.ref.id, endpoint: endpointUrl })
    t.true((binding.fields as { readable: boolean }).readable, 'read from the AccessLevel mask rather than assumed')

    // An Object is a place things hang off; there is nothing to reach on it directly, and an empty
    // list would say something different from no list at all.
    const filler = await opcua.openObject(ref('Filler01'))
    t.deepEqual(filler.bindings, [])
})

test.serial('a binding travels to a console without it knowing any OPC UA', async (t) => {
    const opcua = await connected(t)
    const server = new RpcServer({ name: 'ua-host', transports: [{ port: 4997, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(opcua, 'plant')
    await server.ready()
    const client = new RpcClient('http://localhost:4997', { name: 'ua-reader', defaultTarget: 'ua-host' })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const face = await client.proxy<{ openObject(target: AspectRef): Promise<ObjectDetail> }>('plant')
    const speed = await face.openObject({ provider, resource: ['nodes'], id: portableNodeIdToText({ namespaceUri: NAMESPACE_URI, identifierType: 's', identifier: 'Filler01.Speed' }) } as AspectRef)

    // The point of putting bindings in the aspects vocabulary rather than in this package: what
    // crosses the wire is `role`, `kind` and a target, and the reader needs to know nothing about
    // OPC UA to understand that this thing is observable and where.
    t.is(speed.bindings?.[0].role, 'observe')
    t.is((speed.bindings?.[0].target as { system: string }).system, 'opcua')
})

/**
 * The scoping half of a tree: every leaf beneath a node, however deep, without a viewer walking.
 *
 * This is the verb that makes filtering and sorting worth having, because both are questions about
 * a *set* of rows and a branch at a time is not one. What makes it affordable is that the walk
 * stops when the page is full - the bound is the page and not the address space.
 */
test.serial('every leaf beneath a node arrives without the caller walking', async (t) => {
    const opcua = await connected(t)

    // Line1 holds a device, and the device holds the tags. Nothing at Line1's own level is a leaf.
    const line1 = rows(await branch(opcua)).find((row) => row.title === 'Line1')!
    const direct = rows(await branch(opcua, line1.occurrenceId))
    t.deepEqual(direct.map((row) => row.title), ['Filler01'], 'a branch at a time reaches the device and stops')

    const deep = rows(await beneath(opcua, line1.occurrenceId))
    t.deepEqual(deep.map((row) => row.title).sort(), ['Recalibrate', 'Running', 'Setpoint', 'Speed'], 'and the leaves under it arrive whole')
    t.false(deep.some((row) => row.title === 'Filler01'), 'leaves only - the device is scope, not a row')
    // Not all one kind, which is the fact `kinds` on an action exists for: a Method is as much a
    // leaf as a Variable is, and `write` is about one of them.
    t.deepEqual([...new Set(deep.map((row) => row.nodeClass))].sort(), ['Method', 'Variable'])
})

test.serial('a page is the bound, and a short page says there is more', async (t) => {
    const opcua = await connected(t)

    const first = await beneath(opcua, undefined, { page: 0, pageSize: 1 })
    t.is(first.ids.length, 1)
    t.true(first.hasMore, 'more follow, said without counting them')
    t.is(first.total, undefined, 'and no total, because counting is the walk the page avoided')

    const second = await beneath(opcua, undefined, { page: 1, pageSize: 1 })
    t.is(second.ids.length, 1)
    t.not(second.ids[0], first.ids[0], 'a second page is a different row, not the same one again')
})

test.serial('a walk that runs out of budget stops and says so, rather than taking as long as it takes', async (t) => {
    // One browse buys the Objects folder and nothing under it, so the page cannot be filled - which
    // is the sparse-hierarchy case in miniature: ten thousand empty folders before the first leaf.
    const opcua = await connected(t, { browseBudget: 1 })

    const cut = await beneath(opcua, undefined, { page: 0, pageSize: 50 })
    t.is(cut.ids.length, 0, 'nothing was reached within the budget')
    t.true(cut.hasMore, 'and it says there is more rather than implying the tree is empty')
})

/**
 * The condition is the peer's work, and it is applied while walking rather than to what walked.
 *
 * This is the whole reason scoping is worth having. A page of fifty under a filter has to be fifty
 * *matches*; a viewer that received fifty rows and kept three would be paying for the address space
 * to find out that most of it did not match, which is the thing `getList` exists to prevent.
 */
test.serial('a filter is applied by the provider, as the walk goes', async (t) => {
    const opcua = await connected(t)

    const all = rows(await beneath(opcua))
    t.true(all.length > 2, `the plant has several tags: ${all.map((row) => row.title).join(', ')}`)

    const running = rows(await beneath(opcua, undefined, { page: 0, pageSize: 50 }, { field: 'title', op: 'eq', operand: 'Running' }))
    t.true(running.length > 0)
    t.true(
        running.every((row) => row.title === 'Running'),
        `only the matches came back: ${running.map((row) => row.title).join(', ')}`
    )
    t.true(running.length < all.length, 'and fewer of them than the unfiltered walk found')
})

/** Every leaf under Filler01, reached the way a viewer reaches it: by the occurrence it browsed. */
const underFiller = async (opcua: OpcUaAspectProvider) => {
    const line1 = rows(await branch(opcua)).find((row) => row.title === 'Line1')!
    const filler = rows(await branch(opcua, line1.occurrenceId)).find((row) => row.title === 'Filler01')!
    return rows(await beneath(opcua, filler.occurrenceId)) as unknown as { title: string; nodeId: string; value?: string }[]
}

test.serial('a variable is written from text, using the datatype the server declares', async (t) => {
    const opcua = await connected(t)
    const before = (await underFiller(opcua)).find((row) => row.title === 'Setpoint')!

    await opcua.write(before.nodeId, '73.5')
    const after = (await underFiller(opcua)).find((row) => row.title === 'Setpoint')!
    t.is(after.value, '73.5', 'the node holds what was sent, as a number rather than the text of one')
})

test.serial('what cannot be a value of that type is refused by name, not rounded into one', async (t) => {
    const opcua = await connected(t)
    const leaves = await underFiller(opcua)
    const setpoint = leaves.find((row) => row.title === 'Setpoint')!.nodeId
    const running = leaves.find((row) => row.title === 'Running')!.nodeId

    // `Number('')` is 0 and `Boolean('maybe')` is true. Both are how a mistyped setpoint reaches a
    // plant looking like a decision, which is why neither is allowed to happen quietly.
    await t.throwsAsync(opcua.write(setpoint, 'fast'), { message: /expected a number/ })
    await t.throwsAsync(opcua.write(setpoint, ''), { message: /expected a number/ })
    await t.throwsAsync(opcua.write(running, 'maybe'), { message: /expected true or false/ })
    await t.notThrowsAsync(opcua.write(running, 'true'), 'the words a person actually types are accepted')
})

test.serial('only a Variable has a value to write, and the server has the last word anyway', async (t) => {
    const opcua = await connected(t)
    const leaves = await underFiller(opcua)
    const method = leaves.find((row) => row.title === 'Recalibrate')!.nodeId
    const speed = leaves.find((row) => row.title === 'Speed')!.nodeId

    await t.throwsAsync(opcua.write(method, '1'), { message: /is a Method/ }, 'refused here, before a round trip that would fail anyway')
    // A getter with no setter. The refusal is the server's, and this peer reports it rather than
    // reporting a success it did not get - which is the whole reason the status code is checked.
    await t.throwsAsync(opcua.write(speed, '1'), { message: /the server refused/ })
    await t.throwsAsync(opcua.write('not a node id', '1'), { message: /not a node id/ })
})

test.serial('write is offered on the variables of every arrangement, and on nothing else', async (t) => {
    const opcua = await connected(t)
    const [addressSpace] = opcua.dataResources()

    t.deepEqual(
        addressSpace.actions?.map((action) => ({ method: action.method, kinds: action.kinds })),
        [{ method: 'write', kinds: ['opcua.variable'] }],
        'declared for the kind it is about: an address space lists Methods beside Variables and both are leaves'
    )
})
