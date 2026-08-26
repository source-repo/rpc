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
    type RpcGetManyResult,
    type RpcResourceStamps
} from '@source-repo/rpc'
import { sql, type Kysely, type SqlBool } from 'kysely'
import { readCatalogue, resourceOf, wireRow, type Catalogue, type CatalogueOptions, type TableInfo, type UnservedTable } from './Catalogue.js'
import { flavours, type RelationalDatabase, type SqlFlavour } from './Flavour.js'
import { idValueFor, orderFor, RelationalRefusal, whereFor } from './Filter.js'

/**
 * Source Relational: an existing SQL database, served to a Source RPC network as DataProvider
 * resources.
 *
 * The component owns no data. It holds a connection to a database somebody else owns and answers
 * questions about it - which is the whole reason this can be an open package rather than a system
 * of record: delete this node and nothing is lost but the ability to ask.
 *
 * What it adds over a bare connection is the three things a peer on a bus needs and a driver does
 * not have: **the tables as a published catalogue**, so a console can draw a scope tree for a
 * database it has never heard of; **one query language that means the same thing on every backend**,
 * pinned to the library's in-memory implementation rather than to whichever dialect is underneath;
 * and **a refusal where a translation would have had to guess**, because the alternative to
 * refusing is a filter that quietly matches the wrong rows.
 */

export interface RelationalOptions {
    /** A Kysely instance, already configured with whichever dialect and credentials this node uses. */
    readonly db: Kysely<RelationalDatabase>
    /**
     * Which SQL this is. Named rather than sniffed: the dialect is already a decision the caller
     * made when they built the Kysely instance, and guessing it from the connection would be a
     * second source of truth that can disagree with the first.
     */
    readonly flavour: SqlFlavour['name'] | SqlFlavour
    readonly catalogue?: CatalogueOptions
    /**
     * Whether to answer `total` at all. On by default, because a count is what a pager needs to say
     * "3 of 47" and most tables can afford one.
     *
     * Turn it off for the table where it cannot. `LIMIT 50` is answered from an index and
     * `COUNT(*)` over the same predicate walks it, which on a large table is routinely most of the
     * request - and the console reports the two apart precisely so somebody can see that and act on
     * it. With this off, `total` is **absent** rather than zero, and `hasMore` carries the pager on
     * its own.
     */
    readonly count?: boolean
    /**
     * Where a resource's stamp is kept, **shared with this node's write service**.
     *
     * Without it every answer carries no stamp, which is the correct default: a stamp names the
     * state of a resource as far as writes this node served are concerned, and a node with no write
     * service has served none. Handing it to only one of the two is safe rather than subtly wrong -
     * see `RpcResourceStamps`, where a stamp exists only for a resource a *writer* claimed, so a
     * read service given a registry nobody writes into publishes nothing rather than publishing a
     * number that never moves.
     */
    readonly stamps?: RpcResourceStamps
}

export interface RelationalProps {
    /** Which SQL, so a viewer can explain a divergence it is looking at. Never a connection string. */
    flavour: string
    resources: number
    /**
     * Tables that exist and are not served, with the reason.
     *
     * Carried in props rather than logged, because a table missing from a scope tree is otherwise
     * indistinguishable from a table that does not exist - and "why can I not see `orders`" is the
     * first question anybody asks. A silent truncation is the failure mode; this is the tripwire.
     */
    unserved: readonly UnservedTable[]
    [key: string]: unknown
}

export interface RelationalState {
    requests: number
    /** Requests refused for naming something that is not there, or comparing things that do not compare. */
    refusals: number
    /** Requests that reached the database and failed there. */
    failures: number
    lastRequestMs?: number
    [key: string]: unknown
}

export class RelationalService extends RpcComponent<RelationalProps, RelationalState> implements RpcDataResources {
    private readonly db: Kysely<RelationalDatabase>
    private readonly flavour: SqlFlavour
    private readonly catalogueOptions: CatalogueOptions
    private readonly counts: boolean
    private readonly stamps?: RpcResourceStamps
    private catalogue: Catalogue = { tables: [], unserved: [], byName: new Map() }
    private resources: readonly RpcDataResource[] = []
    /** The catalogue read in flight, so a slower one cannot land on top of a newer one. */
    private reading: Promise<unknown> = Promise.resolve()

    constructor(options: RelationalOptions) {
        const flavour = typeof options.flavour === 'string' ? flavours[options.flavour] : options.flavour
        super({ flavour: flavour.name, resources: 0, unserved: [] }, { requests: 0, refusals: 0, failures: 0 })
        this.db = options.db
        this.flavour = flavour
        this.catalogueOptions = options.catalogue ?? {}
        this.counts = options.count ?? true
        this.stamps = options.stamps
    }

    /**
     * Re-read what the database holds.
     *
     * An `@rpc` method as well as a startup step, because a database's shape is data and changes
     * without this process being told: a migration adds a table, and until somebody asks, the
     * catalogue here describes yesterday. Exposing it means an operator can ask rather than restart
     * a node that is otherwise serving perfectly well.
     */
    @rpc({ semantics: 'idempotent-command' })
    async refresh(): Promise<{ resources: number; unserved: readonly UnservedTable[] }> {
        return this.serialised(async () => {
            this.catalogue = await readCatalogue(this.db, this.flavour, this.catalogueOptions)
            this.resources = this.catalogue.tables.map(resourceOf)
            componentHost(this).replaceProps({
                flavour: this.flavour.name,
                resources: this.resources.length,
                unserved: this.catalogue.unserved
            })
            return { resources: this.resources.length, unserved: this.catalogue.unserved }
        })
    }

    /**
     * One at a time, and that is not tidiness.
     *
     * `refresh()` is an `@rpc` method on a `parallel` service, so two callers can be inside it at
     * once - and `this.catalogue = await readCatalogue(...)` is last-**finished** wins rather than
     * last-started. A read that began before a migration can land after one that began *after* it,
     * installing a catalogue missing exactly the thing somebody refreshed to see. Not hypothetical:
     * it is what made a suite here flake, where concurrent tests each add a collection, refresh, and
     * drop it, and one of them would find the collection it had just added absent.
     *
     * Serialising costs a queued caller the time of the read in front of it and gives them the
     * answer they asked for. The tail is caught so one failed read does not poison every refresh
     * after it - the caller whose read failed still sees its own rejection.
     */
    private serialised<T>(read: () => Promise<T>): Promise<T> {
        const mine = this.reading.then(read, read)
        this.reading = mine.catch(() => undefined)
        return mine
    }

    /** What is served and what is not, in one answer, for a console or a script that is diagnosing. */
    @rpc({ semantics: 'query' })
    async tables(): Promise<{ served: readonly string[]; unserved: readonly UnservedTable[] }> {
        return { served: this.catalogue.tables.map((table) => table.name), unserved: this.catalogue.unserved }
    }

    /**
     * Read at describe time, so a viewer sees whatever the last refresh found.
     *
     * Synchronous by the interface's design, which is why the catalogue is cached rather than read
     * here: `describe()` is answered on a hot path and a round trip to `information_schema` inside
     * it would put a database query behind every peer that asks what this node is.
     */
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
            const table = this.tableFor(resource)
            const answer =
                method === 'getMany'
                    ? await this.getMany(table, params as RpcGetManyParams)
                    : await this.getList(table, params as RpcGetListParams, method === 'getManyReference' ? (params as RpcGetManyReferenceParams) : undefined)
            this.setState({ lastRequestMs: Date.now() - began })
            return answer
        } catch (failure) {
            this.setState((previous) =>
                failure instanceof RelationalRefusal ? { refusals: previous.refusals + 1 } : { failures: previous.failures + 1 }
            )
            throw failure
        }
    }

    private tableFor(resource: readonly string[]): TableInfo {
        // A single segment, because a table is not nested. A longer path is a caller addressing this
        // node as though it were a component's own state, which it is not.
        if (resource.length !== 1) throw new RelationalRefusal(`${resource.join('.')} is not a table - a resource here is one name`)
        const table = this.catalogue.byName.get(resource[0])
        if (!table) throw new RelationalRefusal(`${resource[0]} is not a table this node serves`)
        return table
    }

    /**
     * A page, and the count, timed separately.
     *
     * They are two questions over a table and one over a record in memory, which is the difference
     * `queryMs` and `countMs` exist to report: `LIMIT 50` is answered from an index and `COUNT(*)`
     * over the same predicate walks it, routinely most of the time spent. Reporting them apart is
     * what lets somebody decide between adding an index and asking for the count less often -
     * neither of which can be chosen from one number.
     */
    private async getList(table: TableInfo, params: RpcGetListParams, reference?: RpcGetManyReferenceParams): Promise<RpcGetListResult> {
        const conditions: RpcFilter[] = []
        if (reference) conditions.push({ field: reference.target, op: 'eq', operand: reference.id })
        if (params.filter) conditions.push(params.filter)
        const where = conditions.length ? whereFor(conditions.length === 1 ? conditions[0] : { all: conditions }, table, this.flavour) : undefined

        let total: number | undefined
        let countMs: number | undefined
        if (this.counts) {
            const countBegan = Date.now()
            let counted = this.db.selectFrom(table.name).select((eb) => eb.fn.countAll().as('found'))
            if (where) counted = counted.where(where)
            const count = await counted.executeTakeFirst()
            // `count(*)` comes back as a bigint from some drivers and a string from others; both are
            // exact and neither is a number, so the conversion happens once, here.
            total = Number(count?.found ?? 0)
            countMs = Date.now() - countBegan
        }

        const queryBegan = Date.now()
        let query = this.db.selectFrom(table.name).selectAll()
        if (where) query = query.where(where)
        // Built by the flavour rather than here, because where a missing value belongs in an order
        // is one of the two things the three databases genuinely disagree about - and the answer is
        // the in-memory implementation's, not whichever engine happens to be underneath.
        for (const order of orderFor(params.sort, table)) for (const term of this.flavour.orderTerms(order.column, order.direction)) query = query.orderBy(term)
        const pageSize = params.pagination?.pageSize
        if (pageSize !== undefined) {
            // One row more than was asked for, which is the whole trick behind `hasMore`: whether
            // anything follows this page costs an extra row off an index the query is already
            // walking, where `COUNT(*)` over the same predicate walks all of it. The extra row is
            // discarded below and never crosses the wire.
            query = query.limit(pageSize + 1)
            // Zero-based, so `page * pageSize` needs no adjustment - and a page without a pageSize
            // was refused by the library before this was reached, so an offset never appears without
            // the limit that makes it legal SQL.
            if (params.pagination?.page) query = query.offset(params.pagination.page * pageSize)
        }
        const fetched = await query.execute()
        const queryMs = Date.now() - queryBegan
        // With no pageSize the whole matched set was asked for, so nothing follows it by definition.
        const hasMore = pageSize !== undefined && fetched.length > pageSize
        const rows = hasMore ? fetched.slice(0, pageSize) : fetched

        return {
            data: rows.map((row) => wireRow(table, row)),
            ids: rows.map((row) => String(row[table.id!.name])),
            // Both where both are known, because a caller that understands only one of them is then
            // right either way - and `total` simply absent where it was not asked for, never zero.
            ...(total !== undefined ? { total } : {}),
            hasMore,
            queryMs,
            ...(countMs !== undefined ? { countMs } : {}),
            ...this.stamp(table)
        }
    }

    /**
     * Rows by id, answered in the order they were asked for.
     *
     * Positional, because that is what the contract says and what a page of reference fields needs:
     * fifty rows each naming a customer is one call, and the caller matches answers to questions by
     * position. Ids that name no row are simply absent from both arrays, which is how a foreign key
     * pointing at a deleted row reports itself.
     */
    private async getMany(table: TableInfo, params: RpcGetManyParams): Promise<RpcGetManyResult> {
        const id = table.id!
        const wanted = params.ids.map((given) => idValueFor(id, given))
        const rows = await this.db
            .selectFrom(table.name)
            .selectAll()
            .where(sql<SqlBool>`${sql.id(id.name)} in (${sql.join(wanted)})`)
            .execute()

        const found = new Map(rows.map((row) => [String(row[id.name]), row]))
        const ids = params.ids.filter((given) => found.has(given))
        return {
            ids,
            data: ids.map((given) => wireRow(table, found.get(given)!)),
            ...this.stamp(table)
        }
    }

    /**
     * Where the answer came from, taken from this component's own snapshot.
     *
     * Worth reading for what the epoch and revision do *not* say: an epoch here means this peer
     * restarted, not that the data changed, and the revision beside it moves on **reads** - every
     * request bumps `state.requests`. A table being written to underneath a pager renumbers rows
     * between one page and the next, and neither number will report that; offset paging has that
     * property on every backend, and saying so plainly is better than a number that looks like it
     * covers it.
     *
     * `stamp` is the one that speaks about the data, and only about what this node did to it.
     */
    private stamp(table: TableInfo): { epoch: string; revision: number; stamp?: string } {
        const snapshot = componentSnapshot(this)
        // And the part that does say the data changed, where this node is in a position to know.
        // Absent unless a writer on this node claimed the table, because a stamp that does not move
        // when the table moves is worse than none.
        const stamp = this.stamps?.of([table.name])
        return { epoch: snapshot.epoch, revision: snapshot.revision, ...(stamp !== undefined ? { stamp } : {}) }
    }
}

/**
 * Serve a database, catalogue read before anybody can ask.
 *
 * Asynchronous where the queue's equivalent is synchronous, and that difference is the shape of the
 * problem rather than an inconsistency: a work queue knows its own resource when it is constructed,
 * and this one has to go and look. Exposing first and introspecting after would publish a peer that
 * briefly claims to serve nothing, which a console would cache.
 *
 * `parallel`, because a slow query must not hold the node against every other caller - the same
 * reason the queue runs parallel for its long poll.
 */
export const exposeRelational = async (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    name: string,
    options: RelationalOptions
): Promise<RelationalService> => {
    const service = new RelationalService(options)
    await service.refresh()
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}
