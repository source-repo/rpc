import type {
    RpcDataMethod,
    RpcDataResource,
    RpcDataResources,
    RpcGetChildrenParams,
    RpcGetChildrenResult,
    RpcGetListParams,
    RpcGetListResult,
    RpcGetManyParams,
    RpcGetManyReferenceParams,
    RpcGetOneParams,
    RpcGetOneResult,
    RpcResource
} from '@source-repo/rpc'
import { NetworkDataProvider } from './NetworkDataProvider.js'
import type { NetworkDataRefusal } from './NetworkDataProvider.js'
import { networkRowFromKey, networkRowKey, networkScopeFromKey, networkScopeKey, type NetworkScopeRef } from './NetworkScope.js'

/** The one local resource handed to the existing scope-tree/leaf-grid renderer. */
const DEFAULT_NETWORK_COLUMNS = ['peer', 'namespace', 'resource', 'id', 'value'] as const

export const networkResource = (columns: readonly string[] = DEFAULT_NETWORK_COLUMNS): RpcDataResource => ({
    path: ['network'],
    verbs: ['getChildren', 'getList', 'getOne'],
    shape: 'tree',
    label: 'Network',
    row: {
        kind: 'object',
        fields: {
            peer: { type: { kind: 'string' } },
            namespace: { type: { kind: 'string' } },
            resource: { type: { kind: 'string' } },
            id: { type: { kind: 'string' } },
            value: { type: { kind: 'any' } }
        },
        additional: true
    },
    presentation: { defaultColumns: [...columns], representation: 'name' }
})

export const NETWORK_RESOURCE: RpcDataResource = networkResource()

/** Observable facts about the last aggregate list answer, kept outside the RPC-shaped result. */
export interface NetworkViewStatus {
    readonly settled: boolean
    readonly scope: NetworkScopeRef
    readonly asked: number
    readonly rows: number
    readonly total?: number
    readonly hasMore: boolean
    readonly partial: boolean
    readonly refused: readonly NetworkDataRefusal[]
    /** Declared fields promoted into the table for the currently selected heterogeneous set. */
    readonly columns: readonly string[]
}

const initialStatus: NetworkViewStatus = {
    settled: false,
    scope: { kind: 'network' },
    asked: 0,
    rows: 0,
    hasMore: false,
    partial: false,
    refused: [],
    columns: DEFAULT_NETWORK_COLUMNS
}

const contextColumns = (scope: NetworkScopeRef): readonly string[] => {
    switch (scope.kind) {
        case 'network':
            return ['peer', 'namespace', 'resource', 'id']
        case 'peer':
            return ['namespace', 'resource', 'id']
        case 'component':
            return ['resource', 'id']
        case 'resource':
        case 'branch':
            return ['id']
    }
}

/** Columns come from declarations, never by guessing at whichever values happened to arrive. */
const columnsFor = (scope: NetworkScopeRef, sources: NetworkDataRefusal['source'][]): readonly string[] => {
    const fields = sources.flatMap((source) => (source.row?.kind === 'object' ? Object.keys(source.row.fields) : []))
    const needsValue = sources.length === 0 || sources.some((source) => source.row?.kind !== 'object')
    return [...new Set([...contextColumns(scope), ...fields, ...(needsValue ? ['value'] : [])])]
}

export interface NetworkRpcDataProviderOptions {
    readonly provider: NetworkDataProvider
    /** A local cache clock, not a claim about the independent revisions beneath the merge. */
    readonly epoch?: string
    readonly revision?: number
}

/**
 * Adapt the composite provider to the exact resource protocol the current generic view consumes.
 *
 * This is local to the reader. It is not exposed on the RPC network and therefore grants nothing,
 * relays nothing and invents no network-wide component revision. The clock below exists only
 * because a protocol-shaped answer needs one for the local query cache.
 */
export class NetworkRpcDataProvider implements RpcDataResources {
    private readonly provider: NetworkDataProvider
    private readonly epoch: string
    private readonly revision: number
    private status: NetworkViewStatus = initialStatus
    private readonly listeners = new Set<() => void>()

    constructor(options: NetworkRpcDataProviderOptions) {
        this.provider = options.provider
        this.epoch = options.epoch ?? 'network-view'
        this.revision = options.revision ?? 0
    }

    dataResources(): readonly RpcDataResource[] {
        return [networkResource(this.status.columns)]
    }

    /** React's external-store shape, also useful to non-React hosts that want partial-result facts. */
    readonly getStatus = (): NetworkViewStatus => this.status

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async dataRequest(
        method: RpcDataMethod,
        resource: RpcResource,
        params: RpcGetListParams | RpcGetOneParams | RpcGetManyParams | RpcGetManyReferenceParams | RpcGetChildrenParams
    ): Promise<RpcGetListResult | RpcGetChildrenResult | RpcGetOneResult> {
        if (resource.length !== 1 || resource[0] !== 'network') throw new Error(`network view serves network, not ${resource.join('.')}`)
        switch (method) {
            case 'getChildren':
                return this.getChildren(params as RpcGetChildrenParams)
            case 'getList':
                return this.getList(params as RpcGetListParams)
            case 'getOne':
                return this.getOne(params as RpcGetOneParams)
            case 'getMany':
            case 'getManyReference':
                throw new Error(`network view does not answer ${method}`)
        }
    }

    private async getChildren(params: RpcGetChildrenParams): Promise<RpcGetChildrenResult> {
        const page = params.pagination?.page ?? 0
        if (page !== 0) throw new Error('network view: branch offset pages wait for the distributed continuation cursor')
        const parent = params.parentId === undefined ? ({ kind: 'network' } as const) : networkScopeFromKey(params.parentId)
        if (!parent) throw new Error('network view: parentId is not a scope locator')
        const answer = await this.provider.getChildren(parent, params.pagination?.pageSize)
        if (answer.refusal) throw new Error(answer.refusal.reason)
        const ids = answer.nodes.map((node) => networkScopeKey(node.ref))
        const defaultChild = answer.defaultChild === undefined ? undefined : this.defaultChild(parent, answer.defaultChild)
        return {
            ids,
            data: answer.nodes.map((node) => {
                const object = node.value !== null && typeof node.value === 'object' && !Array.isArray(node.value)
                return {
                    ...(object ? node.value : node.value === undefined ? {} : { value: node.value }),
                    name: node.label,
                    kind: node.ref.kind,
                    ...(node.interfaces?.length ? { interfaces: node.interfaces } : {}),
                    ...(node.issues?.length ? { issues: node.issues } : {})
                }
            }),
            // Everything in this answer is scope. The resource decides that before this adapter;
            // the leaf rows are obtained separately by `getList`.
            grouping: answer.nodes.map(() => true),
            hasChildren: answer.nodes.map((node) => node.expandable),
            hasMore: answer.hasMore,
            ...(defaultChild ? { defaultChild } : {}),
            epoch: this.epoch,
            revision: this.revision
        }
    }

    private async getList(params: RpcGetListParams): Promise<RpcGetListResult> {
        const scope = params.under === undefined ? ({ kind: 'network' } as const) : networkScopeFromKey(params.under)
        if (!scope) throw new Error('network view: under is not a scope locator')
        const answer = await this.provider.getList(scope, { ...params, under: undefined, recursive: undefined })
        this.status = {
            settled: true,
            scope,
            asked: answer.asked,
            rows: answer.rows.length,
            ...(answer.total !== undefined ? { total: answer.total } : {}),
            hasMore: answer.hasMore,
            partial: answer.partial,
            refused: answer.refused,
            columns: columnsFor(scope, [...answer.sources])
        }
        for (const listener of this.listeners) listener()
        return {
            ids: answer.rows.map((row) => networkRowKey(row.locator)),
            data: answer.rows.map((row) => {
                const object = row.value !== null && typeof row.value === 'object' && !Array.isArray(row.value)
                const declaredObject = row.type?.kind === 'object'
                return {
                    ...(object ? row.value : {}),
                    // Aggregate context wins over same-named provider fields. The provider's full
                    // row is still returned by getOne, so opening it loses nothing.
                    peer: row.source.peer,
                    namespace: row.source.namespace,
                    resource: row.source.resource.join('.'),
                    id: row.locator.id,
                    ...(!declaredObject ? { value: row.value } : {}),
                    ...(row.representation && object
                        ? { name: String((row.value as Record<string, unknown>)[row.representation] ?? row.locator.id) }
                        : { name: row.locator.id })
                }
            }),
            // The aggregate provider intentionally has no integer page 1 yet: its continuation
            // has to retain one cursor per source. Do not offer a pager that can only fail. The
            // external status above still says that this bounded answer is incomplete.
            ...(answer.total !== undefined && !answer.hasMore ? { total: answer.total } : {}),
            hasMore: false,
            epoch: this.epoch,
            revision: this.revision
        }
    }

    private async getOne(params: RpcGetOneParams): Promise<RpcGetOneResult> {
        const locator = networkRowFromKey(params.id)
        if (!locator) throw new Error('network view: id is not a row locator')
        return this.provider.getOne(locator)
    }

    private defaultChild(parent: NetworkScopeRef, id: string): string | undefined {
        if (parent.kind !== 'resource' && parent.kind !== 'branch') return undefined
        return networkScopeKey({ kind: 'branch', peer: parent.peer, namespace: parent.namespace, resource: parent.resource, id })
    }
}
