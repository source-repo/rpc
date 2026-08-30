import test from 'ava'
import { DataType, OPCUAServer, Variant } from 'node-opcua'
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
        value: { get: () => new Variant({ dataType: DataType.Double, value: 42 }) }
    })
    namespace.addVariable({
        componentOf: filler,
        browseName: 'Running',
        nodeId: `s=Filler01.Running`,
        dataType: 'Boolean',
        value: { get: () => new Variant({ dataType: DataType.Boolean, value: true }) }
    })

    await server.start()
    endpointUrl = server.getEndpointUrl()!
})

test.after.always(async () => {
    await server?.shutdown()
})

const connected = async (t: { teardown: (fn: () => Promise<void>) => void }, options: { childrenProbe?: 'browse' | 'node-class' } = {}) => {
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

test.serial('the address space is one aspect, published as a lazy tree', async (t) => {
    const opcua = await connected(t)

    t.is(opcua.state.status, 'connected')
    t.true(opcua.state.namespaces >= 2, 'the base namespace and at least the one this test registered')

    const resources = opcua.dataResources()
    t.is(resources.length, 1)
    t.is(resources[0].path[0], 'address-space')
    t.is(resources[0].shape, 'tree')
    t.deepEqual(resources[0].verbs, ['getChildren'])
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
    t.deepEqual(rows(variables).map((row) => row.title).sort(), ['Running', 'Speed'])
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
