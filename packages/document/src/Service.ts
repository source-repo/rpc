import {
    componentHost,
    componentSnapshot,
    rpc,
    RpcComponent,
    type ExposeOptions,
    type RpcDataMethod,
    type RpcDataResource,
    type RpcDataResources,
    type RpcFilter,
    type RpcGetListParams,
    type RpcGetListResult,
    type RpcGetManyParams,
    type RpcGetManyReferenceParams,
    type RpcGetManyResult
} from '@source-repo/rpc'
import type { Db, Document, Filter } from 'mongodb'
import { idText, idValue, readCatalogue, resourceOf, wireDocument, type CollectionInfo, type DocumentCatalogue, type DocumentCatalogueOptions } from './Catalogue.js'
import { ABSENT_FIELD, BINARY, DocumentRefusal, queryFor, sortFor } from './Filter.js'

/**
 * Source Document: an existing MongoDB database, served to a Source RPC network as DataProvider
 * resources.
 *
 * The same shape as Source Relational and for the same reasons - the component owns no data, serves
 * reads only, and pins its semantics to the library's in-memory implementation rather than to
 * whatever the store does by default. What differs is entirely in what a document store can and
 * cannot say about itself, and each difference is declared rather than smoothed over: there is no
 * schema to whitelist a field against, a row shape may be a sample rather than a statement, and
 * where an order puts a missing value has to be computed rather than asked for.
 */

export interface DocumentOptions {
    readonly db: Db
    readonly catalogue?: DocumentCatalogueOptions
    /**
     * Whether to answer `total` at all. On by default.
     *
     * `countDocuments` walks the predicate, which on a large collection is most of the request -
     * exactly the trade the SQL node makes, and `queryMs`/`countMs` report the two apart so it can
     * be seen. With this off, `total` is **absent** rather than zero and `hasMore` carries the pager.
     */
    readonly count?: boolean
}

export interface DocumentProps {
    resources: number
    /**
     * Where each collection's row shape came from, and how many documents were read to get it.
     *
     * Published because a sampled shape is a guess and a viewer drawing columns from one should be
     * able to say so. A validator-derived shape is a declaration the server enforces; a sampled one
     * is twenty documents' worth of evidence about a collection that may hold a million.
     */
    shapes: readonly { name: string; from: string; sampled: number; id: string }[]
    [key: string]: unknown
}

export interface DocumentState {
    requests: number
    refusals: number
    failures: number
    lastRequestMs?: number
    [key: string]: unknown
}

export class DocumentService extends RpcComponent<DocumentProps, DocumentState> implements RpcDataResources {
    private readonly db: Db
    private readonly catalogueOptions: DocumentCatalogueOptions
    private readonly counts: boolean
    private catalogue: DocumentCatalogue = { collections: [], byName: new Map() }
    private resources: readonly RpcDataResource[] = []

    constructor(options: DocumentOptions) {
        super({ resources: 0, shapes: [] }, { requests: 0, refusals: 0, failures: 0 })
        this.db = options.db
        this.catalogueOptions = options.catalogue ?? {}
        this.counts = options.count ?? true
    }

    /**
     * Re-read what the database holds.
     *
     * More load-bearing here than over SQL: a collection's shape is not declared anywhere, so it
     * changes as its documents do, and the sample this node drew is only ever evidence about the
     * moment it was drawn.
     */
    @rpc({ semantics: 'idempotent-command' })
    async refresh(): Promise<{ resources: number; shapes: DocumentProps['shapes'] }> {
        this.catalogue = await readCatalogue(this.db, this.catalogueOptions)
        this.resources = this.catalogue.collections.map(resourceOf)
        const shapes = this.catalogue.collections.map((collection) => ({
            name: collection.name,
            from: collection.shape,
            sampled: collection.sampled,
            id: collection.idKind
        }))
        componentHost(this).replaceProps({ resources: this.resources.length, shapes })
        return { resources: this.resources.length, shapes }
    }

    /** What is served, and where each shape came from - for a console or a script that is diagnosing. */
    @rpc({ semantics: 'query' })
    async collections(): Promise<DocumentProps['shapes']> {
        return this.props.shapes
    }

    dataResources(): readonly RpcDataResource[] {
        return this.resources
    }

    async dataRequest(
        method: RpcDataMethod,
        resource: readonly string[],
        params: RpcGetListParams | RpcGetManyParams | RpcGetManyReferenceParams
    ): Promise<RpcGetListResult | RpcGetManyResult> {
        this.setState((previous) => ({ requests: previous.requests + 1 }))
        const began = Date.now()
        try {
            const collection = this.collectionFor(resource)
            const answer =
                method === 'getMany'
                    ? await this.getMany(collection, params as RpcGetManyParams)
                    : await this.getList(collection, params as RpcGetListParams, method === 'getManyReference' ? (params as RpcGetManyReferenceParams) : undefined)
            this.setState({ lastRequestMs: Date.now() - began })
            return answer
        } catch (failure) {
            this.setState((previous) => (failure instanceof DocumentRefusal ? { refusals: previous.refusals + 1 } : { failures: previous.failures + 1 }))
            throw failure
        }
    }

    private collectionFor(resource: readonly string[]): CollectionInfo {
        if (resource.length !== 1) throw new DocumentRefusal(`${resource.join('.')} is not a collection - a resource here is one name`)
        const collection = this.catalogue.byName.get(resource[0])
        if (!collection) throw new DocumentRefusal(`${resource[0]} is not a collection this node serves`)
        return collection
    }

    /**
     * A page, and the count, timed apart.
     *
     * Served by an aggregation rather than a `find`, for one reason: **where a missing value belongs
     * in the order**. MongoDB sorts missing and null before everything, and the in-memory rule is
     * that an absent value sorts after everything ascending - missing is the greatest value. There
     * is no `NULLS LAST` to ask for, so the nullness is computed into a field and ordered ahead of
     * the real one, which is the same trick MySQL needs for the same reason.
     */
    private async getList(collection: CollectionInfo, params: RpcGetListParams, reference?: RpcGetManyReferenceParams): Promise<RpcGetListResult> {
        const conditions: RpcFilter[] = []
        if (reference) conditions.push({ field: reference.target, op: 'eq', operand: reference.id })
        if (params.filter) conditions.push(params.filter)
        const query = conditions.length ? queryFor(conditions.length === 1 ? conditions[0] : { all: conditions }) : {}
        const source = this.db.collection(collection.name)

        let total: number | undefined
        let countMs: number | undefined
        if (this.counts) {
            const countBegan = Date.now()
            total = await source.countDocuments(query, { collation: BINARY })
            countMs = Date.now() - countBegan
        }

        const order = sortFor(params.sort)
        const sorted = order.filter(({ field }) => field !== '_id')
        const stages: Document[] = [{ $match: query }]
        // One computed term per sorted field, holding 1 where the document has no value there. Both
        // missing and null count as absent, which is the only reading that agrees with SQL, where
        // the two are the same thing and there is nothing else for a NULL to mean.
        for (const [at, { field }] of sorted.entries())
            stages.push({ $addFields: { [`${ABSENT_FIELD}${at}`]: { $cond: [{ $in: [{ $type: `$${field}` }, ['missing', 'null']] }, 1, 0] } } })
        const sort: Document = {}
        for (const [at, { field, direction }] of sorted.entries()) {
            sort[`${ABSENT_FIELD}${at}`] = direction
            sort[field] = direction
        }
        // Always ending at the key, so the order is total and a page cannot show one document twice.
        sort._id = order.find(({ field }) => field === '_id')?.direction ?? 1
        stages.push({ $sort: sort })

        const pageSize = params.pagination?.pageSize
        if (pageSize !== undefined) {
            if (params.pagination?.page) stages.push({ $skip: params.pagination.page * pageSize })
            // One more than asked for, which is what makes `hasMore` cost a document rather than a
            // second walk of the predicate. Discarded below and never sent.
            stages.push({ $limit: pageSize + 1 })
        }
        if (sorted.length) stages.push({ $unset: sorted.map((_, at) => `${ABSENT_FIELD}${at}`) })

        const queryBegan = Date.now()
        const fetched = await source.aggregate(stages, { collation: BINARY }).toArray()
        const queryMs = Date.now() - queryBegan

        const hasMore = pageSize !== undefined && fetched.length > pageSize
        const documents = hasMore ? fetched.slice(0, pageSize) : fetched

        return {
            data: documents.map((document) => wireDocument(document) as Record<string, unknown>),
            ids: documents.map((document) => idText(document._id)),
            ...(total !== undefined ? { total } : {}),
            hasMore,
            queryMs,
            ...(countMs !== undefined ? { countMs } : {}),
            ...this.stamp()
        }
    }

    private async getMany(collection: CollectionInfo, params: RpcGetManyParams): Promise<RpcGetManyResult> {
        const wanted = params.ids.map((given) => idValue(collection, given))
        const documents = await this.db
            .collection(collection.name)
            .find({ _id: { $in: wanted } } as Filter<Document>, { collation: BINARY })
            .toArray()

        const found = new Map(documents.map((document) => [idText(document._id), document]))
        const ids = params.ids.filter((given) => found.has(given))
        return {
            ids,
            data: ids.map((given) => wireDocument(found.get(given)!) as Record<string, unknown>),
            ...this.stamp()
        }
    }

    private stamp(): { epoch: string; revision: number } {
        const snapshot = componentSnapshot(this)
        return { epoch: snapshot.epoch, revision: snapshot.revision }
    }
}

/**
 * Serve a database, catalogue read before anybody can ask.
 *
 * `parallel`, because a slow query must not hold the node against every other caller.
 */
export const exposeDocument = async (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    name: string,
    options: DocumentOptions
): Promise<DocumentService> => {
    const service = new DocumentService(options)
    await service.refresh()
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}
