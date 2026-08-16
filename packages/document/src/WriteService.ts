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
import type { Db, Document, Filter, OptionalUnlessRequiredId } from 'mongodb'
import { idText, idValue, readCatalogue, wireDocument, type CollectionInfo, type DocumentCatalogue, type DocumentCatalogueOptions } from './Catalogue.js'
import { BINARY, DocumentRefusal } from './Filter.js'
import { guardFor, patchValues, readWritePermissions, resolveWrites, stampFields, writeFor, type ResolvedWrite, type ResolvedWrites } from './Writes.js'

/**
 * The write half of Source Document: documents created, changed and removed in a database somebody
 * else owns.
 *
 * **A separate class in a separate namespace, and that is the design rather than tidiness.** It is
 * the split `DockerService`/`DockerControl` already makes, for the reasons that file gives: two
 * namespaces are two `authorize()` surfaces, so an operator can grant reading to everyone and
 * writing to nobody; and a subclass would have made "may call the database" one permission while
 * quietly making the read-only class's promise a lie by inheritance - code holding a
 * `DocumentService` could be holding a writable one. It also has its own subpath export, so
 * importing it is a visible line in a diff rather than an option somebody set.
 *
 * **The rule the whole repository states four times is intact.** A value is still never written over
 * this bus; a method is still called. Everything here is an ordinary `@rpc` method with declared
 * semantics and a declared effect, so the deadline, the execution queue, the owner fence,
 * `authorize()` with the collection and the patch visible in `params`, the AI grants ladder and the
 * idempotency store all apply exactly as they do to any other command. There is no `$write` verb
 * beside `$data`, and there is not going to be: a dispatch-level write would sit outside every one
 * of those gates unless each were re-invoked by hand, which is a list somebody has to keep complete.
 *
 * **Closed by default, and composing it in is what says so.** With no `writes` document nothing is
 * writable, every call is refused, and `elevation()` announces nothing - so a node stood up by
 * accident can do nothing at all.
 *
 * **Every change carries a precondition**, and here it is carried twice. `update` and `delete` take
 * the stamp the document was read under, compare it against a fresh read, and then send the values
 * that stamp was taken over *in the filter of the write itself* - so the compare and the set are one
 * operation on the server. The SQL node reaches the same guarantee with a transaction and a row
 * hold; this one needs neither, which is what lets it run against a standalone `mongod`.
 */

export interface DocumentWriteOptions {
    /** A `Db`, already connected with whichever credentials this node uses. */
    readonly db: Db
    /**
     * Which collections accept which verbs, and which of their fields may be written. Absent means
     * nothing is writable, which is what a node with no decision behind it should be.
     */
    readonly writes?: RpcWritePermissions
    /**
     * How much of the database to look at. The same options the read service takes - though note
     * this node needs the catalogue only for the collection's existence and the kind of its `_id`,
     * so a `collections` predicate that hides one listed in `writes` makes that rule refused rather
     * than merely unserved, and says so in `props.refused`.
     */
    readonly catalogue?: DocumentCatalogueOptions
}

export interface DocumentWriteProps {
    /** How many collections this node can actually write, after the rules were checked against the database. */
    writable: number
    /**
     * Rules that name something the database does not have, with the reason.
     *
     * The tripwire, and the reason it is in props rather than in a log. A misspelled collection
     * produces a node that refuses every edit to it, which reads exactly like a deliberate policy -
     * and there is nothing else on any screen that would say the policy was never loaded.
     */
    refused: readonly RpcRefusedWrite[]
    /**
     * How this node holds a document while it checks a precondition, so somebody diagnosing a lost
     * update can see which mechanism was in play rather than having to know the store's defaults.
     *
     * There is exactly one value, and it is worth naming rather than leaving implied: the guard
     * travels in the update's **own filter**, so the compare and the set are a single operation on
     * the server and there is nothing to hold. That is not a weaker version of what the SQL node
     * does with a transaction and `for update` - it is the same guarantee bought differently, and it
     * is bought where a multi-document transaction could not be: on a standalone `mongod`, which has
     * no replica set and therefore no transactions at all. A node that needed one would refuse to
     * start against the most common way MongoDB is deployed for a single service.
     */
    locking: 'guarded-filter'
    [key: string]: unknown
}

export interface DocumentWriteState {
    created: number
    updated: number
    deleted: number
    /**
     * Writes refused because the document had changed since it was read.
     *
     * First-class rather than folded into refusals, because it is the one counter that measures the
     * plant rather than the callers: a number that climbs means two things are editing the same
     * documents, which is a fact about how the site works and is invisible from anywhere else.
     */
    conflicts: number
    /** Writes against a document that was not there - a reference somebody held after it was removed. */
    missing: number
    /** Calls refused for naming something not writable, or a value a document cannot hold. */
    refusals: number
    /** Calls that reached the database and failed there. */
    failures: number
    lastWriteMs?: number
    [key: string]: unknown
}

export class DocumentWriteService extends RpcComponent<DocumentWriteProps, DocumentWriteState> {
    private readonly db: Db
    private readonly catalogueOptions: DocumentCatalogueOptions
    private readonly permissions?: RpcWritePermissions
    private catalogue: DocumentCatalogue = { collections: [], byName: new Map() }
    private writes: ResolvedWrites = { writable: new Map(), refused: [] }

    constructor(options: DocumentWriteOptions) {
        super({ writable: 0, refused: [], locking: 'guarded-filter' }, { created: 0, updated: 0, deleted: 0, conflicts: 0, missing: 0, refusals: 0, failures: 0 })
        this.db = options.db
        this.catalogueOptions = options.catalogue ?? {}
        // Checked before the database is touched, so a malformed document refuses the node rather
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
        const named = [...this.writes.writable.entries()].map(([collection, resolved]) => `${collection} (${[...resolved.verbs].sort().join('/')})`)
        return { capability: 'document.write', reason: `may write ${named.join(', ')}` }
    }

    /**
     * Re-read what the database holds and check the rules against it.
     *
     * A `program` effect rather than an `operate` one, and the difference is real: this decides what
     * the node *is able to write* for every call after it, so it is the one method here whose blast
     * radius is not one document. An AI principal granted `ai.tool.write` may edit documents all day
     * and still not re-resolve the permission document.
     *
     * More load-bearing than its SQL counterpart for the reason the read half gives: a collection is
     * not declared anywhere, so what this node knows about one is only ever true of the moment it
     * looked - including the kind of `_id` it keys on, which is what every call here converts by.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'program' })
    async refresh(): Promise<{ writable: number; refused: readonly RpcRefusedWrite[] }> {
        this.catalogue = await readCatalogue(this.db, this.catalogueOptions)
        this.writes = resolveWrites(this.catalogue, this.permissions)
        componentHost(this).replaceProps({ writable: this.writes.writable.size, refused: this.writes.refused, locking: 'guarded-filter' })
        return { writable: this.writes.writable.size, refused: this.writes.refused }
    }

    /**
     * What this node is permitted to write, so a caller finds out before being refused.
     *
     * `DockerCreate.allowed()`, two packages over. A console or a model discovering its permissions
     * by trying things is one generating refusals for an audit log to explain, and the list is the
     * whole answer to "can I change this" - which is often no, because a collection nobody
     * allow-listed is not here at all.
     *
     * **No `row` shape, unlike the SQL node**, and its absence is the honest answer rather than a
     * missing feature. What that field carries there is a statement about what `create` accepts,
     * drawn from columns the database declares. A collection declares nothing: `props.shapes` on the
     * read side publishes a shape and says in the same breath whether it came from a validator or
     * from twenty sampled documents, and a form drawn from the sampled kind would be offering fields
     * that happen to be popular. A caller that wants the shape asks the read half, where it arrives
     * with its provenance attached.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async writable(): Promise<readonly RpcWritableResource[]> {
        return [...this.writes.writable.entries()].map(([resource, resolved]) => ({
            resource,
            verbs: [...resolved.verbs].sort(),
            columns: [...resolved.fields]
        }))
    }

    /**
     * One document, and the stamp that names the state it was read in.
     *
     * This is the `getOne` the read side declines to serve, and it is not the same verb. There, the
     * argument holds exactly: a caller wanting one document asks `getMany` for one id, and a verb
     * that exists only to be a worse version of another is not worth the wire. Here it answers
     * something `getMany` does not carry at all - the precondition a change is made under - and since
     * the only way to hold a stamp is to have read the document, this is what makes compare-and-set
     * possible rather than a parameter callers invent.
     *
     * A read, so it is `observe`: an AI principal that may watch a plant may take a stamp, and is no
     * closer to being able to use one.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async getOne(collection: string, id: string): Promise<RpcRowRead> {
        return this.guard(async () => {
            // Any verb: a stamp for a collection nobody may write is of no use to anybody, and a
            // collection that is not in the document at all should not be readable through the write
            // namespace when the read one exists for that.
            const resolved = this.anyVerb(collection)
            const found = await this.documentById(resolved, idValue(resolved.collection, id))
            if (!found) return { status: 'missing' } as const
            return { status: 'ok' as const, row: wireDocument(found), stamp: await this.stampOf(resolved, id, found) }
        })
    }

    /**
     * Insert a document and answer what it is called.
     *
     * `non-repeatable-command`, which is the honest classification and the useful one: a repeat
     * inserts a second document, so the library consults the idempotency store when the host has one
     * and a redelivered frame is answered from the record rather than run again. Without a store,
     * execution is at least once here as it is everywhere else - which is written down rather than
     * quietly hoped about.
     *
     * No precondition, because there is nothing yet to have one. A caller that means "only if it
     * does not exist" supplies the `_id` and lets the collection's unique index refuse the second
     * one, which is a promise the server keeps and this node could only approximate.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async create(collection: string, document: Record<string, unknown>): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, collection, 'create')
            const values = patchValues(resolved, document, 'create')
            const began = Date.now()
            const made = await this.db.collection(resolved.collection.name).insertOne(values as OptionalUnlessRequiredId<Document>)
            const id = idText(made.insertedId)
            // Read back rather than stamped from what was sent. The two differ whenever the server
            // had an opinion - a generated `_id` most of all - and a stamp has to describe what is in
            // the collection rather than what the caller hoped to put there, or the next edit fails
            // its precondition for no reason anybody can see.
            const written = await this.documentById(resolved, made.insertedId)
            this.setState((previous) => ({ created: previous.created + 1, lastWriteMs: Date.now() - began }))
            return { status: 'ok' as const, id, ...(written ? { stamp: await this.stampOf(resolved, id, written) } : {}) }
        })
    }

    /**
     * Change some fields of one document, if it is still in the state the caller read it in.
     *
     * `expect` is required rather than optional, and that is the decision this whole surface turns
     * on. An optional precondition is one that gets omitted the first time somebody is in a hurry,
     * and the failure it prevents - two edits where the second silently discards the first - leaves
     * no trace anywhere for anyone to find later. The topology layer made the same call with
     * `expectedVersion` and gave the same reason.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async update(collection: string, id: string, patch: Record<string, unknown>, expect: string): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, collection, 'update')
            const values = patchValues(resolved, patch, 'update')
            if (typeof expect !== 'string' || !expect) throw new DocumentRefusal('update needs the stamp the row was read under - ask getOne for one')
            return this.underPrecondition(resolved, id, expect, async (current, key) => {
                const written = await this.db
                    .collection(resolved.collection.name)
                    .updateOne(this.pinned(resolved, current, key), { $set: values }, { collation: BINARY })
                // **The atomic half, and the whole reason the guard exists.** The stamp was compared
                // against a read, and between that read and this line anything at all may have
                // happened - so the values it was taken over travelled in the filter above, and the
                // server compared them at the instant it applied the change. Nothing matched means
                // the document moved in between, and answering `ok` here would be exactly the lost
                // update the precondition exists to prevent. It is reported as a conflict rather than
                // as `missing` even where the document was removed, because from here the two are
                // the same fact: what was read is not what is there.
                if (!written.matchedCount) return { status: 'conflict' as const }
                const after = await this.documentById(resolved, key)
                this.setState((previous) => ({ updated: previous.updated + 1 }))
                // The new stamp goes back with the answer, so a caller making a second edit does not
                // have to read between them. It is the stamp of what this write produced rather than
                // of what the caller asked for, which are different whenever the server had an
                // opinion about a value.
                return { status: 'ok' as const, id, ...(after ? { stamp: await this.stampOf(resolved, id, after) } : {}) }
            })
        })
    }

    /**
     * Remove one document, if it is still in the state the caller read it in.
     *
     * Under the same precondition as `update`, and for a sharper reason: deleting a document that
     * changed since it was looked at is exactly the case where the thing being destroyed is not the
     * thing that was examined.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate' })
    async delete(collection: string, id: string, expect: string): Promise<RpcWriteOutcome> {
        return this.guard(async () => {
            const resolved = writeFor(this.writes, collection, 'delete')
            if (typeof expect !== 'string' || !expect) throw new DocumentRefusal('delete needs the stamp the row was read under - ask getOne for one')
            return this.underPrecondition(resolved, id, expect, async (current, key) => {
                const removed = await this.db.collection(resolved.collection.name).deleteOne(this.pinned(resolved, current, key), { collation: BINARY })
                if (!removed.deletedCount) {
                    // Nothing was removed, which is either "somebody changed it" or "somebody else
                    // removed it first". Those are different answers to a caller - one says read
                    // again and decide again, the other says the thing is gone - so they are told
                    // apart by asking rather than guessed at from a count that cannot distinguish
                    // them.
                    const again = await this.documentById(resolved, key)
                    return again ? ({ status: 'conflict' } as const) : ({ status: 'missing' } as const)
                }
                this.setState((previous) => ({ deleted: previous.deleted + 1 }))
                // No stamp: there is no document left to have one, and inventing an empty string
                // would be a value a caller could accidentally send back.
                return { status: 'ok' as const, id }
            })
        })
    }

    /**
     * Read the document, compare the stamp, and only then act - counting whichever of the three
     * things happened.
     *
     * Note what this does *not* do, which is where it parts company with the SQL node: there is no
     * transaction and nothing is held. The compare here is against a read and is therefore advisory
     * on its own; what makes it binding is that `act` sends the same values back in the filter of
     * the write. Reading first is still worth the round trip, because it is what tells a caller
     * `missing` from `conflict` and what produces the message somebody can act on - a guard that
     * simply matched nothing could not say which of the two it was.
     */
    private async underPrecondition(
        resolved: ResolvedWrite,
        id: string,
        expect: string,
        act: (current: Document, key: unknown) => Promise<RpcWriteOutcome>
    ): Promise<RpcWriteOutcome> {
        const began = Date.now()
        const key = idValue(resolved.collection, id)
        const current = await this.documentById(resolved, key)
        if (!current) return this.counted({ status: 'missing' }, began)
        if ((await this.stampOf(resolved, id, current)) !== expect) return this.counted({ status: 'conflict' }, began)
        return this.counted(await act(current, key), began)
    }

    /**
     * The filter a guarded write goes out under: the stamped fields pinned to what was just read,
     * and the key.
     *
     * The guard first and the key last, so that a rule listing the id among its writable fields
     * cannot have the document's own stamped `_id` stand in for the id this call named. The two
     * agree here, and relying on that would be relying on an accident.
     */
    private pinned(resolved: ResolvedWrite, current: Document, key: unknown): Filter<Document> {
        return { ...guardFor(resolved, current), _id: key } as Filter<Document>
    }

    /** Count what an attempt turned out to be. `ok` is counted by whichever verb produced it. */
    private counted(outcome: RpcWriteOutcome, began: number): RpcWriteOutcome {
        if (outcome.status === 'missing') this.setState((previous) => ({ missing: previous.missing + 1 }))
        else if (outcome.status === 'conflict') this.setState((previous) => ({ conflicts: previous.conflicts + 1 }))
        this.setState({ lastWriteMs: Date.now() - began })
        return outcome
    }

    /** The rule for a collection under any verb, for the read that mints a stamp. */
    private anyVerb(collection: string): ResolvedWrite {
        const resolved = this.writes.writable.get(collection)
        if (resolved) return resolved
        const names = [...this.writes.writable.keys()]
        throw new DocumentRefusal(
            names.length ? `${collection} is not writable on this node - it accepts writes to ${names.join(', ')}` : `${collection} is not writable on this node, which accepts no writes at all`
        )
    }

    /**
     * One document by key, under the same collation every other query in this package names.
     *
     * The collation is not decoration here. Under a case-folding one, `_id: 'north'` would find a
     * document keyed `North`, and the guard's own string comparisons would fold with it - so a
     * precondition pinning a field to `borg` would be satisfied by a document somebody has since
     * changed to `Borg`. Naming the simple collation is what makes the compare in compare-and-set
     * mean what it says.
     */
    private async documentById(resolved: ResolvedWrite, key: unknown): Promise<Document | null> {
        return this.db.collection(resolved.collection.name).findOne({ _id: key } as Filter<Document>, { collation: BINARY })
    }

    /**
     * A document's stamp, over its wire shape rather than over what the driver returned.
     *
     * The normalisation matters: an ObjectId is a BSON object to the driver and a hex string on the
     * wire, so a digest over the raw values would depend on which path the document arrived by.
     * `wireDocument` is the read side's own conversion, shared rather than copied for exactly this
     * reason.
     */
    private stampOf(resolved: ResolvedWrite, id: string, document: Document): Promise<string> {
        return rowStamp(resolved.collection.name, id, stampFields(resolved, wireDocument(document) as Record<string, unknown>))
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
            this.setState((previous) => (failure instanceof DocumentRefusal ? { refusals: previous.refusals + 1 } : { failures: previous.failures + 1 }))
            throw failure
        }
    }
}

/**
 * Stand the write half up on a server, rules checked against the database before anybody can call.
 *
 * Asynchronous for the reason `exposeDocument` is, with one more of its own: the rules cannot be
 * checked until the catalogue has been read, and exposing first would publish a node that briefly
 * claims to write nothing - which is the answer a console would cache and, worse, the answer an
 * operator would believe.
 *
 * `parallel`, which is the queue's argument rather than the read service's: atomicity lives in the
 * store and not in call ordering, so serialising every write on this node behind the slowest one
 * would buy nothing the guarded filter does not already provide.
 *
 * The name is the caller's, and `<read name>.write` is the convention worth keeping - `docs` and
 * `docs.write` read as one thing with two doors, which is exactly what they are.
 */
export const exposeDocumentWrites = async (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    name: string,
    options: DocumentWriteOptions
): Promise<DocumentWriteService> => {
    const service = new DocumentWriteService(options)
    await service.refresh()
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}

/** Re-exported so a deployment can name a verb without reaching past this module. */
export type { CollectionInfo, RpcWritePermissions, RpcWriteVerb }
