import { randomUUID } from 'node:crypto'
import { RpcComponent, rpc, type RpcDataMethod, type RpcDataResource, type RpcGetChildrenParams, type RpcGetChildrenResult, type RpcResource } from '@source-repo/rpc'
import { resolveLink, type AspectLink, type AspectLocation, type AspectPlacements, type LinkRefusal } from './Link.js'
import type { AspectDescriptor, AspectRef, ObjectDetail, Occurrence } from './Model.js'

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

/** What a subclass answers. Everything else in this file follows from these. */
export interface AspectSource {
    /** The structures this provider offers. Read fresh, so one can appear as the source changes. */
    aspects(): readonly AspectDescriptor[]
    /**
     * What is directly under a node of one aspect. An absent parent asks for the roots.
     *
     * Returning a `total` lets a viewer page a wide branch; returning none says only that this page
     * is what there is, which is honest for a source that cannot count cheaply.
     */
    children(aspectId: string, parentOccurrenceId: string | undefined, page: { readonly from: number; readonly size: number }): { readonly occurrences: readonly Occurrence[]; readonly total?: number }
    /** Where an object appears in one aspect. Empty when that aspect does not place it. */
    placements(target: AspectRef, aspectId: string): readonly string[]
    /** Opening one object. `undefined` when this provider has nothing by that reference. */
    open(target: AspectRef): ObjectDetail | undefined
    /** The ancestor chain of an occurrence, root first. Optional: it only sharpens link resolution. */
    ancestorsOf?(occurrenceId: string, aspectId: string): readonly string[]
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
    abstract children(aspectId: string, parentOccurrenceId: string | undefined, page: { readonly from: number; readonly size: number }): { readonly occurrences: readonly Occurrence[]; readonly total?: number }
    abstract placements(target: AspectRef, aspectId: string): readonly string[]
    abstract open(target: AspectRef): ObjectDetail | undefined

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
    capability(): AspectCapability {
        return { protocol: 1, aspects: this.aspects().length, opensObjects: true, limits: { maxPageSize: this.maxPageSize } }
    }

    /** The structures on offer, so a viewer can let somebody choose one. */
    @rpc({ semantics: 'query', effect: 'observe' })
    aspectList(): readonly AspectDescriptor[] {
        return this.aspects()
    }

    /**
     * One object, opened.
     *
     * Refused by name rather than answered as empty: a reference that resolves to nothing is either
     * a link to something removed or a caller with the wrong provider, and both are worth saying.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    openObject(target: AspectRef): ObjectDetail {
        const object = this.open(target)
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
    follow(link: AspectLink, from?: AspectLocation): AspectLocation | LinkRefusal {
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
            verbs: ['getChildren' as const],
            presentation: { defaultColumns: ['title', 'kind'] },
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

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetChildrenParams): RpcGetChildrenResult {
        if (method !== 'getChildren') throw new Error(`an aspect answers getChildren, not ${method}`)
        const aspect = this.aspects().find((declared) => declared.id === resource[0])
        if (!aspect) throw new Error(`no aspect ${resource.join('.')}`)

        const size = Math.min(params.pagination?.pageSize ?? this.maxPageSize, this.maxPageSize)
        const from = (params.pagination?.page ?? 0) * size
        const branch = this.children(aspect.id, params.parentId, { from, size })

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
            ...(branch.total !== undefined ? { total: branch.total } : {}),
            epoch: this.incarnation,
            revision: this.structureRevision
        }
    }
}
