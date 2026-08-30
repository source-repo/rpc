import { rpc, rpcNamespace, type RpcRef } from '@source-repo/rpc'
import { AspectProvider, type AspectDescriptor, type AspectRef, type Branch, type ObjectDetail } from '@source-repo/aspects'
import { AttributeIds, BrowseDirection, NodeClass, OPCUAClient, type ClientSession, type OPCUAClientOptions } from 'node-opcua-client'
import { fromSessionNodeId, portableNodeIdFromText, portableNodeIdToText, toSessionNodeId } from './Identity.js'

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

    constructor(options: OpcUaProviderOptions) {
        super(
            { label: options.label ?? options.endpointUrl, endpointUrl: options.endpointUrl },
            { status: 'disconnected', namespaces: 0 }
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
                defaultColumns: ['title', 'nodeClass', 'dataType']
            }
        ]
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
            this.setState({ status: 'failed', namespaces: 0, problem: error instanceof Error ? error.message : String(error) })
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
        this.setState({ status: 'disconnected', namespaces: 0 })
    }

    /** How many Browse requests have been sent. Published so the probe's cost is a number. */
    @rpc({ semantics: 'query', effect: 'observe' })
    browseCount(): number {
        return this.browses
    }

    async children(aspectId: string, parentOccurrenceId: string | undefined, page: { from: number; size: number }): Promise<Branch> {
        if (aspectId !== ADDRESS_SPACE) throw new Error(`no aspect ${aspectId}`)
        this.connected()
        // An occurrence in this aspect is the browse path that reached the node, so the node to
        // browse is its last segment - and the path is what makes one node appearing under two
        // parents two occurrences rather than one.
        const parentNode = parentOccurrenceId ? this.nodeOf(parentOccurrenceId) : OBJECTS_FOLDER
        const references = await this.browse(parentNode)

        const total = references.length
        const window = references.slice(page.from, page.from + page.size)
        const flags = await this.hasChildrenFor(window)

        return {
            total,
            occurrences: window.map((reference, at) => ({
                occurrenceId: parentOccurrenceId ? `${parentOccurrenceId}/${reference.session}` : reference.session,
                ref: { provider: this.identity, resource: ['nodes'], id: reference.portable },
                title: reference.title,
                kind: `opcua.${reference.nodeClass.toLowerCase()}`,
                relation: reference.reference,
                hasChildren: flags[at],
                fields: { nodeClass: reference.nodeClass, nodeId: reference.portable }
            }))
        }
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
        if (aspectId !== ADDRESS_SPACE) return []
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

        const [displayName, browseName, nodeClass, description] = await session.read([
            { nodeId: node, attributeId: AttributeIds.DisplayName },
            { nodeId: node, attributeId: AttributeIds.BrowseName },
            { nodeId: node, attributeId: AttributeIds.NodeClass },
            { nodeId: node, attributeId: AttributeIds.Description }
        ])
        const title = String((displayName.value.value as { text?: string })?.text ?? (browseName.value.value as { name?: string })?.name ?? target.id)
        const kind = NodeClass[Number(nodeClass.value.value)] ?? 'Unspecified'

        return {
            ref: target,
            kind: `opcua.${String(kind).toLowerCase()}`,
            title,
            ...(((description.value.value as { text?: string })?.text) ? { summary: String((description.value.value as { text?: string }).text) } : {}),
            fields: { nodeId: target.id, browseName: String((browseName.value.value as { name?: string })?.name ?? ''), nodeClass: String(kind) },
            origin: { system: 'opcua', externalId: target.id, url: this.props.endpointUrl, retrievedAt: new Date().toISOString() }
        }
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
