import {
    componentHost,
    rowStamp,
    rpc,
    RpcComponent,
    type ExposeOptions,
    type RpcRefusedWrite,
    type RpcRowRead,
    type RpcWriteOutcome,
    type RpcWritePermissions,
    type RpcWriteVerb,
    type RpcWritableResource
} from '@source-repo/rpc'
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely'
import { readCatalogue, typeOfColumn, wireRow, type Catalogue, type CatalogueOptions, type TableInfo } from './Catalogue.js'
import { idValueFor, RelationalRefusal } from './Filter.js'
import { flavours, type RelationalDatabase, type SqlFlavour } from './Flavour.js'
import { patchValues, readWritePermissions, resolveWrites, stampFields, writeFor, type ResolvedWrite, type ResolvedWrites } from './Writes.js'

/**
 * The write half of Source Relational: rows created, changed and removed in a database somebody
 * else owns.
 *
 * **A separate class in a separate namespace, and that is the design rather than tidiness.** It is
 * the split `DockerService`/`DockerControl` already makes, for the reasons that file gives: two
 * namespaces are two `authorize()` surfaces, so an operator can grant reading to everyone and
 * writing to nobody; and a subclass would have made "may call the database" one permission while
 * quietly making the read-only class's promise a lie by inheritance - code holding a
 * `RelationalService` could be holding a writable one. It also has its own subpath export, so
 * importing it is a visible line in a diff rather than an option somebody set.
 *
 * **The rule the whole repository states four times is intact.** A value is still never written over
 * this bus; a method is still called. Everything here is an ordinary `@rpc` method with declared
 * semantics and a declared effect, so the deadline, the execution queue, the owner fence,
 * `authorize()` with the table and the patch visible in `params`, the AI grants ladder and the
 * idempotency store all apply exactly as they do to any other command. There is no `$write` verb
 * beside `$data`, and there is not going to be: a dispatch-level write would sit outside every one
 * of those gates unless each were re-invoked by hand, which is a list somebody has to keep complete.
 *
 * **Closed by default, and composing it in is what says so.** With no `writes` document nothing is
 * writable, every call is refused, and `elevation()` announces nothing - so a node stood up by
 * accident can do nothing at all. The allow-list is data rather than a predicate for the reason the
 * AI grants document is data: a console can render data and cannot render a callback, and a reviewer
 * can diff a file and cannot diff a decision made inside somebody's closure.
 *
 * **Every change carries a precondition.** `update` and `delete` take the stamp the row was read
 * under and refuse when it no longer matches - the same mandatory compare-and-set the topology
 * layer's `expectedVersion` is, and for the same reason: there is no blind write, and a retry after
 * an uncertain outcome fails the check instead of applying twice. That is not a convenience a caller
 * may skip; the parameter is required, and the only way to get one is to have read the row.
 */

export interface RelationalWriteOptions {
    /** A Kysely instance, already configured with whichever dialect and credentials this node uses. */
    readonly db: Kysely<RelationalDatabase>
    /** Which SQL this is - named rather than sniffed, exactly as the read service names it. */
    readonly flavour: SqlFlavour['name'] | SqlFlavour
    /**
     * Which tables accept which verbs, and which of their columns may be written. Absent means
     * nothing is writable, which is what a node with no decision behind it should be.
     */
    readonly writes?: RpcWritePermissions
    /**
     * How much of the database to look at. The same options the read service takes, and worth
     * narrowing for the same reason - though note this node needs the catalogue only to check the
     * rules against it, so a `tables` predicate that hides a table listed in `writes` makes that
     * rule refused rather than merely unserved, and says so in `props.refused`.
     */
    readonly catalogue?: CatalogueOptions
}

export interface RelationalWriteProps {
    flavour: string
    /** How many tables this node can actually write, after the rules were checked against the database. */
    writable: number
    /**
     * Rules that name something the database does not have, with the reason.
     *
     * The tripwire, and the reason it is in props rather than in a log. A misspelled table produces
     * a node that refuses every edit to it, which reads exactly like a deliberate policy - and there
     * is nothing else on any screen that would say the policy was never loaded.
     */
    refused: readonly RpcRefusedWrite[]
    /**
     * How this node holds a row while it checks a precondition, so somebody diagnosing a lost update
     * can see which mechanism was in play rather than having to know the engine's default isolation.
     */
    locking: SqlFlavour['rowLock']
    [key: string]: unknown
}

export interface RelationalWriteState {
    created: number
    updated: number
    deleted: number
    /**
     * Writes refused because the row had changed since it was read.
     *
     * First-class rather than folded into refusals, because it is the one counter that measures the
     * plant rather than the callers: a number that climbs means two things are editing the same rows,
     * which is a fact about how the site works and is invisible from anywhere else.
     */
    conflicts: number
    /** Writes against a row that was not there - a reference somebody held after it was removed. */
    missing: number
    /** Calls refused for naming something not writable, or a value a column cannot hold. */
    refusals: number
    /** Calls that reached the database and failed there. */
    failures: number
    lastWriteMs?: number
    [key: string]: unknown
}

export class RelationalWriteService extends RpcComponent<RelationalWriteProps, RelationalWriteState> {
    private readonly db: Kysely<RelationalDatabase>
    private readonly flavour: SqlFlavour
    private readonly catalogueOptions: CatalogueOptions
    private readonly permissions?: RpcWritePermissions
    private catalogue: Catalogue = { tables: [], unserved: [], byName: new Map() }
    private writes: ResolvedWrites = { writable: new Map(), refused: [] }

    constructor(options: RelationalWriteOptions) {
        const flavour = typeof options.flavour === 'string' ? flavours[options.flavour] : options.flavour
        super(
            { flavour: flavour.name, writable: 0, refused: [], locking: flavour.rowLock },
            { created: 0, updated: 0, deleted: 0, conflicts: 0, missing: 0, refusals: 0, failures: 0 }
        )
        this.db = options.db
        this.flavour = flavour
        this.catalogueOptions = options.catalogue ?? {}
        // Checked before a connection is opened, so a malformed document refuses the node rather
        // than being read as granting nothing - the judgement `validateAiGrants` already makes about
        // a security artifact, and this is one.
        this.permissions = readWritePermissions(options.writes)
    }

    /**
     * Composing this in with a usable document is what makes a host able to change somebody else's
     * database, so composing it in is what announces it. Nothing to remember, which matters because
     * forgetting is the failure this catches.
     */
    elevation() {
        if (!this.writes.writable.size) return undefined
        const named = [...this.writes.writable.entries()].map(([table, resolved]) => `${table} (${[...resolved.verbs].sort().join('/')})`)
        return { capability: 'relational.write', reason: `may write ${named.join(', ')}` }
    }

    /**
     * Re-read the database's shape and check the rules against it.
     *
     * A `program` effect rather than an `operate` one, and the difference is real: this decides what
     * the node *is able to write* for every call after it, so it is the one method here whose blast
     * radius is not one row. An AI principal granted `ai.tool.write` may edit rows all day and still
     * not re-resolve the permission document.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'program' })
    async refresh(): Promise<{ writable: number; refused: readonly RpcRefusedWrite[] }> {
        this.catalogue = await readCatalogue(this.db, this.flavour, this.catalogueOptions)
        this.writes = resolveWrites(this.catalogue, this.permissions)
        componentHost(this).replaceProps({
            flavour: this.flavour.name,
            writable: this.writes.writable.size,
            refused: this.writes.refused,
            locking: this.flavour.rowLock
        })
        return { writable: this.writes.writable.size, refused: this.writes.refused }
    }

    /**
     * What this node is permitted to write, so a caller finds out before being refused.
     *
     * `DockerCreate.allowed()`, one package over. A console or a model discovering its permissions by
     * trying things is one generating refusals for an audit log to explain, and the list is the whole
     * answer to "can I change this" - which is often no, because a table nobody allow-listed is not
     * here at all.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async writable(): Promise<readonly RpcWritableResource[]> {
        return [...this.writes.writable.entries()].map(([resource, resolved]) => ({
            resource,
            verbs: [...resolved.verbs].sort(),
            columns: resolved.columns.map((column) => column.name),
            // Only the writable columns, because this is what `create` accepts rather than what the
            // table holds - a viewer drawing a form from the full row shape would offer fields the
            // next call refuses. The read side publishes the whole row and is the place to get it.
            row: {
                kind: 'object' as const,
                fields: Object.fromEntries(
                    resolved.columns.map((column) => [
                        column.name,
                        // Optional where the store can fill it in itself, which is what makes a
                        // generated key and a defaulted column absent from a form rather than blank
                        // in one.
                        { type: typeOfColumn(column), optional: column.nullable || column.hasDefault || column.generated }
                    ])
                )
            }
        }))
    }

    /**
     * One row, and the stamp that names the state it was read in.
     *
     * This is the `getOne` the read side declines to serve, and it is not the same verb. There, the
     * argument holds exactly: a caller wanting one row asks `getMany` for one id, and a verb that
     * exists only to be a worse version of another is not worth the wire. Here it answers something
     * `getMany` does not carry at all - the precondition a change is made under - and since the only
     * way to hold a stamp is to have read the row, this is what makes compare-and-set possible
     * rather than a parameter callers invent.
     *
     * A read, so it is `observe`: an AI principal that may watch a plant may take a stamp, and is no
     * closer to being able to use one.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async getOne(table: string, id: string): Promise<RpcRowRead> {
        return this.guard(async () => {
            // Any verb: a stamp for a table nobody may write is of no use to anybody, and a table
            // that is not in the document at all should not be readable through the write namespace
            // when the read one exists for that.
            const resolved = this.anyVerb(table)
            const row = await this.rowById(this.db, resolved, id)
            if (!row) return { status: 'missing' } as const
            return { status: 'ok' as const, row: wireRow(resolved.table, row), stamp: await this.stampOf(resolved, id, row) }
        })
    }

    /**
     * Insert a row and answer what it is called.
     *
     * `non-repeatable-command`, which is the honest classification and the useful one: a repeat
     * inserts a second row, so the library consults the idempotency store when the host has one and
     * a redelivered frame is answered from the record rather than run again. Without a store,
     * execution is at least once here as it is everywhere else - which is written down rather than
     * quietly hoped about.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async create(table: string, row: Record<string, unknown>): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, table, 'create')
            const values = patchValues(resolved, row, 'create')
            const began = Date.now()
            const made = await this.db.transaction().execute(async (trx) => {
                // Inside the transaction because two of the three flavours answer the new id with
                // "the last key this connection generated", and a pool would otherwise be free to
                // hand the read to a different connection than the insert.
                const id = await this.flavour.insert(trx, resolved.table, values)
                const written = await this.rowById(trx, resolved, id)
                return { id, stamp: written ? await this.stampOf(resolved, id, written) : undefined }
            })
            this.setState((previous) => ({ created: previous.created + 1, lastWriteMs: Date.now() - began }))
            return { status: 'ok' as const, id: made.id, ...(made.stamp !== undefined ? { stamp: made.stamp } : {}) }
        })
    }

    /**
     * Change some fields of one row, if it is still in the state the caller read it in.
     *
     * `expect` is required rather than optional, and that is the decision this whole surface turns
     * on. An optional precondition is one that gets omitted the first time somebody is in a hurry,
     * and the failure it prevents - two edits where the second silently discards the first - leaves
     * no trace anywhere for anyone to find later. The topology layer made the same call with
     * `expectedVersion` and gave the same reason.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async update(table: string, id: string, patch: Record<string, unknown>, expect: string): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, table, 'update')
            const values = patchValues(resolved, patch, 'update')
            if (typeof expect !== 'string' || !expect) throw new RelationalRefusal('update needs the stamp the row was read under - ask getOne for one')
            return this.underPrecondition(resolved, id, expect, 'updated', async (trx) => {
                await trx.updateTable(resolved.table.name).set(values).where(this.keyOf(resolved, id)).execute()
                const after = await this.rowById(trx, resolved, id)
                // The new stamp goes back with the answer, so a caller making a second edit does not
                // have to read between them. It is the stamp of what this write produced rather than
                // of what the caller asked for, which are different whenever a trigger or a default
                // had an opinion.
                return { status: 'ok' as const, id, ...(after ? { stamp: await this.stampOf(resolved, id, after) } : {}) }
            })
        })
    }

    /**
     * Remove one row, if it is still in the state the caller read it in.
     *
     * Under the same precondition as `update`, and for a sharper reason: deleting a row that changed
     * since it was looked at is exactly the case where the thing being destroyed is not the thing
     * that was examined.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async delete(table: string, id: string, expect: string): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, table, 'delete')
            if (typeof expect !== 'string' || !expect) throw new RelationalRefusal('delete needs the stamp the row was read under - ask getOne for one')
            return this.underPrecondition(resolved, id, expect, 'deleted', async (trx) => {
                await trx.deleteFrom(resolved.table.name).where(this.keyOf(resolved, id)).execute()
                // No stamp: there is no row left to have one, and inventing an empty string would be
                // a value a caller could accidentally send back.
                return { status: 'ok' as const, id }
            })
        })
    }

    /**
     * Read the row under whatever hold this engine offers, compare the stamp, and only then act.
     *
     * The hold is the part that is easy to leave out and impossible to notice missing. Under `READ
     * COMMITTED` - Postgres' default and MySQL's - two callers can read the same row, both find the
     * stamp they expected, and both write: the precondition passes twice and one edit is lost, which
     * is the exact failure it exists to prevent. `for update` closes it on those two. SQLite needs
     * nothing, because this package's dialect serialises every statement onto one connection, so a
     * transaction on it has no concurrent writer to race - a property of the dialect rather than of
     * SQLite, which is why the flavour states it rather than this file assuming it.
     */
    private async underPrecondition(
        resolved: ResolvedWrite,
        id: string,
        expect: string,
        counter: 'updated' | 'deleted',
        act: (trx: Transaction<RelationalDatabase>) => Promise<RpcWriteOutcome>
    ): Promise<RpcWriteOutcome> {
        const began = Date.now()
        const outcome = await this.db.transaction().execute(async (trx) => {
            const current = await this.rowById(trx, resolved, id, true)
            if (!current) return { status: 'missing' as const }
            const stamp = await this.stampOf(resolved, id, current)
            if (stamp !== expect) return { status: 'conflict' as const }
            return act(trx)
        })
        // Counted after the transaction has committed rather than inside it, which is the difference
        // between a number that says what happened and one that says what was attempted: a commit
        // that fails throws out here, and a counter bumped in the callback would already have
        // recorded the write that was rolled back.
        this.setState((previous) => ({
            ...(outcome.status === 'ok' ? { [counter]: (previous[counter] as number) + 1 } : {}),
            ...(outcome.status === 'missing' ? { missing: previous.missing + 1 } : {}),
            ...(outcome.status === 'conflict' ? { conflicts: previous.conflicts + 1 } : {}),
            lastWriteMs: Date.now() - began
        }))
        return outcome
    }

    /** The rule for a table under any verb, for the read that mints a stamp. */
    private anyVerb(table: string): ResolvedWrite {
        const resolved = this.writes.writable.get(table)
        if (resolved) return resolved
        const names = [...this.writes.writable.keys()]
        throw new RelationalRefusal(
            names.length ? `${table} is not writable on this node - it accepts writes to ${names.join(', ')}` : `${table} is not writable on this node, which accepts no writes at all`
        )
    }

    /**
     * `where <key> = <id>`, built from the catalogue rather than from anything a caller sent.
     *
     * `sql.id` around the column name is the second line of defence behind the whitelist that
     * resolved it, and the id itself is bound as a value - the same division the filter side makes,
     * and the reason it is stated again here is that this is the other place in the package where a
     * name becomes SQL.
     */
    private keyOf(resolved: ResolvedWrite, id: string) {
        const key = resolved.table.id!
        return sql<SqlBool>`${sql.id(key.name)} = ${idValueFor(key, id)}`
    }

    private async rowById(db: Kysely<RelationalDatabase>, resolved: ResolvedWrite, id: string, hold = false): Promise<Record<string, unknown> | undefined> {
        const query = db.selectFrom(resolved.table.name).selectAll().where(this.keyOf(resolved, id))
        const found = await (hold && this.flavour.rowLock === 'for-update' ? query.forUpdate() : query).executeTakeFirst()
        return found as Record<string, unknown> | undefined
    }

    /**
     * A row's stamp, over its wire shape rather than over what the driver returned.
     *
     * The normalisation matters: SQLite answers a boolean column as 1 and Postgres as `true`, so a
     * digest over the raw values would give the same row two different stamps on two backends - and
     * a conformance suite comparing them would be comparing drivers. `wireRow` is the read side's
     * own conversion, shared rather than copied for exactly this reason.
     */
    private stampOf(resolved: ResolvedWrite, id: string, row: Record<string, unknown>): Promise<string> {
        return rowStamp(resolved.table.name, id, stampFields(resolved, wireRow(resolved.table, row)))
    }

    /**
     * Count what happened and let it through.
     *
     * The split between a refusal and a failure is the read side's, kept identical on purpose: one
     * says the request was wrong and will stay wrong, the other says the database was reached and
     * something went badly there. An operator watching `refusals` climb is looking at a caller; one
     * watching `failures` climb is looking at a database.
     */
    private async guard<T>(act: () => Promise<T>): Promise<T> {
        try {
            return await act()
        } catch (failure) {
            this.setState((previous) => (failure instanceof RelationalRefusal ? { refusals: previous.refusals + 1 } : { failures: previous.failures + 1 }))
            throw failure
        }
    }
}

/**
 * Stand the write half up on a server, rules checked against the database before anybody can call.
 *
 * Asynchronous for the reason `exposeRelational` is, with one more of its own: the rules cannot be
 * checked until the catalogue has been read, and exposing first would publish a node that briefly
 * claims to write nothing - which is the answer a console would cache and, worse, the answer an
 * operator would believe.
 *
 * `parallel`, which is the queue's argument rather than the read service's: atomicity lives in the
 * store and not in call ordering, so serialising every write on this node behind the slowest one
 * would buy nothing that the transaction and the row hold do not already provide.
 *
 * The name is the caller's, and `<read name>.write` is the convention worth keeping - `sql` and
 * `sql.write` read as one thing with two doors, which is exactly what they are.
 */
export const exposeRelationalWrites = async (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    name: string,
    options: RelationalWriteOptions
): Promise<RelationalWriteService> => {
    const service = new RelationalWriteService(options)
    await service.refresh()
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}

/** Re-exported so a deployment can name a verb without reaching past this module. */
export type { RpcWritePermissions, RpcWriteVerb, TableInfo }
