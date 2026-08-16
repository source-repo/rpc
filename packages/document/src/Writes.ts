import { RPC_WRITE_VERBS, validateWritePermissions, type RpcRefusedWrite, type RpcWritePermissions, type RpcWriteVerb } from '@source-repo/rpc'
import type { Document, Filter } from 'mongodb'
import { idValue, MAX_DOCUMENT_DEPTH, type CollectionInfo, type DocumentCatalogue } from './Catalogue.js'
import { DocumentRefusal, fieldFor } from './Filter.js'

/**
 * A permission document, resolved against the database it points at - and every reason a line of it
 * could not be honoured.
 *
 * The read half already reports what it could not serve, so an operator can tell a collection nobody
 * listed from one that was listed and did not resolve. Writes need that more, not less: an operator
 * who allow-listed `work_orders` and misspelled it gets a node that refuses every edit with "not
 * writable here", which reads exactly like a deliberate policy, and there is nothing on the screen
 * to say the policy was never loaded.
 *
 * **A rule is honoured whole or dropped whole.** A rule naming four fields of which one is not a
 * field name is not silently narrowed to three: the person who wrote it believed something about
 * that collection that is false, and the next line of the document may be wrong in a way this cannot
 * see.
 *
 * **What "does not resolve" can mean here is narrower than over SQL, and the difference is a
 * capability rather than an oversight.** The SQL node checks every column of a rule against the
 * columns it introspected, and refuses a rule naming one the table does not have. There is no such
 * list in a document store - a field exists on the documents that happen to have it, and sampling
 * can prove a field is *there*, never that it is not - so a field name is checked for the shapes
 * that would make it something other than a field name, and anything well-formed is allowed
 * through. That is the same structural defence `Filter.ts` states at its head for the read side, and
 * it is stated again here because the consequence is sharper: a misspelled field in a `writes`
 * document is caught by the SQL node at startup and by this one **never**. What it produces is an
 * update that sets a field nobody meant to exist, on a store that is perfectly happy to add one.
 *
 * The two defences that remain are therefore doing all of the work, and neither is optional. The
 * allow-list decides which fields may be written at all, so an invented name can only be one the
 * operator wrote down. And the stamp covers exactly those fields, so a write that adds one changes
 * the precondition for the next caller rather than passing unnoticed.
 */

const refuse = (message: string): never => {
    throw new DocumentRefusal(message)
}

export interface ResolvedWrite {
    readonly collection: CollectionInfo
    readonly verbs: ReadonlySet<RpcWriteVerb>
    /**
     * The fields a caller may write, as MongoDB reads them - so `id` has already become `_id`, and a
     * dot path has been checked for the shapes that are not paths.
     *
     * In rule order rather than sorted, because there is no catalogue order to put them in: nothing
     * in a document store enumerates a collection's fields, so the only order that exists is the one
     * the operator wrote them in.
     */
    readonly fields: readonly string[]
}

export interface ResolvedWrites {
    readonly writable: ReadonlyMap<string, ResolvedWrite>
    readonly refused: readonly RpcRefusedWrite[]
}

/**
 * What a collection's rule means once the database has been consulted.
 *
 * Refused here rather than at the moment somebody presses a button, because these are properties of
 * the deployment rather than of the call, and a deployment fault should be visible on the node's own
 * props from the second it starts.
 */
export const resolveWrites = (catalogue: DocumentCatalogue, permissions: RpcWritePermissions | undefined): ResolvedWrites => {
    const writable = new Map<string, ResolvedWrite>()
    const refused: RpcRefusedWrite[] = []
    for (const [name, rule] of Object.entries(permissions ?? {})) {
        const collection = catalogue.byName.get(name)
        if (!collection) {
            // There is no second reason to give, unlike the SQL side: a collection is either in the
            // catalogue or it is not, and nothing about a document store can make one unservable
            // while it exists. A `collections` predicate that hides one is the other way to get
            // here, and reads the same way to whoever has to fix it.
            refused.push({ resource: name, reason: 'not a collection this node serves' })
            continue
        }
        const fields: string[] = []
        let bad: string | undefined
        for (const wanted of rule.columns ?? []) {
            let field: string
            try {
                field = fieldFor(wanted, `a writable field of ${name}`)
            } catch (failure) {
                // The whole rule, not this one field. `fieldFor` already said what is wrong with the
                // name, and repeating it in a second sentence of this file's own would give an
                // operator two descriptions of one fault to reconcile.
                bad = failure instanceof DocumentRefusal ? failure.message : String(failure)
                break
            }
            // Refused rather than deduplicated, for the reason the library refuses a name listed
            // twice: `id` and `_id` are one field under two spellings, and a document that names
            // both is one somebody edited without reading.
            if (fields.includes(field)) {
                bad = `names ${wanted}, which is ${field} - already in the list under another spelling`
                break
            }
            fields.push(field)
        }
        if (bad) {
            refused.push({ resource: name, reason: bad })
            continue
        }
        writable.set(name, { collection, verbs: new Set(rule.verbs), fields })
    }
    return { writable, refused }
}

/** The rules, checked before a connection is used - so a malformed document refuses the node. */
export const readWritePermissions = (permissions: RpcWritePermissions | undefined): RpcWritePermissions | undefined =>
    permissions === undefined ? undefined : validateWritePermissions(permissions, 'writes')

/**
 * The resolved rule for a collection and a verb, or a refusal naming what is writable.
 *
 * Both halves of the refusal matter. Naming the collection says the rule exists and this verb is not
 * in it; naming what *is* writable is the answer to "can I change this", which is the question
 * behind every one of these and is otherwise a guessing game. `describe()` already publishes the
 * namespace and `writable()` already publishes the list, so this discloses nothing a caller
 * permitted to be here could not read directly.
 */
export const writeFor = (writes: ResolvedWrites, collection: string, verb: RpcWriteVerb): ResolvedWrite => {
    const resolved = writes.writable.get(collection)
    if (!resolved) {
        const names = [...writes.writable.keys()]
        return refuse(
            names.length ? `${collection} is not writable on this node - it accepts writes to ${names.join(', ')}` : `${collection} is not writable on this node, which accepts no writes at all`
        )
    }
    if (!resolved.verbs.has(verb)) return refuse(`${collection} does not answer ${verb} - it answers ${[...RPC_WRITE_VERBS].filter((one) => resolved.verbs.has(one)).join(', ')}`)
    return resolved
}

/**
 * One value, checked for whether a document can hold it at all - and **not** for what kind it is.
 *
 * That absence is the design rather than a gap. The SQL node checks every value against the column's
 * declared type, because refusing `'80'` into a numeric setpoint is refusing a write that would
 * otherwise be stored wrong and never reported. There is no equivalent declaration here to check
 * against: a collection's shape is a sample as often as it is a validator, and neither is a promise
 * about what may be written - `Catalogue.ts` drops a validator's constraints for exactly that
 * reason, saying "this node never writes". Checking a value against a shape inferred from twenty
 * documents would refuse a perfectly legitimate write on the strength of a guess, and a store whose
 * whole point is that documents differ is the wrong place to invent a schema.
 *
 * Where a collection *does* carry a validator, the server enforces it on the write itself and
 * refuses in its own words, which is the right authority for a rule the server owns.
 *
 * What is checked is that the value survives the trip. Anything MsgPack and BSON both carry is let
 * through; a function, a symbol or a bigint is not, and each for the same reason - what came back
 * from the store afterwards would not be what was sent, so the stamp taken over it would describe
 * something the caller never wrote.
 */
const checkValue = (field: string, value: unknown, depth = 0): void => {
    if (depth > MAX_DOCUMENT_DEPTH)
        refuse(`${field} was given a value nested deeper than ${MAX_DOCUMENT_DEPTH}, which is as far as a document is walked on its way to the wire - what is below that would be stamped as nothing`)
    if (value === null) return
    if (value instanceof Date || value instanceof Uint8Array) return
    if (Array.isArray(value)) {
        for (const item of value) checkValue(field, item, depth + 1)
        return
    }
    switch (typeof value) {
        case 'string':
        case 'number':
        case 'boolean':
            return
        case 'bigint':
            refuse(`${field} was given a bigint, which comes back from the store as a number or as a string - send whichever of those it is meant to be, rather than finding out which it became`)
            return
        case 'object': {
            for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
                // The same shapes `fieldFor` refuses in a path, refused one level down in a value.
                // MongoDB will store a key beginning with `$` or holding a dot, and this node would
                // then be unable to filter on it or reach it with a dot path - so it would have
                // written a field it cannot read back, which is worse than refusing.
                if (!key) refuse(`${field} was given an object with an empty field name`)
                if (key.startsWith('$')) refuse(`${field} was given an object whose field ${JSON.stringify(key)} begins with $, which reads as an operator rather than a name`)
                if (key.includes('.')) refuse(`${field} was given an object whose field ${JSON.stringify(key)} holds a dot, which no path this node builds could ever reach`)
                if (key.includes('\u0000')) refuse(`${field} was given an object with a field name containing a NUL`)
                checkValue(field, held, depth + 1)
            }
            return
        }
        default:
            refuse(`${field} was given ${value === undefined ? 'nothing' : `a ${typeof value}`}, which is not a value a document can hold`)
    }
}

/**
 * A patch, checked whole before any of it is applied.
 *
 * Whole, and that is the point rather than an implementation detail: a patch half-applied and then
 * refused is a document in a state nobody asked for, and the caller's error says nothing about which
 * half. Every field is resolved and every value checked, and only then does anything reach the
 * database.
 *
 * The id is refused explicitly rather than by being left out of the allow-list, because it must be
 * *in* the allow-list for a natural key to be creatable - and the two verbs want opposite things
 * from the same field. A document that renames itself leaves every reference to it dangling, with no
 * error anywhere, which is precisely the failure `getMany` answering positionally exists to make
 * visible.
 *
 * Nothing here checks that a `create` carries the fields a document needs, which is the other half
 * the SQL node does and this one cannot: what a collection requires is either a validator - which
 * the server itself enforces, in its own words, on the write - or an inference from a sample, and
 * refusing a create because twenty documents happened to share a field would be refusing on the
 * strength of a guess.
 */
export const patchValues = (resolved: ResolvedWrite, patch: Record<string, unknown>, verb: 'create' | 'update'): Record<string, unknown> => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return refuse(`${verb} takes an object of field names to values`)
    const permitted = new Set(resolved.fields)
    const values: Record<string, unknown> = {}
    for (const [given, value] of Object.entries(patch)) {
        const field = fieldFor(given, `${verb} on ${resolved.collection.name}`)
        if (!permitted.has(field))
            return refuse(
                resolved.fields.length
                    ? `${given} is not writable on ${resolved.collection.name} - this node writes ${resolved.fields.join(', ')}`
                    : `${given} is not writable on ${resolved.collection.name}, which has no writable fields`
            )
        if (verb === 'update' && field === '_id')
            return refuse(`${given} is the id of ${resolved.collection.name}: a row cannot be renamed by an update, because every reference taken from the old id would be left pointing at nothing`)
        if (value === undefined) return refuse(`${given} was given no value - omit the field to leave it alone, or send null to clear it`)
        checkValue(given, value)
        // The one conversion in a file that otherwise refuses to convert anything, and it is not the
        // type check the comment above declines to make: `_id` is not an ordinary field, it is the
        // thing the collection is keyed on, and the read half already turns a wire id into one this
        // way. A create that stored the hex text of an ObjectId as a string would produce a document
        // whose id this node hands out and then refuses to accept back.
        values[field] = verb === 'create' && field === '_id' && typeof value === 'string' ? idValue(resolved.collection, value) : value
    }
    if (verb === 'update' && !Object.keys(values).length) return refuse('update was given no fields to change')
    return values
}

/**
 * One field of a document, by dot path. Absent reads as `undefined`.
 *
 * Deliberately the plain walk rather than MongoDB's own path semantics, which also reach *across* an
 * array - `tags.name` matching the name of any element. Copying that would be inventing a second
 * implementation of somebody else's matcher, and the consequence of not copying it is stated where
 * it lands, in `guardFor`.
 */
const at = (document: Record<string, unknown>, path: string): unknown => {
    let held: unknown = document
    for (const segment of path.split('.')) {
        if (held === null || typeof held !== 'object') return undefined
        held = (held as Record<string, unknown>)[segment]
    }
    return held
}

/**
 * The fields a document's stamp covers: the writable ones, and only those.
 *
 * It falls out of the permission document rather than being a second decision, which is what keeps
 * it explicable. A field nobody may write moving underneath a caller is not a conflict - refusing an
 * edit because something else touched `lastSeen` is a precondition that fails for a reason nobody
 * can act on, and one of those gets switched off within a week. Two callers writing different
 * permitted fields of the same document *do* conflict, and the second one re-reads and sees what the
 * first did before deciding again, which is the conservative direction and the right one.
 *
 * Taken over the document as it goes on the wire rather than as the driver returned it, which is why
 * the caller hands this a `wireDocument` result: an ObjectId is a hex string to one read and a BSON
 * object to another, and a digest over the second would give one document two stamps depending on
 * which path it arrived by.
 */
export const stampFields = (resolved: ResolvedWrite, document: Record<string, unknown>): readonly (readonly [string, unknown])[] =>
    resolved.fields.map((field) => [field, at(document, field)] as const)

/**
 * The filter fragment that pins the stamped fields to the values they were just read at.
 *
 * **This is what makes the compare-and-set atomic, and it is the whole reason a document node needs
 * no transaction.** The stamp is compared against a read, and between that read and the write
 * anything at all may happen - so the values the stamp was taken over travel *in the update's own
 * filter*, and the server matches them at the instant it applies the change. Nothing matched means
 * something moved in between, which the service turns into a conflict rather than a write. Take the
 * guard away and the precondition becomes advisory: two callers read the same document, both find
 * the stamp they expected, and both write.
 *
 * A multi-document transaction would close the same hole and cost more than it closes: it needs a
 * replica set, so it would make a node that runs against a standalone `mongod` today refuse to start
 * - and it would be a transaction around a single document, which is the one case MongoDB already
 * makes atomic on its own.
 *
 * Built from the **raw** document rather than the normalised one, because these values are compared
 * by the server against what it stores: an ObjectId has to go back as an ObjectId, and its hex
 * string would match nothing.
 *
 * Two things about it are worth stating rather than discovering. A filter is not exactly an equality
 * test - pinning a field that holds an array also matches a document whose array holds that array as
 * an element - and a path that reaches through an array means something wider to MongoDB than the
 * walk in `at` does. Neither loosens the precondition in the direction that loses an edit: a path
 * through an array reads as absent here and as present to the server, so the guard never matches and
 * the caller is told to read again. That is a spurious conflict, which is the failure worth having.
 */
export const guardFor = (resolved: ResolvedWrite, document: Record<string, unknown>): Filter<Document> => {
    const guard: Record<string, unknown> = {}
    for (const field of resolved.fields) {
        const held = at(document, field)
        // Absent is a state like any other, and it has to be pinned as one: leaving the field out of
        // the guard would let a write land on a document that has since acquired a value there, and
        // `{ field: null }` would not do it either - that matches a missing field as well as an
        // explicit null, which is the one thing this has to tell apart.
        guard[field] = held === undefined ? { $exists: false } : held
    }
    return guard as Filter<Document>
}
