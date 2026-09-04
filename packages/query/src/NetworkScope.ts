import type { TypeNode } from '@source-repo/rpc'

/**
 * A stable selection in the network scope tree.
 *
 * Placement is deliberately absent. A peer may be attached under another host, and a component may
 * be reparented, without becoming a different thing to a cache, a saved view or a selected row.
 */
export type NetworkScopeRef =
    | { readonly kind: 'network' }
    | { readonly kind: 'peer'; readonly peer: string }
    | { readonly kind: 'component'; readonly peer: string; readonly namespace: string }
    | { readonly kind: 'resource'; readonly peer: string; readonly namespace: string; readonly resource: readonly string[] }
    | { readonly kind: 'branch'; readonly peer: string; readonly namespace: string; readonly resource: readonly string[]; readonly id: string }

/** One row anywhere on the network. The complete address is the identity. */
export interface NetworkRowLocator {
    readonly peer: string
    readonly namespace: string
    readonly resource: readonly string[]
    readonly id: string
}

export type NetworkScopeIssue =
    | { readonly kind: 'undescribed' }
    | { readonly kind: 'unresolved-parent'; readonly parent: string }
    | { readonly kind: 'cycle' }

/** A node for the existing scope tree to draw. Values never appear here. */
export interface NetworkScopeNode {
    readonly ref: NetworkScopeRef
    readonly label: string
    /** Whether selecting this node can produce rows in the grid. */
    readonly selectable: boolean
    /** Whether asking the catalogue (or, for a provider tree, the provider) may produce children. */
    readonly expandable: boolean
    /** The provider's branch record. A branch identity need not be its entire value. */
    readonly value?: unknown
    readonly interfaces?: readonly string[]
    readonly issues?: readonly NetworkScopeIssue[]
}

/** A concrete provider reached while resolving a selected scope. */
export interface NetworkResource {
    readonly peer: string
    readonly namespace: string
    readonly resource: readonly string[]
    /** Open for forward compatibility: an older reader may meet a provider with a newer verb. */
    readonly verbs: readonly string[]
    readonly shape: 'list' | 'tree'
    readonly row?: TypeNode
    readonly label?: string
    readonly interfaces: readonly string[]
    /** Props and state are served by the component base class rather than declared by a provider. */
    readonly componentRecord?: 'props' | 'state'
    /** A resource derived from the peer description and answered locally by the network adapter. */
    readonly synthetic?: {
        readonly kind: 'interfaces'
        readonly namespaces: NetworkDescription['namespaces']
        readonly transports: NonNullable<NetworkDescription['transports']>
    }
    readonly declaration?: NetworkResourceDescription
}

/** A deterministic key suitable for React, caches and persisted reader preferences. */
export const networkScopeKey = (scope: NetworkScopeRef): string => {
    switch (scope.kind) {
        case 'network':
            return JSON.stringify(['network'])
        case 'peer':
            return JSON.stringify(['peer', scope.peer])
        case 'component':
            return JSON.stringify(['component', scope.peer, scope.namespace])
        case 'resource':
            return JSON.stringify(['resource', scope.peer, scope.namespace, scope.resource])
        case 'branch':
            return JSON.stringify(['branch', scope.peer, scope.namespace, scope.resource, scope.id])
    }
}

/** Row ids are local to a resource, so none of the address may be omitted from its key. */
export const networkRowKey = (row: NetworkRowLocator): string => JSON.stringify([row.peer, row.namespace, row.resource, row.id])

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((part) => typeof part === 'string')

/** Parse only keys produced by `networkScopeKey`; arbitrary JSON is not a scope address. */
export const networkScopeFromKey = (key: string): NetworkScopeRef | undefined => {
    try {
        const value: unknown = JSON.parse(key)
        if (!Array.isArray(value)) return undefined
        if (value.length === 1 && value[0] === 'network') return { kind: 'network' }
        if (value.length === 2 && value[0] === 'peer' && typeof value[1] === 'string') return { kind: 'peer', peer: value[1] }
        if (value.length === 3 && value[0] === 'component' && typeof value[1] === 'string' && typeof value[2] === 'string')
            return { kind: 'component', peer: value[1], namespace: value[2] }
        if (value.length === 4 && value[0] === 'resource' && typeof value[1] === 'string' && typeof value[2] === 'string' && strings(value[3]))
            return { kind: 'resource', peer: value[1], namespace: value[2], resource: value[3] }
        if (value.length === 5 && value[0] === 'branch' && typeof value[1] === 'string' && typeof value[2] === 'string' && strings(value[3]) && typeof value[4] === 'string')
            return { kind: 'branch', peer: value[1], namespace: value[2], resource: value[3], id: value[4] }
        return undefined
    } catch {
        return undefined
    }
}

/** Parse only complete row locators, including a resource path and its local id. */
export const networkRowFromKey = (key: string): NetworkRowLocator | undefined => {
    try {
        const value: unknown = JSON.parse(key)
        return Array.isArray(value) && value.length === 4 && typeof value[0] === 'string' && typeof value[1] === 'string' && strings(value[2]) && typeof value[3] === 'string'
            ? { peer: value[0], namespace: value[1], resource: value[2], id: value[3] }
            : undefined
    } catch {
        return undefined
    }
}

/** The structural subset of `describe()` needed to build the catalogue. */
export interface NetworkResourceDescription {
    readonly path: readonly string[]
    readonly verbs: readonly string[]
    readonly shape?: 'list' | 'tree'
    readonly row?: TypeNode
    readonly label?: string
    readonly presentation?: { readonly representation?: string }
}

export interface NetworkDescription {
    readonly name: string
    readonly version?: string
    readonly validating?: boolean
    readonly transports?: readonly {
        readonly name: string
        readonly protocol: string
        readonly role: 'listen' | 'connect' | 'broker' | 'port' | 'custom'
        readonly endpoint?: string
    }[]
    readonly host?: {
        readonly parent: { readonly peer: string; readonly instance: string } | null
        readonly label?: string
        readonly place?: readonly string[]
    }
    readonly namespaces: readonly {
        readonly name: string
        readonly version?: string
        readonly className?: string
        readonly created?: boolean
        readonly emitter?: boolean
        readonly serialised?: boolean
        readonly capabilities?: readonly string[]
        readonly topology?: {
            readonly parent: { readonly peer: string; readonly instance: string } | null
            readonly label?: string
        }
        readonly component?: {
            readonly subscribers?: number
            readonly props?: TypeNode
            readonly state?: TypeNode
            readonly resources?: readonly NetworkResourceDescription[]
        }
        readonly methods?: readonly {
            readonly name: string
            readonly params?: readonly TypeNode[]
            readonly paramNames?: readonly string[]
            readonly rest?: TypeNode
            readonly returns?: TypeNode
            readonly semantics?: string
            readonly effect?: string
            readonly sets?: string
            readonly requiresAuthority?: boolean
        }[]
    }[]
}

type DescriptionMap = Readonly<Record<string, NetworkDescription | undefined>>

const componentRef = (peer: string, namespace: string): NetworkScopeRef => ({ kind: 'component', peer, namespace })
const peerRef = (peer: string): NetworkScopeRef => ({ kind: 'peer', peer })

/**
 * Every member of a parent cycle.
 *
 * Parent links are display structure supplied by remote peers. Treating them as trusted recursion
 * would let two mistaken descriptions remove both peers from the roots and recurse forever if one
 * were reached another way. Every member of the cycle becomes a root and carries the issue.
 */
const cycleMembers = (names: readonly string[], parentOf: (name: string) => string | undefined): ReadonlySet<string> => {
    const cycles = new Set<string>()
    for (const start of names) {
        const path: string[] = []
        const at = new Map<string, number>()
        let current: string | undefined = start
        while (current !== undefined) {
            const repeated = at.get(current)
            if (repeated !== undefined) {
                for (const member of path.slice(repeated)) cycles.add(member)
                break
            }
            at.set(current, path.length)
            path.push(current)
            current = parentOf(current)
        }
    }
    return cycles
}

const byLabel = (a: NetworkScopeNode, b: NetworkScopeNode) => a.label.localeCompare(b.label) || networkScopeKey(a.ref).localeCompare(networkScopeKey(b.ref))

/**
 * The structure already known about a network, independent of a renderer and of current values.
 *
 * Descriptions are supplied rather than fetched here. The console can therefore keep its present
 * lazy rule: a peer is visible as soon as presence names it, and expanding/selecting it decides
 * when `describe()` is worth a round trip. Replacing the descriptions creates a new cheap catalogue.
 */
export class NetworkScopeCatalogue {
    private readonly peers: readonly string[]
    private readonly descriptions: DescriptionMap
    private readonly peerParents = new Map<string, string>()
    private readonly peerUnresolved = new Map<string, string>()
    private readonly peerCycles: ReadonlySet<string>
    private readonly componentParents = new Map<string, Map<string, string>>()
    private readonly componentUnresolved = new Map<string, Map<string, string>>()
    private readonly componentCycles = new Map<string, ReadonlySet<string>>()

    constructor(peers: readonly string[], descriptions: DescriptionMap) {
        this.peers = [...new Set(peers)].sort()
        this.descriptions = descriptions
        const known = new Set(this.peers)

        for (const peer of this.peers) {
            const parent = descriptions[peer]?.host?.parent
            if (!parent) continue
            if (parent.instance !== '$host' || !known.has(parent.peer)) this.peerUnresolved.set(peer, `${parent.peer}/${parent.instance}`)
            else this.peerParents.set(peer, parent.peer)
        }
        this.peerCycles = cycleMembers(this.peers, (peer) => this.peerParents.get(peer))

        for (const peer of this.peers) {
            const components = descriptions[peer]?.namespaces.filter((namespace) => namespace.component) ?? []
            const names = new Set(components.map((namespace) => namespace.name))
            const parents = new Map<string, string>()
            const unresolved = new Map<string, string>()
            for (const component of components) {
                const parent = component.topology?.parent
                if (!parent || parent.instance === '$host') continue
                if (parent.peer !== peer || !names.has(parent.instance)) unresolved.set(component.name, `${parent.peer}/${parent.instance}`)
                else parents.set(component.name, parent.instance)
            }
            this.componentParents.set(peer, parents)
            this.componentUnresolved.set(peer, unresolved)
            this.componentCycles.set(
                peer,
                cycleMembers(
                    [...names],
                    (namespace) => parents.get(namespace)
                )
            )
        }
    }

    /** The synthetic network root, so the same tree component can render the whole hierarchy. */
    roots(): readonly NetworkScopeNode[] {
        return [this.node({ kind: 'network' })]
    }

    /** Known children only. Provider-owned branch children are added by the asynchronous adapter. */
    children(scope: NetworkScopeRef): readonly NetworkScopeNode[] {
        switch (scope.kind) {
            case 'network':
                return this.peers.filter((peer) => !this.effectivePeerParent(peer)).map((peer) => this.node(peerRef(peer))).sort(byLabel)
            case 'peer': {
                const childPeers = this.peers.filter((peer) => this.effectivePeerParent(peer) === scope.peer).map((peer) => this.node(peerRef(peer)))
                const components = this.components(scope.peer)
                    .filter((namespace) => !this.effectiveComponentParent(scope.peer, namespace.name))
                    .map((namespace) => this.node(componentRef(scope.peer, namespace.name)))
                const resources = this.peerResources(scope.peer).map((resource) =>
                    this.node({ kind: 'resource', peer: scope.peer, namespace: resource.namespace, resource: resource.resource })
                )
                return [...childPeers, ...components, ...resources].sort(byLabel)
            }
            case 'component': {
                const components = this.components(scope.peer)
                    .filter((namespace) => this.effectiveComponentParent(scope.peer, namespace.name) === scope.namespace)
                    .map((namespace) => this.node(componentRef(scope.peer, namespace.name)))
                const resources = this.resourcesOf(scope.peer, scope.namespace).map((resource) =>
                    this.node({ kind: 'resource', peer: scope.peer, namespace: scope.namespace, resource: resource.resource })
                )
                return [...components, ...resources].sort(byLabel)
            }
            case 'resource':
            case 'branch':
                return []
        }
    }

    /** Every concrete resource beneath a selection, in stable tree order and without duplicates. */
    resourcesUnder(scope: NetworkScopeRef): readonly NetworkResource[] {
        if (scope.kind === 'resource' || scope.kind === 'branch') {
            const resource = this.resourcesAt(scope.peer, scope.namespace).find((one) => one.resource.length === scope.resource.length && one.resource.every((segment, at) => segment === scope.resource[at]))
            return resource ? [resource] : []
        }

        const found: NetworkResource[] = []
        const seenScopes = new Set<string>()
        const seenResources = new Set<string>()
        const visit = (at: NetworkScopeRef) => {
            const key = networkScopeKey(at)
            if (seenScopes.has(key)) return
            seenScopes.add(key)
            if (at.kind === 'resource') {
                for (const resource of this.resourcesUnder(at)) {
                    const resourceKey = networkScopeKey({ kind: 'resource', peer: resource.peer, namespace: resource.namespace, resource: resource.resource })
                    if (!seenResources.has(resourceKey)) {
                        seenResources.add(resourceKey)
                        found.push(resource)
                    }
                }
                return
            }
            for (const child of this.children(at)) visit(child.ref)
        }
        visit(scope)
        return found
    }

    node(ref: NetworkScopeRef): NetworkScopeNode {
        switch (ref.kind) {
            case 'network':
                return { ref, label: 'Network', selectable: true, expandable: this.peers.length > 0 }
            case 'peer': {
                const description = this.descriptions[ref.peer]
                const issues: NetworkScopeIssue[] = []
                if (!description) issues.push({ kind: 'undescribed' })
                const unresolved = this.peerUnresolved.get(ref.peer)
                if (unresolved) issues.push({ kind: 'unresolved-parent', parent: unresolved })
                if (this.peerCycles.has(ref.peer)) issues.push({ kind: 'cycle' })
                return {
                    ref,
                    label: description?.host?.label ?? ref.peer,
                    selectable: true,
                    expandable: this.childrenOfPeerExist(ref.peer),
                    ...(description
                        ? {
                              value: {
                                  name: description.name,
                                  ...(description.version ? { version: description.version } : {}),
                                  ...(description.validating !== undefined ? { validating: description.validating } : {}),
                                  namespaces: description.namespaces.length,
                                  ...(description.transports?.length ? { transports: description.transports.length } : {}),
                                  ...(description.host?.place?.length ? { place: description.host.place } : {})
                              }
                          }
                        : {}),
                    ...(issues.length ? { issues } : {})
                }
            }
            case 'component': {
                const namespace = this.components(ref.peer).find((one) => one.name === ref.namespace)
                const issues: NetworkScopeIssue[] = []
                const unresolved = this.componentUnresolved.get(ref.peer)?.get(ref.namespace)
                if (unresolved) issues.push({ kind: 'unresolved-parent', parent: unresolved })
                if (this.componentCycles.get(ref.peer)?.has(ref.namespace)) issues.push({ kind: 'cycle' })
                return {
                    ref,
                    label: namespace?.topology?.label ?? ref.namespace,
                    selectable: true,
                    expandable: this.childrenOfComponentExist(ref.peer, ref.namespace),
                    ...(namespace
                        ? {
                              value: {
                                  name: namespace.name,
                                  ...(namespace.version ? { version: namespace.version } : {}),
                                  ...(namespace.className ? { className: namespace.className } : {}),
                                  ...(namespace.created !== undefined ? { created: namespace.created } : {}),
                                  ...(namespace.emitter !== undefined ? { emitter: namespace.emitter } : {}),
                                  ...(namespace.serialised !== undefined ? { serialised: namespace.serialised } : {}),
                                  ...(namespace.component?.subscribers !== undefined ? { subscribers: namespace.component.subscribers } : {}),
                                  ...(namespace.capabilities?.length ? { capabilities: namespace.capabilities } : {})
                              }
                          }
                        : {}),
                    ...(namespace?.capabilities?.length ? { interfaces: namespace.capabilities } : {}),
                    ...(issues.length ? { issues } : {})
                }
            }
            case 'resource': {
                const resource = this.resourcesAt(ref.peer, ref.namespace).find(
                    (one) => one.resource.length === ref.resource.length && one.resource.every((segment, at) => segment === ref.resource[at])
                )
                return {
                    ref,
                    label: resource?.label ?? ref.resource.join('.'),
                    selectable: !!resource,
                    expandable: resource?.shape === 'tree',
                    ...(resource
                        ? {
                              value: {
                                  name: resource.label ?? resource.resource.join('.'),
                                  path: resource.resource,
                                  shape: resource.shape,
                                  verbs: resource.verbs
                              }
                          }
                        : {}),
                    ...(resource?.interfaces.length ? { interfaces: resource.interfaces } : {})
                }
            }
            case 'branch':
                return { ref, label: ref.id, selectable: true, expandable: true }
        }
    }

    private components(peer: string) {
        return (this.descriptions[peer]?.namespaces.filter((namespace) => namespace.component) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    }

    private effectivePeerParent(peer: string): string | undefined {
        return this.peerCycles.has(peer) ? undefined : this.peerParents.get(peer)
    }

    private effectiveComponentParent(peer: string, namespace: string): string | undefined {
        return this.componentCycles.get(peer)?.has(namespace) ? undefined : this.componentParents.get(peer)?.get(namespace)
    }

    private childrenOfPeerExist(peer: string): boolean {
        return this.peerResources(peer).length > 0 || this.peers.some((other) => this.effectivePeerParent(other) === peer) || this.components(peer).some((namespace) => !this.effectiveComponentParent(peer, namespace.name))
    }

    private childrenOfComponentExist(peer: string, namespace: string): boolean {
        return this.components(peer).some((component) => this.effectiveComponentParent(peer, component.name) === namespace) || this.resourcesOf(peer, namespace).length > 0
    }

    private resourcesAt(peer: string, namespace: string): readonly NetworkResource[] {
        return namespace === '$peer' ? this.peerResources(peer) : this.resourcesOf(peer, namespace)
    }

    /** The RPC surface of a peer, as namespace/transport branches and their descriptive leaves. */
    private peerResources(peer: string): readonly NetworkResource[] {
        const description = this.descriptions[peer]
        if (!description) return []
        const namespaces = description.namespaces
        const transports = description.transports ?? []
        const row: TypeNode = {
            kind: 'object',
            fields: {
                name: { type: { kind: 'string' } },
                interface: { type: { kind: 'string' }, optional: true },
                method: { type: { kind: 'string' }, optional: true },
                parameters: { type: { kind: 'array', items: { kind: 'any' } }, optional: true },
                rest: { type: { kind: 'any' }, optional: true },
                returns: { type: { kind: 'any' }, optional: true },
                semantics: { type: { kind: 'string' }, optional: true },
                effect: { type: { kind: 'string' }, optional: true },
                sets: { type: { kind: 'string' }, optional: true },
                requiresAuthority: { type: { kind: 'boolean' }, optional: true },
                capabilities: { type: { kind: 'array', items: { kind: 'string' } }, optional: true },
                transport: { type: { kind: 'string' }, optional: true },
                role: { type: { kind: 'string' }, optional: true },
                endpoint: { type: { kind: 'string' }, optional: true },
                kind: { type: { kind: 'string' } }
            },
            additional: true
        }
        return [
            {
                peer,
                namespace: '$peer',
                resource: ['interfaces'],
                verbs: ['getChildren', 'getList', 'getOne'],
                shape: 'tree',
                row,
                label: 'Interfaces',
                interfaces: [],
                synthetic: { kind: 'interfaces', namespaces, transports },
                declaration: {
                    path: ['interfaces'],
                    verbs: ['getChildren', 'getList', 'getOne'],
                    shape: 'tree',
                    row,
                    label: 'Interfaces',
                    presentation: { representation: 'name' }
                }
            }
        ]
    }

    private resourcesOf(peer: string, namespaceName: string): readonly NetworkResource[] {
        const namespace = this.components(peer).find((one) => one.name === namespaceName)
        if (!namespace?.component) return []
        const interfaces = namespace.capabilities ?? []
        const resources: NetworkResource[] = []
        const declares = (root: string) => namespace.component?.resources?.some((resource) => resource.path.length === 1 && resource.path[0] === root)
        // Compatibility with descriptions from before RpcComponent published these two built-in
        // resources. They still travel through the provider vocabulary here; no network viewer
        // walks their schema or snapshot to manufacture rows.
        if (namespace.component.props && !declares('props'))
            resources.push({ peer, namespace: namespaceName, resource: ['props'], verbs: ['getChildren', 'getList', 'getOne', 'getMany'], shape: 'tree', interfaces, componentRecord: 'props', row: { kind: 'any' } })
        if (namespace.component.state && !declares('state'))
            resources.push({ peer, namespace: namespaceName, resource: ['state'], verbs: ['getChildren', 'getList', 'getOne', 'getMany'], shape: 'tree', interfaces, componentRecord: 'state', row: { kind: 'any' } })
        for (const declaration of namespace.component.resources ?? []) {
            if (!declaration.verbs.includes('getList') && !(declaration.shape === 'tree' && declaration.verbs.includes('getChildren'))) continue
            resources.push({
                peer,
                namespace: namespaceName,
                resource: declaration.path,
                verbs: declaration.verbs,
                shape: declaration.shape ?? 'list',
                row: declaration.row,
                label: declaration.label,
                interfaces,
                declaration
            })
        }
        return resources.sort((a, b) => (a.label ?? a.resource.join('.')).localeCompare(b.label ?? b.resource.join('.')) || a.resource.join('.').localeCompare(b.resource.join('.')))
    }
}
