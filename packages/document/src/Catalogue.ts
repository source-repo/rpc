import type { FieldNode, RpcDataMethod, RpcDataResource, TypeNode } from '@source-repo/rpc'
import { ObjectId, type Db, type Document } from 'mongodb'
import { DocumentRefusal } from './Filter.js'

/**
 * What the database says it holds - and the honest admission that it mostly does not know.
 *
 * This is where a document store differs from a table in the way that matters. A SQL node asks the
 * database for its columns and their types and gets an answer that is true of every row, now and
 * later. `listCollections` gives names and nothing else: a field exists on the documents that
 * happen to have it, and there is no statement anywhere about what the next one will look like.
 *
 * So a row shape comes from one of two places, and **which one is part of the answer**:
 *
 * - **A validator.** A collection created with `$jsonSchema` has a real declaration, checked by the
 *   server on every write. That is as good as a table's columns and is used as such.
 * - **A sample.** Otherwise a bounded number of documents are read and their fields collected. That
 *   is a guess, and it is labelled as one - the object is left open (`additional: true`), every
 *   field is optional unless it appeared in all of them, and the provenance is published in the
 *   component's props so a viewer can say where the columns came from.
 *
 * A sampled shape presented as a contract would be the worst outcome available: a grid drawing
 * columns from twenty documents, over a collection whose twenty-first has different fields, with
 * nothing anywhere saying the shape was inferred.
 */

/** Where a collection's shape came from, which is a fact about the answer rather than about the data. */
export type ShapeSource = 'validator' | 'sampled' | 'unknown'

/** How an `_id` is spelled on the wire, and how one arrives back. */
export type IdKind = 'objectId' | 'string' | 'number' | 'mixed'

export interface CollectionInfo {
    readonly name: string
    readonly idKind: IdKind
    readonly shape: ShapeSource
    readonly row?: TypeNode
    /** How many documents were read to infer the shape. Zero where a validator supplied it. */
    readonly sampled: number
}

export interface DocumentCatalogue {
    readonly collections: readonly CollectionInfo[]
    readonly byName: ReadonlyMap<string, CollectionInfo>
}

export interface DocumentCatalogueOptions {
    /**
     * Which collections to serve at all. A node points at a database somebody else owns, and "serve
     * everything you can see" is rarely what its operator meant.
     */
    readonly collections?: (name: string) => boolean
    /**
     * How many documents to read when there is no validator to read instead.
     *
     * A trade with no right answer: more documents find more fields and cost more on a collection
     * whose only purpose here is to be described. Twenty is enough to find the shape of anything
     * uniform and honest about anything that is not, since the result is labelled as sampled either
     * way.
     */
    readonly sample?: number
}

const DEFAULT_SAMPLE = 20

/**
 * Which verbs a collection answers.
 *
 * Not `getOne`, and that is a decline rather than a gap: the library serves it, and a document's row is
 * the same shape whether one is asked for or fifty, so answering it here would be `getMany` with one
 * id under another name. The verb earns its place where a resource's detail is *richer* than its
 * rows - twenty fields behind the four worth tabulating - which is not the shape a document store has.
 */
const VERBS: readonly RpcDataMethod[] = ['getList', 'getMany', 'getManyReference']

export const readCatalogue = async (db: Db, options: DocumentCatalogueOptions = {}): Promise<DocumentCatalogue> => {
    // `nameOnly: false` so the options - and with them any `$jsonSchema` validator - come
    // back: the driver types a bare call as "a name, or everything", which is nothing to read a
    // shape from.
    const found = await db.listCollections({}, { nameOnly: false }).toArray()
    const collections: CollectionInfo[] = []

    for (const entry of found) {
        if (options.collections && !options.collections(entry.name)) continue
        const validator = (entry.options as { validator?: { $jsonSchema?: Document } } | undefined)?.validator?.$jsonSchema
        const sampleSize = options.sample ?? DEFAULT_SAMPLE
        // Read even where a validator supplied the shape, because the `_id` kind is not in a
        // validator in any useful way and is the one thing that must be right: an id that does not
        // round-trip makes getMany answer nothing, silently.
        const sample = await db.collection(entry.name).find({}, { limit: sampleSize, projection: validator ? { _id: 1 } : undefined }).toArray()

        collections.push({
            name: entry.name,
            idKind: idKindOf(sample),
            shape: validator ? 'validator' : sample.length ? 'sampled' : 'unknown',
            row: validator ? fromJsonSchema(validator) : sample.length ? fromSample(sample) : undefined,
            sampled: validator ? 0 : sample.length
        })
    }

    return { collections, byName: new Map(collections.map((collection) => [collection.name, collection])) }
}

/**
 * What kind of `_id` this collection uses, from what was actually in it.
 *
 * `mixed` is a real answer rather than a failure: nothing stops a collection holding ObjectIds and
 * strings, and a node that refused to serve one would be refusing a collection MongoDB is perfectly
 * happy with. What it costs is the round trip - a mixed collection's ids are compared as strings on
 * the way back in, so an ObjectId there will not be found. Said in the props rather than hidden.
 */
const idKindOf = (sample: readonly Document[]): IdKind => {
    const kinds = new Set(
        sample.map((document) =>
            document._id instanceof ObjectId ? 'objectId' : typeof document._id === 'number' ? 'number' : typeof document._id === 'string' ? 'string' : 'mixed'
        )
    )
    // An empty collection is an ObjectId collection until proven otherwise, which is what MongoDB
    // itself assumes when it generates one.
    if (!kinds.size) return 'objectId'
    return kinds.size === 1 ? ([...kinds][0] as IdKind) : 'mixed'
}

/**
 * An id from the wire, as `_id` will actually match it.
 *
 * An ObjectId is its twenty-four hex characters and has to be rebuilt, or `{ _id: { $in: ['65…'] } }`
 * is a perfectly valid query that finds nothing - silently, which is the failure this exists to
 * prevent. A collection whose ids are mixed is compared as text, which is honest about what it can
 * do rather than guessing which kind was meant.
 *
 * Here rather than in `Filter.ts` beside `DocumentRefusal`, which is where the SQL package keeps its
 * equivalent, for two reasons. It needs fewer imports: `idKind` and `ObjectId` are both already in
 * this file, so the only thing that has to be reached for is the refusal, where the other placement
 * would have had to reach for both the collection type and `ObjectId`. And the conversion is a
 * consequence of the inference - `idKindOf` decides what a collection keys on from what was in it,
 * and the code that acts on that decision is easier to keep honest sitting next to it.
 *
 * Shared by both halves of the package rather than private to either, and that sharing is
 * load-bearing: a `getMany` that finds a document and an `update` that does not would be the two
 * halves answering different questions about the same id.
 */
export const idValue = (collection: CollectionInfo, given: string): ObjectId | string | number => {
    if (collection.idKind === 'objectId') {
        if (!ObjectId.isValid(given)) throw new DocumentRefusal(`${given} is not an ObjectId, which is what ${collection.name} keys on`)
        return new ObjectId(given)
    }
    if (collection.idKind === 'number') {
        const value = Number(given)
        if (!Number.isFinite(value)) throw new DocumentRefusal(`${given} is not a number, which is what ${collection.name} keys on`)
        return value
    }
    return given
}

/** An id as text. An ObjectId is its hex string, which is its own canonical form. */
export const idText = (id: unknown): string => (id instanceof ObjectId ? id.toHexString() : String(id))

/**
 * A row shape inferred from documents, and labelled as inferred.
 *
 * Three things make it honest. The object is **open**, so a viewer knows there may be fields it has
 * not been told about. A field seen in some documents and not others is **optional**, which is the
 * literal truth about it. And a field holding different kinds in different documents becomes a
 * **union**, rather than whichever kind happened to come first.
 *
 * Only the top level. A grid draws columns, and inferring a whole nested tree from twenty documents
 * would multiply the guessing by the depth for something nothing currently renders.
 */
const fromSample = (sample: readonly Document[]): TypeNode => {
    const seen = new Map<string, { kinds: Set<string>; count: number }>()
    for (const document of sample)
        for (const [name, value] of Object.entries(document)) {
            const held = seen.get(name) ?? { kinds: new Set<string>(), count: 0 }
            held.kinds.add(kindOfValue(value))
            held.count++
            seen.set(name, held)
        }

    const fields: { [name: string]: FieldNode } = {}
    for (const [name, { kinds, count }] of seen) {
        const options = [...kinds].map(nodeOfKind)
        fields[name] = {
            type: options.length === 1 ? options[0] : { kind: 'union', options },
            ...(count < sample.length ? { optional: true } : {})
        }
    }
    return { kind: 'object', fields, additional: true }
}

const kindOfValue = (value: unknown): string => {
    if (value === null) return 'null'
    if (value instanceof ObjectId) return 'string'
    if (value instanceof Date) return 'date'
    if (value instanceof Uint8Array) return 'bytes'
    if (Array.isArray(value)) return 'array'
    switch (typeof value) {
        case 'string':
            return 'string'
        case 'number':
        case 'bigint':
            return 'number'
        case 'boolean':
            return 'boolean'
        default:
            return 'any'
    }
}

const nodeOfKind = (kind: string): TypeNode => {
    switch (kind) {
        case 'string':
            return { kind: 'string' }
        case 'number':
            return { kind: 'number' }
        case 'boolean':
            return { kind: 'boolean' }
        case 'date':
            return { kind: 'date' }
        case 'bytes':
            return { kind: 'bytes' }
        case 'null':
            return { kind: 'null' }
        // An array's items are not inferred: a grid renders one cell for it either way, and
        // guessing the element type from a sample of a sample is guessing twice.
        case 'array':
            return { kind: 'array', items: { kind: 'any' } }
        default:
            return { kind: 'any' }
    }
}

/**
 * A row shape from a collection's own `$jsonSchema`, which is a declaration rather than a guess.
 *
 * Only the parts that describe a shape. A validator may also carry `minimum`, `pattern` and the
 * rest, and those are rules about what may be *written* - this node never writes, and a viewer
 * drawing a column has no use for them.
 */
const fromJsonSchema = (schema: Document): TypeNode => {
    const properties = (schema.properties ?? {}) as { [name: string]: Document }
    const required = new Set((schema.required ?? []) as string[])
    const fields: { [name: string]: FieldNode } = {}
    for (const [name, property] of Object.entries(properties))
        fields[name] = { type: nodeOfBsonType(property), ...(required.has(name) ? {} : { optional: true }) }
    // Closed only where the schema says so, which is the same statement one level up: a validator
    // that permits extra properties describes documents this shape does not fully cover.
    return { kind: 'object', fields, ...(schema.additionalProperties === false ? {} : { additional: true }) }
}

const nodeOfBsonType = (property: Document): TypeNode => {
    const declared = property.bsonType ?? property.type
    const types = (Array.isArray(declared) ? declared : [declared]).filter((type): type is string => typeof type === 'string')
    const options = types.map((type): TypeNode => {
        switch (type) {
            case 'string':
                return { kind: 'string' }
            case 'int':
            case 'long':
            case 'double':
            case 'decimal':
            case 'number':
                return { kind: 'number' }
            case 'bool':
            case 'boolean':
                return { kind: 'boolean' }
            case 'date':
                return { kind: 'date' }
            case 'binData':
                return { kind: 'bytes' }
            case 'null':
                return { kind: 'null' }
            case 'objectId':
                // A hex string on the wire, which is what this node sends - so the declaration says
                // what a caller will actually receive rather than what MongoDB stores.
                return { kind: 'string' }
            case 'array':
                return { kind: 'array', items: { kind: 'any' } }
            default:
                return { kind: 'any' }
        }
    })
    if (!options.length) return { kind: 'any' }
    return options.length === 1 ? options[0] : { kind: 'union', options }
}

export const resourceOf = (collection: CollectionInfo): RpcDataResource => ({
    path: [collection.name],
    verbs: VERBS,
    shape: 'list',
    ...(collection.row ? { row: collection.row } : {})
})

/**
 * How deep a document is walked on its way to the wire.
 *
 * Bounded because a document is user data and the walk is recursive: a cycle cannot occur in BSON
 * but a pathologically deep document can, and the recursion should stop before the stack does.
 * Exported so the write half can refuse a value deeper than this rather than store one - a value
 * below the bound would be stamped over a `null`, so a precondition taken over it would say nothing
 * about what is actually there.
 */
export const MAX_DOCUMENT_DEPTH = 24

/**
 * A document as it goes on the wire.
 *
 * BSON has types the codec does not: an ObjectId, a Long, a Decimal128. Left alone they would reach
 * MsgPack as objects with internal fields, which is neither what the row type says nor anything a
 * viewer can render - so each becomes the nearest thing that survives the trip, and an ObjectId
 * becomes the same hex string the `ids` beside it carry.
 *
 * Shared with the write half rather than kept private to the reader, and that sharing is
 * load-bearing: a row's stamp is a digest over these values, so a read that normalised differently
 * from the read behind a compare-and-set would produce a precondition that never holds. The two
 * would not disagree loudly either - the stamps would simply never match, every update would answer
 * `conflict`, and the first person to see that would reasonably conclude something else was writing
 * to the collection.
 */
export const wireDocument = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_DOCUMENT_DEPTH) return null
    if (value === null || value === undefined) return null
    if (value instanceof ObjectId) return value.toHexString()
    if (value instanceof Date || value instanceof Uint8Array) return value
    if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    if (Array.isArray(value)) return value.map((item) => wireDocument(item, depth + 1))
    if (typeof value === 'object') {
        // Decimal128, Long, Binary and the rest all carry a toString that says what they are; a
        // plain object has Object.prototype's, which says nothing and is the giveaway.
        const held = value as { _bsontype?: string; toString(): string }
        if (typeof held._bsontype === 'string') return held.toString()
        const mapped: Record<string, unknown> = {}
        for (const [name, held] of Object.entries(value)) mapped[name] = wireDocument(held, depth + 1)
        return mapped
    }
    return value
}
