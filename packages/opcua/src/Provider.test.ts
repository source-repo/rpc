import test from 'ava'
import { DataType, OPCUAServer, Variant } from 'node-opcua'
import { OpcUaAspectProvider, portableNodeIdFromText, portableNodeIdToText, toSessionNodeId, type PortableNodeId } from './index.js'
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
