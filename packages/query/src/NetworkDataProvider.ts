import {
    matchesFilter,
    pageEntries,
    type RpcFilterCondition,
    type RpcGetChildrenResult,
    type RpcGetListParams,
    type RpcGetListResult,
    type RpcGetManyResult,
    type RpcGetOneResult,
    type RpcSort,
    type RpcFilter,
    type TypeNode
} from '@source-repo/rpc'
import type { RpcDataAnswer } from './Cache.js'
import type { RpcQuestion } from './Key.js'
import { NetworkScopeCatalogue, type NetworkResource, type NetworkRowLocator, type NetworkScopeNode, type NetworkScopeRef } from './NetworkScope.js'

/** One row from one resource, with enough context to remain itself in an aggregate grid. */
export interface NetworkDataRow {
    readonly locator: NetworkRowLocator
    readonly source: {
        readonly peer: string
        readonly namespace: string
        readonly resource: readonly string[]
        readonly interfaces: readonly string[]
    }
    readonly value: unknown
    readonly type?: TypeNode
    readonly representation?: string
}

export interface NetworkDataRefusal {
    readonly source: NetworkResource
    readonly reason: string
}

export interface NetworkChildrenResult {
    /** Branches only. Leaves belong in the grid and are obtained with `getList`. */
    readonly nodes: readonly NetworkScopeNode[]
    readonly hasMore: boolean
    readonly defaultChild?: string
    readonly refusal?: NetworkDataRefusal
}

/**
 * The first page of an aggregate scope.
 *
 * There is deliberately no epoch or revision: independent components have independent clocks, and
 * manufacturing one for the merge would make it compare equal to nothing. Each underlying answer
 * remains in `RpcDataCache`, with its own freshness governed by its own component channel.
 */
export interface NetworkDataResult {
    readonly rows: readonly NetworkDataRow[]
    readonly refused: readonly NetworkDataRefusal[]
    /** Sources selected after structural filtering, including any that refused the row question. */
    readonly sources: readonly NetworkResource[]
    /** Providers actually sent a `$data` question. */
    readonly asked: number
    /** Known only when every participating provider answered with a total and none refused. */
    readonly total?: number
    /** More rows exist than this bounded answer carries. */
    readonly hasMore: boolean
    /** Some source could not answer, or the bounded answer could not carry everything found. */
    readonly partial: boolean
}

export interface NetworkDataProviderOptions {
    readonly catalogue: NetworkScopeCatalogue
    /** Usually `question => cache.fetch(question)`: addressing stays with the caller holding the link. */
    readonly ask: (question: RpcQuestion) => Promise<RpcDataAnswer>
    /** Maximum provider questions in flight. */
    readonly concurrency?: number
    /** Default aggregate bound when the caller supplies no page size. */
    readonly pageSize?: number
}

const messageOf = (failure: unknown) => (failure as { message?: string })?.message ?? String(failure)

/** A small bounded map. The answers keep input order, irrespective of which peer answers first. */
const concurrently = async <T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> => {
    const answers: R[] = new Array(items.length)
    let next = 0
    const runner = async () => {
        for (;;) {
            const mine = next++
            if (mine >= items.length) return
            answers[mine] = await work(items[mine])
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, runner))
    return answers
}

type SourceAnswer = { readonly source: NetworkResource; readonly answer?: RpcGetListResult; readonly refusal?: NetworkDataRefusal }
type SourceQuery = { readonly source: NetworkResource; readonly filter?: RpcFilter }

const interfaceBranchId = (name: string) => JSON.stringify(['interface', name])
const transportsBranchId = JSON.stringify(['transports'])
const interfaceFromBranchId = (id: string): string | undefined => {
    try {
        const value: unknown = JSON.parse(id)
        return Array.isArray(value) && value.length === 2 && value[0] === 'interface' && typeof value[1] === 'string' ? value[1] : undefined
    } catch {
        return undefined
    }
}

/** Fields in the aggregate row that belong to its source rather than to the row it carries. */
const sourceField = (field: string | undefined): 'peer' | 'namespace' | 'resource' | 'interface' | undefined => {
    const name = field?.startsWith('source.') ? field.slice('source.'.length) : field
    return name === 'peer' || name === 'namespace' || name === 'resource' || name === 'interface' ? name : undefined
}

const sourceValueMatches = (condition: RpcFilterCondition, value: unknown, id: string): boolean =>
    matchesFilter({ ...condition, field: undefined }, value, id)

const rowSortForSource = (sort: RpcSort | undefined): RpcSort | undefined => {
    if (!sort) return undefined
    if (sourceField(sort.field)) return undefined
    return sort.field?.startsWith('row.') ? { ...sort, field: sort.field.slice('row.'.length) } : sort
}

const atPath = (value: unknown, path: string): unknown => {
    let at = value
    for (const step of path.split('.')) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as Record<string, unknown>)[step]
    }
    return at
}

const aggregateSortValue = (row: NetworkDataRow, field: string | undefined): unknown => {
    if (field === undefined || field === 'id') return row.locator.id
    const structural = sourceField(field)
    if (structural === 'peer') return row.source.peer
    if (structural === 'namespace') return row.source.namespace
    if (structural === 'resource') return row.source.resource.join('.')
    if (structural === 'interface') return row.source.interfaces.join(',')
    return atPath(row.value, field.startsWith('row.') ? field.slice('row.'.length) : field)
}

/** Undefined remains last in both directions, matching the ordinary in-memory provider. */
const compareAggregate = (left: NetworkDataRow, right: NetworkDataRow, sort: RpcSort): number => {
    const a = aggregateSortValue(left, sort.field)
    const b = aggregateSortValue(right, sort.field)
    if (a === b) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    return sort.order === 'DESC' ? -order : order
}

/**
 * Evaluate the structural half of a filter for one provider and retain its row half.
 *
 * The result is deliberately three-valued: `true` means the source predicate made this branch of
 * the expression unconditional, `false` excludes it, and a filter is what still has to be answered
 * by the provider. Simplifying recursively is what preserves mixed `all`/`any` expressions. For
 * example, on an Oven source `interface:plant.Oven | quality:bad` is true (all its rows qualify),
 * while on another source it becomes only `quality:bad`.
 *
 * Aggregate field names are reserved because those are the columns the network view displays. A
 * provider row with one of the same names remains addressable as `row.peer`, `row.resource`, etc.
 */
export const networkFilterForSource = (filter: RpcFilter, source: NetworkResource): RpcFilter | boolean => {
    const group = filter as { readonly all?: readonly RpcFilter[]; readonly any?: readonly RpcFilter[] }
    if (group.all) {
        const children = group.all.map((inner) => networkFilterForSource(inner, source))
        if (children.some((child) => child === false)) return false
        const remaining = children.filter((child): child is RpcFilter => child !== true)
        return remaining.length === 0 ? true : remaining.length === 1 ? remaining[0] : { all: remaining }
    }
    if (group.any) {
        const children = group.any.map((inner) => networkFilterForSource(inner, source))
        if (children.some((child) => child === true)) return true
        const remaining = children.filter((child): child is RpcFilter => child !== false)
        return remaining.length === 0 ? false : remaining.length === 1 ? remaining[0] : { any: remaining }
    }

    const condition = filter as RpcFilterCondition
    if (condition.field?.startsWith('row.')) return { ...condition, field: condition.field.slice('row.'.length) }
    const field = sourceField(condition.field)
    if (!field) return condition
    if (field === 'interface') {
        // On the synthetic interfaces resource this is a row field: its branches are interface
        // names and its leaves are methods. Retaining the predicate lets the local provider filter
        // those leaves just as a remote table would. Everywhere else it selects sources by their
        // advertised capabilities before any question crosses the network.
        if (source.synthetic?.kind === 'interfaces') return { ...condition, field: 'interface' }
        // Positive conditions mean "any advertised interface". `ne` means the useful inverse:
        // none of the advertised interfaces equals the operand, including a source with none.
        return condition.op === 'ne'
            ? source.interfaces.every((capability) => sourceValueMatches(condition, capability, capability))
            : source.interfaces.some((capability) => sourceValueMatches(condition, capability, capability))
    }
    const value = field === 'peer' ? source.peer : field === 'namespace' ? source.namespace : source.resource.join('.')
    return sourceValueMatches(condition, value, String(value))
}

/**
 * A DataProvider over a selection rather than over one store.
 *
 * It composes the providers already present; it does not relay through a privileged service. Each
 * question retains the target peer and namespace and is therefore made under the reader's existing
 * identity by the supplied `ask` function.
 */
export class NetworkDataProvider {
    private readonly catalogue: NetworkScopeCatalogue
    private readonly ask: NetworkDataProviderOptions['ask']
    private readonly concurrency: number
    private readonly pageSize: number

    constructor(options: NetworkDataProviderOptions) {
        this.catalogue = options.catalogue
        this.ask = options.ask
        this.concurrency = options.concurrency ?? 6
        this.pageSize = options.pageSize ?? 100
    }

    /**
     * Children of a structural scope, or provider-owned branches of a resource scope.
     *
     * The resource's positional `grouping` answer is authoritative. An object row may be a leaf and
     * an empty folder remains a branch; neither can be decided by inspecting the value.
     */
    async getChildren(scope: NetworkScopeRef, pageSize: number = this.pageSize): Promise<NetworkChildrenResult> {
        if (scope.kind !== 'resource' && scope.kind !== 'branch') return { nodes: this.catalogue.children(scope), hasMore: false }
        const source = this.catalogue.resourcesUnder(scope)[0]
        if (!source) return { nodes: [], hasMore: false }
        if (source.shape !== 'tree' || !source.verbs.includes('getChildren'))
            return { nodes: [], hasMore: false, refusal: { source, reason: `${source.resource.join('.')} is not a browsable tree` } }
        if (source.synthetic?.kind === 'interfaces') {
            if (scope.kind === 'branch') return { nodes: [], hasMore: false }
            const namespaces = [...source.synthetic.namespaces]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(
                    (namespace): NetworkScopeNode => ({
                        ref: { kind: 'branch', peer: source.peer, namespace: source.namespace, resource: source.resource, id: interfaceBranchId(namespace.name) },
                        label: namespace.name,
                        selectable: true,
                        expandable: false,
                        value: {
                            name: namespace.name,
                            ...(namespace.version ? { version: namespace.version } : {}),
                            ...(namespace.className ? { className: namespace.className } : {}),
                            ...(namespace.created !== undefined ? { created: namespace.created } : {}),
                            ...(namespace.emitter !== undefined ? { emitter: namespace.emitter } : {}),
                            ...(namespace.serialised !== undefined ? { serialised: namespace.serialised } : {}),
                            ...(namespace.capabilities?.length ? { capabilities: namespace.capabilities } : {})
                        },
                        ...(namespace.capabilities?.length ? { interfaces: namespace.capabilities } : {})
                    })
                )
            const transportNodes: NetworkScopeNode[] = source.synthetic.transports.length
                ? [
                      {
                          ref: { kind: 'branch', peer: source.peer, namespace: source.namespace, resource: source.resource, id: transportsBranchId },
                          label: 'Transports',
                          selectable: true,
                          expandable: false,
                          value: {
                              name: 'Transports',
                              transports: source.synthetic.transports.length,
                              protocols: [...new Set(source.synthetic.transports.map((transport) => transport.protocol))].sort()
                          }
                      }
                  ]
                : []
            return { nodes: [...namespaces, ...transportNodes].sort((a, b) => a.label.localeCompare(b.label)), hasMore: false }
        }
        const question: RpcQuestion = {
            target: source.peer,
            namespace: source.namespace,
            method: 'getChildren',
            resource: source.resource,
            params: {
                ...(scope.kind === 'branch' ? { parentId: scope.id } : {}),
                pagination: { page: 0, pageSize }
            }
        }
        try {
            const answer = (await this.ask(question)) as RpcGetChildrenResult
            const representation = source.declaration?.presentation?.representation
            const nodes = answer.ids.flatMap((id, at): NetworkScopeNode[] => {
                // `grouping` was added after `hasChildren`; its documented fallback preserves what
                // older providers meant while letting a new provider distinguish an empty folder
                // from a leaf object that happens to carry properties.
                const grouping = answer.grouping?.[at] ?? answer.hasChildren[at]
                if (!grouping) return []
                const value = answer.data[at]
                const named = representation && value && typeof value === 'object' ? (value as Record<string, unknown>)[representation] : undefined
                return [
                    {
                        ref: { kind: 'branch', peer: source.peer, namespace: source.namespace, resource: source.resource, id },
                        label: typeof named === 'string' && named ? named : id,
                        selectable: true,
                        value,
                        // A grouping row is a place even when it is empty. `hasChildren` decides
                        // whether expanding it is expected to return anything, not whether it is a
                        // branch at all; keeping it selectable still scopes the grid to emptiness.
                        expandable: answer.hasChildren[at] === true,
                        ...(source.interfaces.length ? { interfaces: source.interfaces } : {})
                    }
                ]
            })
            return { nodes, hasMore: answer.hasMore ?? false, ...(answer.defaultChild ? { defaultChild: answer.defaultChild } : {}) }
        } catch (failure) {
            return { nodes: [], hasMore: false, refusal: { source, reason: messageOf(failure) } }
        }
    }

    /**
     * Ask the first bounded page beneath a scope.
     *
     * A non-zero global offset is refused for now. Applying it independently to every provider
     * would not be page two of the merge, and applying it after fetching would require all earlier
     * rows from every provider. The future answer is a continuation cursor carrying each source's
     * position, not an integer dressed up as one.
     */
    async getList(scope: NetworkScopeRef, params: RpcGetListParams = {}): Promise<NetworkDataResult> {
        const page = params.pagination?.page ?? 0
        if (page !== 0) throw new Error('network data: aggregate offset pages are not supported; ask page 0 until the distributed continuation cursor exists')
        const limit = params.pagination?.pageSize ?? this.pageSize
        if (!Number.isInteger(limit) || limit < 0) throw new Error('network data: pageSize must be a non-negative integer')

        const sources = this.catalogue.resourcesUnder(scope)
        const selected: SourceQuery[] = sources.flatMap((source) => {
            if (!params.filter) return [{ source }]
            const filter = networkFilterForSource(params.filter, source)
            return filter === false ? [] : [{ source, ...(filter === true ? {} : { filter }) }]
        })
        const immediatelyRefused: NetworkDataRefusal[] = selected
            .filter(({ source }) => !source.verbs.includes('getList'))
            .map(({ source }) => ({ source, reason: `${source.resource.join('.')} cannot list all leaves; it answers ${source.verbs.join(', ')}` }))
        const queryable = selected.filter(({ source }) => source.verbs.includes('getList'))
        const sourceSort = rowSortForSource(params.sort)
        const answers = await concurrently(queryable, this.concurrency, async ({ source, filter }): Promise<SourceAnswer> => {
            if (source.synthetic?.kind === 'interfaces') {
                return {
                    source,
                    answer: this.interfaceList(source, {
                        pagination: { page: 0, pageSize: limit },
                        ...(filter ? { filter } : {}),
                        ...(sourceSort ? { sort: sourceSort } : {}),
                        ...(scope.kind === 'branch' ? { under: scope.id } : {})
                    })
                }
            }
            const question: RpcQuestion = {
                target: source.peer,
                namespace: source.namespace,
                method: 'getList',
                resource: source.resource,
                params: {
                    pagination: { page: 0, pageSize: limit },
                    ...(filter ? { filter } : {}),
                    ...(sourceSort ? { sort: sourceSort } : {}),
                    // Props/state need the same recursive leaf walk as a selected component scope.
                    // A provider tree also owns the efficient meaning of all leaves beneath it.
                    ...(source.componentRecord || source.shape === 'tree' ? { recursive: true } : {}),
                    ...(scope.kind === 'branch' ? { under: scope.id } : {})
                }
            }
            try {
                return { source, answer: (await this.ask(question)) as RpcGetListResult }
            } catch (failure) {
                return { source, refusal: { source, reason: messageOf(failure) } }
            }
        })

        const refused = [...immediatelyRefused, ...answers.flatMap((entry) => (entry.refusal ? [entry.refusal] : []))]
        const found: NetworkDataRow[] = []
        let sourceHasMore = false
        let total = 0
        let knowsTotal = refused.length === 0
        for (const { source, answer } of answers) {
            if (!answer) continue
            const representation = source.declaration?.presentation?.representation
            answer.ids.forEach((id, at) => {
                found.push({
                    locator: { peer: source.peer, namespace: source.namespace, resource: source.resource, id },
                    source: { peer: source.peer, namespace: source.namespace, resource: source.resource, interfaces: source.interfaces },
                    value: answer.data[at],
                    type: source.row,
                    ...(representation ? { representation } : {})
                })
            })
            sourceHasMore ||= answer.hasMore === true || (answer.total !== undefined && answer.total > answer.ids.length)
            if (answer.total === undefined) knowsTotal = false
            else total += answer.total
        }

        if (params.sort) found.sort((left, right) => compareAggregate(left, right, params.sort!))
        const rows = found.slice(0, limit)
        const hasMore = sourceHasMore || found.length > rows.length
        const partial = refused.length > 0 || hasMore
        return {
            rows,
            refused,
            sources: selected.map(({ source }) => source),
            asked: queryable.filter(({ source }) => !source.synthetic).length,
            ...(knowsTotal ? { total } : {}),
            hasMore,
            partial
        }
    }

    /**
     * Open one aggregate row through the provider and identity it came from.
     *
     * Rich detail is `getOne`. A store whose page and detail row are identical may deliberately
     * omit that duplicate operation and offer `getMany`; one id through it is the same-shape
     * preview. This is decided from the declaration, never by trying one verb and treating a
     * refusal as capability discovery.
     */
    async getOne(locator: NetworkRowLocator): Promise<RpcGetOneResult> {
        const source = this.catalogue.resourcesUnder({
            kind: 'resource',
            peer: locator.peer,
            namespace: locator.namespace,
            resource: locator.resource
        })[0]
        if (!source) throw new Error(`network data: ${locator.peer}.${locator.namespace}.${locator.resource.join('.')} is not a resource`)
        if (source.synthetic?.kind === 'interfaces') {
            const row = this.interfaceEntries(source).find(([id]) => id === locator.id)
            return { ...(row ? { data: row[1] } : {}), epoch: 'network-interfaces', revision: 0 }
        }
        const method = source.verbs.includes('getOne') ? 'getOne' : source.verbs.includes('getMany') ? 'getMany' : undefined
        if (!method) throw new Error(`network data: ${locator.resource.join('.')} offers neither getOne nor getMany for a row preview`)
        const question: RpcQuestion = {
            target: locator.peer,
            namespace: locator.namespace,
            method,
            resource: locator.resource,
            params: method === 'getOne' ? { id: locator.id } : { ids: [locator.id] }
        }
        const answer = await this.ask(question)
        if (method === 'getOne') return answer as RpcGetOneResult
        const many = answer as RpcGetManyResult
        const at = many.ids.indexOf(locator.id)
        return {
            ...(at < 0 ? {} : { data: many.data[at] }),
            epoch: many.epoch,
            revision: many.revision,
            ...(many.stamp === undefined ? {} : { stamp: many.stamp }),
            ...(many.ms === undefined ? {} : { ms: many.ms }),
            ...(many.queryMs === undefined ? {} : { queryMs: many.queryMs }),
            ...(many.countMs === undefined ? {} : { countMs: many.countMs })
        }
    }

    private interfaceEntries(source: NetworkResource): readonly (readonly [string, unknown])[] {
        if (source.synthetic?.kind !== 'interfaces') return []
        return source.synthetic.namespaces.flatMap((namespace) =>
            (namespace.methods ?? []).map(
                (method): readonly [string, unknown] => [
                    JSON.stringify([namespace.name, method.name]),
                    {
                        name: method.name,
                        interface: namespace.name,
                        method: method.name,
                        ...(method.params
                            ? {
                                  parameters: method.params.map((type, at) => ({
                                      name: method.paramNames?.[at] ?? `arg${at}`,
                                      type
                                  }))
                              }
                            : {}),
                        ...(method.rest ? { rest: method.rest } : {}),
                        ...(method.returns ? { returns: method.returns } : {}),
                        ...(method.semantics ? { semantics: method.semantics } : {}),
                        ...(method.effect ? { effect: method.effect } : {}),
                        ...(method.sets ? { sets: method.sets } : {}),
                        ...(method.requiresAuthority ? { requiresAuthority: true } : {}),
                        ...(namespace.capabilities?.length ? { capabilities: namespace.capabilities } : {}),
                        kind: 'rpc.method'
                    }
                ]
            )
        ).concat(
            source.synthetic.transports.map(
                (transport, at): readonly [string, unknown] => [
                    JSON.stringify(['transport', transport.protocol, transport.role, transport.endpoint ?? '', transport.name, at]),
                    {
                        name: `${transport.protocol} ${transport.role}`,
                        interface: 'Transports',
                        transport: transport.protocol,
                        role: transport.role,
                        ...(transport.endpoint ? { endpoint: transport.endpoint } : {}),
                        kind: 'rpc.transport'
                    }
                ]
            )
        )
    }

    private interfaceList(source: NetworkResource, params: RpcGetListParams): RpcGetListResult {
        const entries = this.interfaceEntries(source).filter(([, value]) => {
            if (params.under === undefined) return true
            if (params.under === transportsBranchId) return (value as { kind?: string }).kind === 'rpc.transport'
            const interfaceName = interfaceFromBranchId(params.under)
            return interfaceName !== undefined && (value as { interface?: string }).interface === interfaceName
        })
        return { ...pageEntries(entries, params), epoch: 'network-interfaces', revision: 0 }
    }
}

/** Names used by structural filters before a provider is asked. */
export interface NetworkSourceFilter {
    readonly peer?: string
    readonly namespace?: string
    readonly interface?: string
    readonly resource?: readonly string[]
}

/** Kept beside the provider because these filters select providers, not rows within one. */
export const matchesNetworkSource = (source: NetworkResource, filter: NetworkSourceFilter): boolean =>
    (filter.peer === undefined || source.peer === filter.peer) &&
    (filter.namespace === undefined || source.namespace === filter.namespace) &&
    (filter.interface === undefined || source.interfaces.includes(filter.interface)) &&
    (filter.resource === undefined || (source.resource.length === filter.resource.length && source.resource.every((segment, at) => segment === filter.resource![at])))

// Re-exported aliases make the public surface say that the existing row predicates and ordering
// are the second half of a future network query, after the structural source filter above.
export type NetworkRowFilter = RpcFilter
export type NetworkRowSort = RpcSort
