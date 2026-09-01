import { rpc, rpcNamespace, type RpcRef } from '@source-repo/rpc'
import { AspectProvider, type AspectDescriptor, type AspectRef, type Branch, type ObjectBinding, type ObjectDetail, type Occurrence } from '@source-repo/aspects'
import { AttributeIds, BrowseDirection, NodeClass, OPCUAClient, type ClientSession, type OPCUAClientOptions } from 'node-opcua-client'
import { fromSessionNodeId, portableNodeIdFromText, portableNodeIdToText, toSessionNodeId } from './Identity.js'
import { buildDerived, derivedRoot, type DerivedAspect, type DerivedIndex, type IndexedNode } from './Derived.js'

/**
 * An OPC UA server's address space, served as an aspect.
 *
 * The distinction this package is built on, and it is the same one that renamed `documentation`:
 * **OPC UA is not an aspect.** It is a source and a protocol, the way Markdown is a format. What is
 * an aspect is an *arrangement* of the objects a server holds - and the address space, the server's
 * own hierarchy, is the first and most obvious one. Functional, location and engineering
 * arrangements over the same nodes are further aspects, and this package will grow them; none of
 * them is where a node lives.
 *
 * ## Why a lazy tree is the only honest shape
 *
 * A real address space is tens or hundreds of thousands of nodes. Nothing may walk it to answer a
 * question, and no page size means anything until a branch is named - which is exactly the case
 * `getChildren` exists for, and why `AspectProvider` gives this package a paged tree without it
 * writing one.
 *
 * Nothing here creates a component per node either. Two hundred thousand UA nodes are two hundred
 * thousand *occurrences* behind one provider; promoting the operationally interesting few to real
 * Source RPC components is a separate and later decision, and a much more valuable one once it
 * means something stronger than "this node exists".
 *
 * ## What is deliberately not here yet
 *
 * No subscriptions, no writes, no methods. An occurrence carries what a browse returned; a UA
 * subscription is a different thing with a different lifetime, and pushing change notification into
 * a read model would drag it somewhere it does not belong. Aspects browse; bindings will reach;
 * components live.
 */

export interface OpcUaProviderProps extends Record<string, unknown> {
    readonly label: string
    readonly endpointUrl: string
}

export interface OpcUaProviderState extends Record<string, unknown> {
    readonly status: 'disconnected' | 'connecting' | 'connected' | 'failed'
    readonly namespaces: number
    /** Nodes the last index walk saw, and when. Zero until somebody asks for one. */
    readonly indexed: number
    readonly indexedAt?: string
    /** True when the walk stopped on a bound rather than because it had finished. */
    readonly indexTruncated?: boolean
    readonly problem?: string
}

/**
 * How to answer `hasChildren`, which is the one genuinely awkward question OPC UA asks of a tree.
 *
 * A viewer needs the flag *before* anybody expands, and OPC UA can only answer it by browsing.
 * Browsing the children of a node gives the children; knowing whether each of *those* has children
 * is a second question about a different set of nodes.
 *
 * `browse` asks it, in one batched Browse covering every child at once - so it is one extra round
 * trip per expansion rather than one per row, but it does double the work and a node with four
 * hundred children pays for four hundred browses server-side.
 *
 * `node-class` infers it: an Object, an ObjectType or a View almost always has children and a
 * Variable usually does not. It is free and it is occasionally wrong - a Variable with properties
 * gets no expander until something asks. The trade is a real one, which is why it is a choice with
 * a stated default rather than a decision buried in the code.
 */
export type ChildrenProbe = 'browse' | 'node-class'

export interface OpcUaProviderOptions {
    readonly endpointUrl: string
    readonly label?: string
    /** Who this provider is in the references it hands out; a component cannot know its own name. */
    readonly identity?: RpcRef
    readonly childrenProbe?: ChildrenProbe
    /**
     * Arrangements this server does not publish: functional, location, operations.
     *
     * Supplied as code by whoever deploys this, because a grouping rule is exactly the kind of
     * structure rule `@source-repo/aspects` refuses to accept from the network. What crosses the
     * wire is the tree it produces.
     */
    readonly derived?: readonly DerivedAspect[]
    /** How far an index walk goes before it stops. A server is not obliged to be small. */
    readonly maxIndexNodes?: number
    readonly maxIndexDepth?: number
    readonly maxPageSize?: number
    readonly client?: OPCUAClientOptions
}

const ADDRESS_SPACE = 'address-space'
/** Where a browse of the address space starts. `i=85` is the Objects folder in every UA server. */
const OBJECTS_FOLDER = 'i=85'

/**
 * Whether a node id names the Objects folder, in either spelling.
 *
 * node-opcua renders namespace zero as `ns=0;i=85` and accepts the short `i=85`, and a walk that
 * compared one against the other never stopped - so every placement carried the Root and Objects
 * folders it should have started below. Comparing node ids as strings is the mistake; the two forms
 * are one node.
 */
const isObjectsFolder = (nodeId: string): boolean => nodeId === OBJECTS_FOLDER || nodeId === `ns=0;${OBJECTS_FOLDER}`

/**
 * Whether a node class is a place to look inside rather than a thing to list.
 *
 * Objects and their types and Views hold other nodes; Variables and Methods are what a reader came
 * to see. It is deliberately about the class and not about `hasChildren`, which answers a different
 * question - a Variable with properties hanging off it is still a measurement, and an Object with
 * nothing in it yet is still a cabinet.
 */
const isGrouping = (nodeClass: string): boolean => nodeClass === 'Object' || nodeClass === 'ObjectType' || nodeClass === 'View'

@rpcNamespace('opcua')
export class OpcUaAspectProvider extends AspectProvider<OpcUaProviderProps, OpcUaProviderState> {
    private readonly options: OpcUaProviderOptions
    private readonly identity: RpcRef
    private client?: OPCUAClient
    private session?: ClientSession
    /** The server's namespace array, read once per session: the index-to-URI map identity needs. */
    private namespaces: readonly string[] = []
    /** How many Browse requests this provider has sent, so the probe's cost can be measured. */
    private browses = 0
    /** One built arrangement per derived aspect, empty until `index()` has been asked for. */
    private readonly indexes = new Map<string, DerivedIndex>()

    constructor(options: OpcUaProviderOptions) {
        super(
            { label: options.label ?? options.endpointUrl, endpointUrl: options.endpointUrl },
            { status: 'disconnected', namespaces: 0, indexed: 0 }
        )
        this.options = options
        this.identity = options.identity ?? { peer: '', instance: 'opcua' }
        this.maxPageSize = options.maxPageSize ?? 200
    }

    /**
     * The server's own hierarchy, and for now the only arrangement.
     *
     * Synchronous, because a component's resources are read at describe time and `describe()` does
     * not wait - which is a constraint worth having: a provider should know which structures it
     * offers without asking anybody, and only what is inside them needs a round trip.
     */
    aspects(): readonly AspectDescriptor[] {
        return [
            {
                id: ADDRESS_SPACE,
                label: 'Address space',
                description: "The server's own hierarchy, browsed a branch at a time",
                revision: String(this.namespaces.length),
                default: true,
                preferredPresentation: 'tree',
                // `value` before the class, because on a plant it is the column somebody came to
                // read: a row saying `Running` and `Variable` answers a question nobody asked. It is
                // absent on an Object and on a Variable that could not be read, and a column with
                // gaps in it is still the right column.
                defaultColumns: ['title', 'value', 'nodeClass']
            },
            // The arrangements the deployment supplied. They are offered whether or not an index
            // has been built - a viewer should be able to see that a functional aspect exists and
            // ask for it, and be told it needs indexing, rather than have it appear once somebody
            // happens to have run a walk.
            ...(this.options.derived ?? []).map((aspect) => ({
                id: aspect.id,
                label: aspect.label,
                ...(aspect.description ? { description: aspect.description } : {}),
                ...(aspect.semantics ? { semantics: aspect.semantics } : {}),
                revision: String(this.indexes.get(aspect.id)?.nodes ?? 0),
                preferredPresentation: 'tree' as const,
                defaultColumns: aspect.defaultColumns ?? ['title', 'nodeClass']
            }))
        ]
    }

    /**
     * Walk the server once and build every derived arrangement from what it finds.
     *
     * Explicit, bounded, and reported. The address space is served a branch at a time and never
     * walked; an arrangement somebody derived cannot be, because knowing what belongs under
     * "Hall 2" means having asked the rule about every node. That is a real cost and it belongs in
     * a method a person calls, with a number in the state afterwards, rather than behind a click
     * that looked like any other.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    async index(): Promise<number> {
        const derived = this.options.derived ?? []
        if (!derived.length) return 0
        this.connected()

        const maxNodes = this.options.maxIndexNodes ?? 20_000
        const maxDepth = this.options.maxIndexDepth ?? 12
        const found: IndexedNode[] = []
        let truncated = false

        const walk = async (node: string, path: readonly string[], depth: number): Promise<void> => {
            if (depth > maxDepth || found.length >= maxNodes) {
                truncated = truncated || found.length >= maxNodes || depth > maxDepth
                return
            }
            for (const child of await this.browse(node)) {
                if (found.length >= maxNodes) {
                    truncated = true
                    return
                }
                found.push({ id: child.portable, session: child.session, title: child.title, nodeClass: child.nodeClass, path })
                await walk(child.session, [...path, child.title], depth + 1)
            }
        }
        await walk(OBJECTS_FOLDER, [], 0)

        this.indexes.clear()
        for (const aspect of derived) this.indexes.set(aspect.id, buildDerived(aspect, found, (node) => this.occurrenceOf(node)))
        this.structureChanged()
        this.setState({ indexed: found.length, indexedAt: new Date().toISOString(), ...(truncated ? { indexTruncated: true } : { indexTruncated: undefined }) })
        return found.length
    }

    /** One row for a node, the same shape whichever arrangement it is appearing in. */
    private occurrenceOf(node: IndexedNode): Occurrence {
        return {
            occurrenceId: node.id,
            ref: { provider: this.identity, resource: ['nodes'], id: node.id },
            title: node.title,
            kind: `opcua.${node.nodeClass.toLowerCase()}`,
            hasChildren: false,
            fields: { nodeClass: node.nodeClass, nodeId: node.id, addressSpacePath: node.path.join(' / ') }
        }
    }

    /** Connect, and read the namespace array that every identity in this package depends on. */
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    async connect(): Promise<number> {
        if (this.session) return this.namespaces.length
        this.setState({ status: 'connecting', problem: undefined })
        try {
            const client = OPCUAClient.create({ endpointMustExist: false, ...this.options.client })
            await client.connect(this.options.endpointUrl)
            const session = await client.createSession()
            const namespaces = await session.readNamespaceArray()
            this.client = client
            this.session = session
            this.namespaces = namespaces
            this.structureChanged()
            this.setState({ status: 'connected', namespaces: namespaces.length, problem: undefined })
            return namespaces.length
        } catch (error) {
            this.setState({ status: 'failed', namespaces: 0, indexed: 0, problem: error instanceof Error ? error.message : String(error) })
            throw error
        }
    }

    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    async disconnect(): Promise<void> {
        await this.session?.close().catch(() => undefined)
        await this.client?.disconnect().catch(() => undefined)
        this.session = undefined
        this.client = undefined
        this.namespaces = []
        this.indexes.clear()
        this.setState({ status: 'disconnected', namespaces: 0, indexed: 0, indexedAt: undefined })
    }

    /** How many Browse requests have been sent. Published so the probe's cost is a number. */
    @rpc({ semantics: 'query', effect: 'observe' })
    browseCount(): number {
        return this.browses
    }

    async children(aspectId: string, parentOccurrenceId: string | undefined, page: { from: number; size: number }): Promise<Branch> {
        if (aspectId !== ADDRESS_SPACE) return this.derivedChildren(aspectId, parentOccurrenceId, page)
        this.connected()
        // An occurrence in this aspect is the browse path that reached the node, so the node to
        // browse is its last segment - and the path is what makes one node appearing under two
        // parents two occurrences rather than one.
        const parentNode = parentOccurrenceId ? this.nodeOf(parentOccurrenceId) : OBJECTS_FOLDER
        const references = await this.browse(parentNode)

        const total = references.length
        const window = references.slice(page.from, page.from + page.size)
        const flags = await this.hasChildrenFor(window)
        const values = await this.valuesFor(window)

        return {
            total,
            occurrences: window.map((reference, at) => ({
                occurrenceId: parentOccurrenceId ? `${parentOccurrenceId}/${reference.session}` : reference.session,
                ref: { provider: this.identity, resource: ['nodes'], id: reference.portable },
                title: reference.title,
                kind: `opcua.${reference.nodeClass.toLowerCase()}`,
                relation: reference.reference,
                hasChildren: flags[at],
                // What the node *is*, which is not whether anything hangs off it. A Variable with
                // `EngineeringUnits` and `EURange` under it is still a measurement somebody wants in
                // a row, and an Object with nothing under it yet is still a place.
                grouping: isGrouping(reference.nodeClass),
                fields: { nodeClass: reference.nodeClass, nodeId: reference.portable, ...(values[at] !== undefined ? { value: values[at] } : {}) }
            }))
        }
    }

    /**
     * What the Variables in this page currently read.
     *
     * A branch of a plant's address space is mostly Variables, and a row that says `Running` and
     * `Variable` and nothing else is a row nobody wanted: the thing being looked for is `false`, or
     * `27.3`. So the value travels with the branch.
     *
     * One Read covering the whole page, for the reason the browse beside it is batched: OPC UA's
     * Read takes an array, so this is one further round trip per expansion and not one per row.
     * Non-Variables are skipped rather than read and discarded - an Object has no Value attribute,
     * and asking for one is a status code coming back for every folder in the tree.
     *
     * Still no subscription, which is the line this package holds: a value here is what it read when
     * the branch was asked for, and a viewer that wants it to keep moving asks again. Two hundred
     * thousand nodes are not two hundred thousand monitored items because somebody opened a folder.
     */
    private async valuesFor(children: readonly { readonly session: string; readonly nodeClass: string }[]): Promise<(string | undefined)[]> {
        const wanted = children.map((child, at) => (child.nodeClass === 'Variable' ? at : -1)).filter((at) => at >= 0)
        if (!wanted.length) return children.map(() => undefined)

        const session = this.connected()
        const read = await session.read(wanted.map((at) => ({ nodeId: children[at].session, attributeId: AttributeIds.Value })))
        const answers: (string | undefined)[] = children.map(() => undefined)
        for (const [which, at] of wanted.entries()) {
            const held = read[which]
            // A bad status is a value that could not be read, which is a fact about the node rather
            // than a failure of the branch - so it is said in the cell instead of throwing the page
            // away. An unreadable tag beside forty good ones is exactly what somebody is looking for.
            if (held?.statusCode?.isGood?.() === false) answers[at] = `(${held.statusCode.name ?? 'bad'})`
            else if (held?.value?.value !== undefined && held.value.value !== null) answers[at] = String(held.value.value)
        }
        return answers
    }

    /**
     * Where a node appears in the address space.
     *
     * Answered by walking *up* from the node through its inverse hierarchical references, which is
     * the only way a UA server can say where something sits. One placement is returned - the first
     * parent chain found - and that is a known simplification: a node genuinely reachable by two
     * paths has two placements, and returning both means walking every branch of the tree above it.
     * The single answer is honest for the common case and is where a second arrangement will start.
     */
    async placements(target: AspectRef, aspectId: string): Promise<readonly string[]> {
        // A derived arrangement knows every placement it made, so this is a lookup rather than a
        // walk - and it answers with all of them, which is the case the address space cannot manage.
        if (aspectId !== ADDRESS_SPACE) return this.indexOf(aspectId).placements.get(target.id) ?? []
        const session = this.connected()
        const portable = portableNodeIdFromText(target.id)
        if (!portable) return []
        const node = toSessionNodeId(portable, this.namespaces)
        if (!node) return []

        const chain: string[] = [node]
        let current = node
        for (let step = 0; step < 32 && !isObjectsFolder(current); step++) {
            const parents = await session.browse({
                nodeId: current,
                browseDirection: BrowseDirection.Inverse,
                referenceTypeId: 'HierarchicalReferences',
                includeSubtypes: true,
                resultMask: 63
            })
            this.browses += 1
            const parent = parents.references?.[0]
            if (!parent) break
            current = parent.nodeId.toString()
            chain.unshift(current)
        }
        // The occurrence id is the path from the Objects folder down, which is how `children` built
        // it - so a placement and a browsed row name the same string for the same placement.
        const from = chain.findIndex(isObjectsFolder)
        return [chain.slice(from < 0 ? 0 : from + 1).join('/')].filter(Boolean)
    }

    /** One node, read: the attributes that describe it, as an object rather than a placement. */
    async open(target: AspectRef): Promise<ObjectDetail | undefined> {
        const session = this.connected()
        const portable = portableNodeIdFromText(target.id)
        if (!portable) return undefined
        const node = toSessionNodeId(portable, this.namespaces)
        if (!node) return undefined

        // Six attributes in one Read, because the round trip is the cost and the rest are free.
        // AccessLevel is what says whether this node can be written at all, which a binding has to
        // report honestly rather than leaving a caller to find out by trying - and Value is what a
        // reader opened a Variable to see. An Object has no Value and answers a bad status for it,
        // which costs nothing and is dropped below.
        const [displayName, browseName, nodeClass, description, accessLevel, value] = await session.read([
            { nodeId: node, attributeId: AttributeIds.DisplayName },
            { nodeId: node, attributeId: AttributeIds.BrowseName },
            { nodeId: node, attributeId: AttributeIds.NodeClass },
            { nodeId: node, attributeId: AttributeIds.Description },
            { nodeId: node, attributeId: AttributeIds.AccessLevel },
            { nodeId: node, attributeId: AttributeIds.Value }
        ])
        const title = String((displayName.value.value as { text?: string })?.text ?? (browseName.value.value as { name?: string })?.name ?? target.id)
        const kind = NodeClass[Number(nodeClass.value.value)] ?? 'Unspecified'

        return {
            ref: target,
            kind: `opcua.${String(kind).toLowerCase()}`,
            title,
            ...(((description.value.value as { text?: string })?.text) ? { summary: String((description.value.value as { text?: string }).text) } : {}),
            fields: {
                nodeId: target.id,
                browseName: String((browseName.value.value as { name?: string })?.name ?? ''),
                nodeClass: String(kind),
                // Carried here as well as on the row, because an object is not always reached from
                // one: a link, a binding or a saved address opens it with no table beside it, and a
                // Variable whose value is missing from the one view that shows everything about it
                // would be the odd gap. Absent on an Object, which has no Value to read.
                ...(value?.statusCode?.isGood?.() !== false && value?.value?.value !== undefined && value.value.value !== null
                    ? { value: String(value.value.value) }
                    : {})
            },
            origin: { system: 'opcua', externalId: target.id, url: this.props.endpointUrl, retrievedAt: new Date().toISOString() },
            bindings: this.bindingsFor(target.id, String(kind), Number(accessLevel.value?.value ?? 0))
        }
    }

    /**
     * How this node can be reached, which is a fact about the server rather than about this package.
     *
     * A Variable can be observed and a Method can be called; an Object is a place things hang off
     * and there is nothing to reach on it directly, so it gets none. An empty list would say
     * something different from no list, so nodes with nothing to offer simply carry no bindings.
     *
     * `write` is reported through `accessLevel` rather than as a second binding with a role of its
     * own. Writing a UA variable is reaching the same interface with a different verb, and a
     * separate binding would read as a separate way in - and this package does not write anyway,
     * which is exactly why it must not imply that it does. A binding describes; it grants nothing.
     */
    private bindingsFor(id: string, nodeClass: string, accessLevel: number): ObjectBinding[] {
        const target = { type: 'external' as const, system: 'opcua', id, endpoint: this.props.endpointUrl }
        if (nodeClass === 'Variable')
            return [
                {
                    kind: 'opcua.node',
                    role: 'observe',
                    target,
                    // Bit 0 is CurrentRead and bit 1 is CurrentWrite in OPC UA's AccessLevel mask.
                    fields: { nodeClass, readable: (accessLevel & 0b01) !== 0, writable: (accessLevel & 0b10) !== 0 }
                }
            ]
        if (nodeClass === 'Method') return [{ kind: 'opcua.method', role: 'operate', target, fields: { nodeClass } }]
        return []
    }

    /** One branch of a derived arrangement, straight out of the index. */
    private derivedChildren(aspectId: string, parentOccurrenceId: string | undefined, page: { from: number; size: number }): Branch {
        const built = this.indexOf(aspectId)
        const all = built.children.get(parentOccurrenceId ?? derivedRoot) ?? []
        return { total: all.length, occurrences: all.slice(page.from, page.from + page.size) }
    }

    /**
     * The built arrangement, or a refusal that says what to do about it.
     *
     * An arrangement that has not been indexed is not empty - nobody has looked yet - and answering
     * with an empty tree would say the rule found nothing, which is a different and wrong statement.
     */
    private indexOf(aspectId: string): DerivedIndex {
        if (!(this.options.derived ?? []).some((aspect) => aspect.id === aspectId)) throw new Error(`no aspect ${aspectId}`)
        const built = this.indexes.get(aspectId)
        if (!built) throw new Error(`the ${aspectId} arrangement has not been built - call index(), which walks the server once`)
        return built
    }

    private connected(): ClientSession {
        if (!this.session) throw new Error(`not connected to ${this.props.endpointUrl} - call connect() first`)
        return this.session
    }

    /** The last segment of an occurrence path, which is the node that branch belongs to. */
    private nodeOf(occurrenceId: string): string {
        return occurrenceId.slice(occurrenceId.lastIndexOf('/') + 1)
    }

    private async browse(node: string) {
        const session = this.connected()
        const result = await session.browse({ nodeId: node, browseDirection: BrowseDirection.Forward, referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, resultMask: 63 })
        this.browses += 1
        return (result.references ?? []).map((reference) => ({
            session: reference.nodeId.toString(),
            portable: portableNodeIdToText(fromSessionNodeId(reference.nodeId, this.namespaces)),
            title: String(reference.displayName?.text ?? reference.browseName?.name ?? reference.nodeId.toString()),
            nodeClass: NodeClass[reference.nodeClass] ?? 'Unspecified',
            reference: String(reference.referenceTypeId?.toString() ?? '')
        }))
    }

    /** The flag a viewer draws an expander from, by whichever probe this provider was given. */
    private async hasChildrenFor(children: readonly { readonly session: string; readonly nodeClass: string }[]): Promise<boolean[]> {
        if (!children.length) return []
        // Free, and answered from what the browse already returned: a container almost always has
        // children and a Variable usually does not. Wrong for a Variable that carries properties,
        // which gets no expander until something asks - the cost of the choice, stated where it is
        // made rather than discovered by somebody wondering why a node will not open.
        if ((this.options.childrenProbe ?? 'browse') === 'node-class')
            return children.map((child) => child.nodeClass === 'Object' || child.nodeClass === 'ObjectType' || child.nodeClass === 'VariableType' || child.nodeClass === 'View')

        // One Browse request covering every child at once. OPC UA's Browse takes an array of nodes,
        // so this is one extra round trip per expansion rather than one per row - the difference
        // between an acceptable cost and the fan-out this whole verb exists to avoid.
        const session = this.connected()
        const results = await session.browse(
            children.map((child) => ({ nodeId: child.session, browseDirection: BrowseDirection.Forward, referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, resultMask: 63 }))
        )
        this.browses += 1
        return results.map((result) => (result.references?.length ?? 0) > 0)
    }
}
