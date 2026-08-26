import { canonicalValue, digestText } from './Canonical.js'
import type { TypeNode } from './Schema.js'

/**
 * The vocabulary a store-backed node accepts writes with - and **nothing here writes anything**.
 *
 * That distinction is the whole reason this file is in the library rather than in each store
 * package. `$data` is one dispatch verb the handler answers on every component's behalf, and there
 * is deliberately no `$write` beside it: the rule this repository states in four documents is that
 * **a value is never written over this bus, a method is called**, because a method call has an
 * `await`, a deadline, an idempotency key, an owner fence, an `authorize()` with the caller
 * resolved, and somewhere for a refusal to go. A generic write verb answered by the dispatcher
 * would have none of those unless each were re-invoked by hand, which is a gate list somebody has
 * to keep complete.
 *
 * So a node that accepts writes declares ordinary `@rpc` methods for them, and what is shared here
 * is only the **words those methods use**: which verbs exist, how permission is spelled, what an
 * outcome looks like, and - the one that genuinely must not be written twice - how a row's stamp is
 * computed. Source Relational and Source Document each implement the methods against their own
 * store; if they each invented a stamp, two nodes would disagree about whether a row had changed
 * while both of their suites stayed green. That is the same argument `packages/conformance` makes
 * about the read side, applied one layer down.
 *
 * Nothing in this file grants anything. A component that never imports it has no write surface, and
 * a component that does still publishes nothing until a deployment hands it a permission document.
 */

/**
 * What may be done to a row. Three verbs, and the absence of a fourth is deliberate.
 *
 * There is no `updateMany` or `deleteMany` here. react-admin has both, and a grid's multi-select
 * wants them - but a bulk delete over a filter is the single most dangerous call this surface could
 * offer, and it is the one where a mistaken predicate is indistinguishable from a correct one until
 * the rows are gone. A caller that means to change fifty rows makes fifty calls, each with its own
 * precondition, each individually refusable, and each individually visible in an audit line. When
 * that is genuinely too expensive it will arrive as its own verb with its own bound and its own
 * entry in the permission document, rather than as a flag on one of these.
 */
export type RpcWriteVerb = 'create' | 'update' | 'delete'

export const RPC_WRITE_VERBS: readonly RpcWriteVerb[] = ['create', 'update', 'delete']

/**
 * What one resource accepts, as data a reviewer can diff.
 *
 * Declarative rather than a predicate callback, for the reason the AI grants document is: a console
 * can render data and cannot render a callback, and a reviewer can diff a file and cannot diff a
 * decision somebody made inside a closure at three in the morning. `CatalogueOptions.tables` is a
 * predicate because it decides *visibility*, which is a deployment's convenience; this decides who
 * may change somebody else's system of record, which is not.
 */
export interface RpcWriteRule {
    /** Which verbs this resource answers. A resource that is not listed at all answers none. */
    readonly verbs: readonly RpcWriteVerb[]
    /**
     * Which fields a caller may write, by name. Required wherever `create` or `update` is offered,
     * and the requirement is the point: a rule that named a table and no columns would be read as
     * "all of them" by whoever wrote it and by whoever reads it next, and those are the two people
     * who must not disagree.
     *
     * A field absent from this list is not writable, and a patch naming one is **refused rather
     * than ignored** - a silently dropped field is a change the caller believes it made.
     */
    readonly columns?: readonly string[]
}

/** Which resources accept writes, by name. A name that is not here accepts none - that is the default. */
export interface RpcWritePermissions {
    readonly [resource: string]: RpcWriteRule
}

/**
 * What a node will actually accept, resolved against the store it is pointed at. What `writable()`
 * answers, and what a console or a model reads to find out what it can do before it is refused.
 *
 * The `DockerCreate.allowed()` shape, and for the same reason: a caller finding out what is
 * permitted by trying things is a caller generating refusals for an audit log to explain.
 */
export interface RpcWritableResource {
    readonly resource: string
    readonly verbs: readonly RpcWriteVerb[]
    /** The fields a caller may write, resolved - so a name in the rule that the store does not have is gone. */
    readonly columns: readonly string[]
    /** The shape of what `create` accepts, where the store can describe it. Drawn from the same catalogue the read side publishes. */
    readonly row?: TypeNode
}

/**
 * A rule that names something the store does not have, with the reason - carried rather than logged.
 *
 * The same tripwire `props.unserved` is on the read side, and it exists for the same failure: a
 * table missing from a write allow-list is otherwise indistinguishable from a table the operator
 * never listed, and "why can I not edit `orders`" is the first question anybody asks. A rule that
 * cannot be honoured is dropped **and said out loud**, never honoured approximately.
 */
export interface RpcRefusedWrite {
    readonly resource: string
    readonly reason: string
}

/**
 * What a write did, as an answer rather than as an exception.
 *
 * `conflict` and `missing` are facts about the store, not failures of the call - the same judgement
 * `@source-repo/queue` makes with `LeaseMutationResult`, where a lease that has already lapsed is
 * an outcome a caller acts on rather than an error it catches. An exception here would put the two
 * cases a caller most needs to tell apart - "somebody else got there first" and "the connection
 * broke" - through the same `catch`.
 *
 * Anything that *is* a failure still throws: a resource nobody may write, a field that is not
 * writable, a value the column cannot hold, a database that refused.
 */
export type RpcWriteOutcome =
    | {
          readonly status: 'ok'
          /** The row's id: the one supplied, or the one the store generated. */
          readonly id: string
          /**
           * The row's stamp after the write, so a caller editing twice does not have to read
           * between. Absent for `delete`, which leaves no row to stamp.
           */
          readonly stamp?: string
      }
    | { readonly status: 'missing' }
    /**
     * The row changed since the stamp was taken, and nothing was written.
     *
     * **It carries no stamp, deliberately.** Returning the current one would put a blind overwrite
     * one call away - retry with what came back and the precondition is satisfied by construction,
     * which is compare-and-set that compares against itself. A caller that means to proceed reads
     * the row again and decides again, which is the whole point of there being a precondition.
     */
    | { readonly status: 'conflict' }

/** A row and the stamp that names the state it was read in. What `getOne` answers on a write surface. */
export type RpcRowRead = { readonly status: 'ok'; readonly row: unknown; readonly stamp: string } | { readonly status: 'missing' }

/**
 * The stamp's format version, carried in the digest's own input.
 *
 * So that changing how a stamp is computed cannot silently make an old stamp match a new row: every
 * stamp minted under a different rule digests different bytes and compares unequal, which fails a
 * precondition rather than passing one. A caller holding a stamp across a node upgrade is told its
 * row changed, retries, and is right - the alternative is a version somebody has to remember to
 * check and a window where they did not.
 *
 * `sw2` is the first time that has been exercised. The encoding moved to `Canonical.ts`, shared with
 * the projection comparison and the `$data` cache key, and it took one rule with it: a key whose
 * value is `undefined` is now omitted rather than digested as null. Which means a row holding a JSON
 * column with an undefined-valued key stamps differently than it did - so the version moves too,
 * because leaving `sw1` naming two encodings is the exact thing this exists to prevent.
 */
export const RPC_STAMP_VERSION = 'sw2'

/**
 * What a stamp digests, before it is hashed. Exported so a suite can assert the *input* rather than
 * only the hash, which is what makes a change to the encoding visible in a diff instead of showing
 * up as a different opaque string.
 */
export const stampInput = (scope: string, id: string, fields: readonly (readonly [string, unknown])[]): string =>
    JSON.stringify([
        RPC_STAMP_VERSION,
        scope,
        id,
        // Sorted by field name rather than taken in the order the caller happened to iterate, so a
        // store that reorders its columns between two reads - or two stores describing the same
        // table - produce the same stamp for the same state.
        [...fields].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, value]) => [name, canonicalValue(value)])
    ])

/**
 * The stamp of one row: a digest over the fields a caller may write, the row's id and the resource
 * it belongs to.
 *
 * **What it covers is exactly the writable fields, and that falls out of the permission document
 * rather than being a second decision.** A heartbeat column nobody may write moving under a caller
 * is not a conflict - refusing an edit because a trigger touched `last_seen` is a precondition that
 * fails for a reason nobody can act on, and one of those is worse than none. Two callers writing
 * *different* permitted fields of the same row do conflict, and that is the conservative direction:
 * the second one re-reads and sees what the first did before deciding again.
 *
 * The scope and the id are inside the digest so a stamp cannot be carried from one row to another,
 * or from one table to another table with a row of the same shape. A stamp is not a secret and
 * makes no claim to be one - anyone who may read the row can compute it - it is a claim about
 * *which state* was read, and the compare is what turns that into a guarantee.
 *
 * WebCrypto rather than `node:crypto`, so this file stays in the browser build alongside the rest
 * of the DataProvider - the same choice `Signing.ts` already makes, and for the same reason.
 */
export const rowStamp = (scope: string, id: string, fields: readonly (readonly [string, unknown])[]): Promise<string> =>
    // The digest is `Canonical.ts`'s, shared with the snapshot envelope for the reason the encoder
    // beside it is shared: one of these is a precondition a caller holds and the other names a state
    // a process is restored from, and neither is a place to find out that two implementations
    // rounded a detail differently.
    digestText(stampInput(scope, id, fields))

/**
 * Check a permission document, throwing with a reason if it is not usable.
 *
 * Throwing is the point, and it is the judgement `validateAiGrants` already made: a node that
 * starts holding an unreadable write policy is exactly the failure this exists to prevent. Carrying
 * on with nothing permitted would be a quiet answer to a loud problem - the operator meant to allow
 * something, and the thing that reads the document must say so rather than silently disagreeing.
 *
 * `what` names the caller in the message, because the same document shape is checked by two
 * packages and "resource" is not a word that tells anybody which one refused them.
 */
export const validateWritePermissions = (value: unknown, what = 'writes'): RpcWritePermissions => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what}: expected an object mapping a resource name to what may be done to it`)
    for (const [resource, rule] of Object.entries(value as Record<string, unknown>)) {
        const where = `${what}.${resource}`
        if (!resource) throw new Error(`${what}: a resource name cannot be empty`)
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where}: expected { verbs, columns }`)
        const { verbs, columns } = rule as RpcWriteRule
        if (!Array.isArray(verbs) || !verbs.length) throw new Error(`${where}.verbs: name at least one of ${RPC_WRITE_VERBS.join(', ')}; a rule permitting nothing is simply left out`)
        for (const verb of verbs) if (!RPC_WRITE_VERBS.includes(verb)) throw new Error(`${where}.verbs: '${String(verb)}' is not a verb this library defines - one of ${RPC_WRITE_VERBS.join(', ')}`)
        const changesFields = verbs.includes('create') || verbs.includes('update')
        if (columns !== undefined) {
            if (!Array.isArray(columns) || !columns.length) throw new Error(`${where}.columns: a non-empty list of field names, or absent for a rule that only deletes`)
            const seen = new Set<string>()
            for (const column of columns) {
                if (typeof column !== 'string' || !column) throw new Error(`${where}.columns: a field name is a non-empty string`)
                // Refused rather than deduplicated: a name written twice is a document somebody
                // edited without reading, and the next thing in it may be wrong in a way this
                // cannot see.
                if (seen.has(column)) throw new Error(`${where}.columns: '${column}' is listed twice`)
                seen.add(column)
            }
            // A list of writable fields on a rule that writes no fields constrains nothing and reads
            // as though it did - the same refusal `DockerControl` makes of a manage rule that names
            // neither a prefix nor a label.
            if (!changesFields) throw new Error(`${where}.columns: only create and update write fields, and this rule does neither`)
        } else if (changesFields) {
            throw new Error(`${where}.columns: required, because this rule offers ${verbs.filter((verb) => verb !== 'delete').join(' and ')} - an absent list would read as "every field" to whoever wrote it`)
        }
    }
    return value as RpcWritePermissions
}

/**
 * Every resource a document permits, with what it permits - before the store has been consulted.
 *
 * What this answers and `writable()` does not is "what did the operator ask for", which is the other
 * half of diagnosing a table that cannot be edited: the two lists differing is precisely the case
 * `RpcRefusedWrite` explains.
 */
export const permittedResources = (permissions: RpcWritePermissions | undefined): readonly string[] => Object.keys(permissions ?? {}).sort()
