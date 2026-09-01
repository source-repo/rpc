import { randomUUID } from 'node:crypto'
import { RpcComponent, rpc, type RpcDataMethod, type RpcDataResource, type RpcGetChildrenParams, type RpcFilter, type RpcGetChildrenResult, type RpcGetListParams, type RpcResource } from '@source-repo/rpc'
import { resolveLink, type AspectLink, type AspectLocation, type AspectPlacements, type LinkRefusal } from './Link.js'
import type { AspectDescriptor, AspectRef, ObjectDetail, Occurrence } from './Model.js'

/** One branch: what is directly under a node, and how many there are when that is knowable. */
export interface Branch {
    readonly occurrences: readonly Occurrence[]
    readonly total?: number
    /**
     * Whether more follow, where counting them would cost more than the page did.
     *
     * The cheap half of a total, and the half a pager actually needs. A whole-branch answer usually
     * knows the count and says so; a subtree walk that stopped when the page filled knows only that
     * it stopped, and this is how it says that honestly instead of implying an end.
     */
    readonly hasMore?: boolean
    /**
     * The occurrence in this branch worth opening with it, when there is an obvious one.
     *
     * Passed through to the wire unchanged. A folder whose first business is its `README` is the
     * case; a structure with no such convention says nothing and nothing opens.
     */
    readonly defaultChild?: string
}

/**
 * A component that serves several structures over the same objects.
 *
 * What a provider author writes is the middle column: which aspects exist, what is under a node,
 * where an object appears, and how to open one. What they get without writing it is the whole wire
 * surface - each aspect published as a `shape: 'tree'` resource, branches answered a page at a
 * time, `hasChildren` filled in from the occurrences, and links resolved against the structure as
 * it is now.
 *
 * The division is the point. Serving a tree over `$data` correctly - the verb, the bounds, the
 * positional flags, the epoch and revision - is the same work every time and is easy to get subtly
 * wrong; deciding what belongs under a node is different for every source and cannot be shared.
 * A provider that had to do both would mostly be doing the first.
 *
 * ## What this is not
 *
 * It is not a store. Nothing is cached here, nothing is indexed, and no opinion is held about where
 * objects come from - a subclass may read a directory, hold a graph in memory or call another
 * service, and this file cannot tell.
 *
 * It is not a query engine either. There is no expression language reaching a provider from the
 * network: a caller names an aspect and a parent, and the provider's own code decides what that
 * means. That refusal is deliberate and is the difference between a contract and a database.
 */

/**
 * What a subclass answers. Everything else in this file follows from these.
 *
 * Everything that consults the source may return a promise, and that is not decoration. The first
 * provider read an index it held in memory and could answer at once; the second browses an OPC UA
 * server, where every question is a round trip and holding the answers would mean holding an
 * address space of two hundred thousand nodes to avoid asking about eight. A source that must ask
 * is the ordinary case for anything foreign, and a synchronous interface ruled out every one.
 *
 * **`aspects()` is the exception and stays synchronous**, because the library decides that rather
 * than this file: a component's resources are read at describe time and `describe()` does not wait.
 * The split turns out to be the right one anyway - a provider knows which structures it offers
 * without asking anybody, and only what is *inside* them requires a round trip.
 */
export interface AspectSource {
    /** The structures this provider offers. Read fresh, so one can appear as the source changes. */
    aspects(): readonly AspectDescriptor[]
    /**
     * What is directly under a node of one aspect. An absent parent asks for the roots.
     *
     * Returning a `total` lets a viewer page a wide branch; returning none says only that this page
     * is what there is, which is honest for a source that cannot count cheaply.
     */
    children(aspectId: string, parentOccurrenceId: string | undefined, page: { readonly from: number; readonly size: number }): Branch | Promise<Branch>
    /** Where an object appears in one aspect. Empty when that aspect does not place it. */
    placements(target: AspectRef, aspectId: string): readonly string[] | Promise<readonly string[]>
    /** Opening one object. `undefined` when this provider has nothing by that reference. */
    open(target: AspectRef): ObjectDetail | undefined | Promise<ObjectDetail | undefined>
    /** The ancestor chain of an occurrence, root first. Optional: it only sharpens link resolution. */
    ancestorsOf?(occurrenceId: string, aspectId: string): readonly string[] | Promise<readonly string[]>
}

/** What a viewer needs to know before it asks this provider anything. */
export interface AspectCapability {
    readonly protocol: 1
    readonly aspects: number
    /** Whether `open` returns content, or only summaries. */
    readonly opensObjects: boolean
    readonly limits: { readonly maxPageSize: number }
}

const DEFAULT_MAX_PAGE = 200

/**
 * The base class: an `AspectSource` served as an ordinary Source RPC component.
 *
 * A subclass supplies props and state as any component does, and implements `AspectSource`. It gets
 * `aspects`, `open` and `follow` as methods, and one tree resource per aspect.
 */
export abstract class AspectProvider<Props extends Record<string, unknown>, State extends Record<string, unknown>> extends RpcComponent<Props, State> implements AspectSource {
    abstract aspects(): readonly AspectDescriptor[]
    abstract children(aspectId: string, parentOccurrenceId: string | undefined, page: { readonly from: number; readonly size: number }): Branch | Promise<Branch>
    abstract placements(target: AspectRef, aspectId: string): readonly string[] | Promise<readonly string[]>
    abstract open(target: AspectRef): ObjectDetail | undefined | Promise<ObjectDetail | undefined>

    /**
     * Every leaf beneath a branch, at any depth, a page at a time.
     *
     * Optional, and a provider that cannot answer it cheaply should not: the resources it publishes
     * then declare `getChildren` alone and a viewer scopes by branch instead of by subtree. That is
     * a smaller screen, not a broken one.
     *
     * The reason it is here rather than assembled by whoever is asking: collecting the leaves under
     * a node *is* the walk `children` exists to avoid, and the only place with any idea what it
     * costs is the provider. A library over a folder tree already holds every document and answers
     * from memory. A browsing protocol walks until the page is full and stops, which is bounded by
     * the page rather than by the tree - and stops early on a budget besides, because a hierarchy
     * with ten thousand empty folders before its first leaf will spend a minute finding fifty.
     *
     * `total` is deliberately allowed to be absent even where a flat list would know it. Counting
     * what is under a node can cost the whole walk when the page cost a corner of it; `hasMore` is
     * the half a pager needs and the half that stays cheap.
     */
    leaves?(
        aspectId: string,
        under: string | undefined,
        page: { readonly from: number; readonly size: number; readonly filter?: RpcFilter }
    ): Branch | Promise<Branch>

    /** The largest page this provider will answer, whatever a caller asks for. */
    protected maxPageSize = DEFAULT_MAX_PAGE

    /**
     * Which incarnation this is, and how many times its structures have changed.
     *
     * The two answer different questions and a page carries both: the epoch changes when the
     * process does, so a page held from before a restart is not mistaken for a current one, and the
     * revision changes when the structure does. Neither is a timestamp and neither is a count of
     * anything - `@source-repo/markdown` tried the scan time and the document count, and its own
     * tests caught both: two changes inside a millisecond share a timestamp, and a change that
     * swaps one thing for another leaves a count exactly where it was.
     *
     * A provider whose structures never change never calls `structureChanged`, and its revision
     * stays at one - which is true rather than merely convenient.
     */
    private readonly incarnation = randomUUID()
    private structureRevision = 1

    /** Say that the structures have changed, so a caller holding an older page can tell. */
    protected structureChanged(): number {
        return (this.structureRevision += 1)
    }

    /**
     * What a viewer reads before asking anything, derived rather than declared.
     *
     * Counted from `aspects()` rather than kept as a number, because the two would eventually
     * disagree and the wrong one would be the one on the wire.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async capability(): Promise<AspectCapability> {
        return { protocol: 1, aspects: this.aspects().length, opensObjects: true, limits: { maxPageSize: this.maxPageSize } }
    }

    /** The structures on offer, so a viewer can let somebody choose one. */
    @rpc({ semantics: 'query', effect: 'observe' })
    async aspectList(): Promise<readonly AspectDescriptor[]> {
        return this.aspects()
    }

    /**
     * One object, opened.
     *
     * Refused by name rather than answered as empty: a reference that resolves to nothing is either
     * a link to something removed or a caller with the wrong provider, and both are worth saying.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async openObject(target: AspectRef): Promise<ObjectDetail> {
        const object = await this.open(target)
        if (!object) throw new Error(`no object ${target.id} in ${target.resource.join('.')}`)
        return object
    }

    /**
     * Follow a link from where the caller is, and answer where they end up.
     *
     * The resolution happens here rather than in the viewer, and that is not an accident of
     * layering: only the provider knows where an object appears, and a viewer that tried would have
     * to fetch the whole structure to find out - which is exactly the walk the tree verb exists to
     * avoid. What the viewer gets back says whether its context survived.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    follow(link: AspectLink, from?: AspectLocation): Promise<AspectLocation | LinkRefusal> {
        return resolveLink(link, from, this.structure())
    }

    /** The two questions `resolveLink` asks, bound to this provider. */
    private structure(): AspectPlacements {
        const source = this as AspectSource
        return {
            placements: (target, aspectId) => source.placements(target, aspectId),
            defaultAspectFor: () => source.aspects().find((aspect) => aspect.default)?.id ?? source.aspects()[0]?.id,
            ...(source.ancestorsOf ? { ancestorsOf: (occurrenceId: string, aspectId: string) => source.ancestorsOf!(occurrenceId, aspectId) } : {})
        }
    }

    /**
     * One tree resource per aspect, named by the aspect's id.
     *
     * The row is the occurrence rather than the object, and the two are different on purpose: what a
     * tree draws is a placement, and the reference it carries is what a click opens. A grouping node
     * carries no reference at all, which is how a viewer knows there is nothing to open.
     */
    dataResources(): readonly RpcDataResource[] {
        return this.aspects().map((aspect) => ({
            path: [aspect.id],
            label: aspect.label,
            shape: 'tree' as const,
            // `getList` only where this provider can answer for a subtree. The verb list is what a
            // viewer offers from, so declaring one that would refuse is worse than not having it.
            verbs: this.leaves ? (['getChildren', 'getList'] as const) : (['getChildren'] as const),
            presentation: { defaultColumns: aspect.defaultColumns ?? ['title', 'kind'] },
            row: {
                kind: 'object' as const,
                fields: {
                    occurrenceId: { type: { kind: 'string' as const } },
                    title: { type: { kind: 'string' as const } },
                    kind: { type: { kind: 'string' as const } },
                    relation: { type: { kind: 'string' as const }, optional: true },
                    id: { type: { kind: 'string' as const } }
                }
            }
        }))
    }

    async dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetChildrenParams & RpcGetListParams): Promise<RpcGetChildrenResult> {
        if (method !== 'getChildren' && method !== 'getList')
            throw new Error(`an aspect answers getChildren${this.leaves ? ' and getList' : ''}, not ${method}`)
        const aspect = this.aspects().find((declared) => declared.id === resource[0])
        if (!aspect) throw new Error(`no aspect ${resource.join('.')}`)

        const size = Math.min(params.pagination?.pageSize ?? this.maxPageSize, this.maxPageSize)
        const from = (params.pagination?.page ?? 0) * size
        // One branch, or every leaf beneath one. The second is what makes a tree filterable: the
        // scope stops being where you are and becomes which rows the question is about.
        const branch =
            method === 'getList'
                ? await this.leaves!(aspect.id, params.under, { from, size, ...(params.filter ? { filter: params.filter } : {}) })
                : await this.children(aspect.id, params.parentId, { from, size })

        return {
            // The occurrence id is the row id, because that is what a caller passes back as the
            // parent of the next branch. The object reference travels beside it rather than as it:
            // one object may be several rows here, and using the reference as the key would make
            // two placements of one document collide the moment they were both on screen.
            ids: branch.occurrences.map((occurrence) => occurrence.occurrenceId),
            data: branch.occurrences.map((occurrence) => ({
                occurrenceId: occurrence.occurrenceId,
                title: occurrence.title,
                kind: occurrence.kind,
                ...(occurrence.relation ? { relation: occurrence.relation } : {}),
                ...(occurrence.ref ? { id: occurrence.ref.id, ref: occurrence.ref } : {}),
                ...(occurrence.fields ?? {})
            })),
            hasChildren: branch.occurrences.map((occurrence) => occurrence.hasChildren),
            // Only when some occurrence says so: a provider that never sets it publishes nothing,
            // and a viewer falls back to `hasChildren` exactly as it did before.
            ...(branch.occurrences.some((occurrence) => occurrence.grouping !== undefined)
                ? { grouping: branch.occurrences.map((occurrence) => occurrence.grouping ?? occurrence.hasChildren) }
                : {}),
            ...(branch.total !== undefined ? { total: branch.total } : {}),
            ...(branch.hasMore !== undefined ? { hasMore: branch.hasMore } : {}),
            ...(branch.defaultChild !== undefined ? { defaultChild: branch.defaultChild } : {}),
            epoch: this.incarnation,
            revision: this.structureRevision
        }
    }
}
