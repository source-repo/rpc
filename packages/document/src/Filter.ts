import type { RpcFilter, RpcFilterCondition, RpcSort } from '@source-repo/rpc'
import type { Filter, Document } from 'mongodb'

/**
 * The wire's filter language, turned into a MongoDB query.
 *
 * Most of it is easier than the SQL translation, and one part of it is harder in a way that decides
 * how this file is written.
 *
 * **Easier: the semantics already agree.** `$ne` matches a document that lacks the field, which is
 * the in-memory rule's deliberate exception and something SQL has to spend a clause on. The ordered
 * comparisons only match values of the same BSON type as the operand, so `{ age: { $gt: 20 } }`
 * does not match `"abc"` - which is the same refusal to invent an order across kinds that the
 * in-memory implementation makes and that SQL would coerce its way through. Dot paths are native.
 *
 * **Harder: there is nothing to check a field name against.** The SQL node whitelists every field
 * against the columns it introspected, and that whitelist is the defence that matters, because a
 * field name is an identifier and identifiers are not parameterised. A document collection has no
 * such list - a field exists on the documents that happen to have it - and sampling can prove a
 * field is *there*, never that it is not. So the defence here is **structural rather than a
 * lookup**: a field is checked for the shapes that would make it something other than a field name,
 * and anything well-formed is allowed through, because refusing an unsampled field would refuse
 * half of what a document store is for.
 *
 * That is a real capability difference rather than a weaker version of the same thing, and it is
 * declared: this node reaches inside values and the SQL node does not.
 */

export class DocumentRefusal extends Error {
    override readonly name = 'DocumentRefusal'
}

const refuse = (message: string): never => {
    throw new DocumentRefusal(message)
}

/**
 * How deep a path may reach.
 *
 * Not a security bound - a deep path is not dangerous, it is just unlikely - but a shape bound of
 * the same kind the library already puts on filter nesting. Eight is more levels of subdocument
 * than anything anybody browses through a grid, and a path with forty segments is a caller that
 * built it wrongly.
 */
const MAX_PATH_SEGMENTS = 8

/**
 * The field a condition or sort names, as MongoDB will read it.
 *
 * `id` means the document's identity whatever it is stored under, which here is always `_id` - the
 * same rule `fieldOf` applies in memory, where `id` names the row's key rather than a field that
 * happens to share the word.
 *
 * The checks are the whole security surface for a field name, and each one is a shape that would
 * make it something other than a field:
 *
 * - A segment beginning with `$` is an **operator in a field position**. Nothing else in this file
 *   can produce one, so this is the only way one could arrive, and it is refused rather than
 *   escaped because there is no legitimate reading of it.
 * - An empty segment - a leading, trailing or doubled dot - is a path MongoDB reads differently
 *   from how anyone writing it meant, so it is a caller holding it wrong rather than a query.
 * - A NUL is refused on principle: it cannot occur in anything anybody typed, and a name carrying
 *   one is a name that has been through something it should not have been.
 */
export const fieldFor = (field: string | undefined, what: string): string => {
    if (field === undefined)
        // In memory an absent field compares the row itself, which is meaningful for a record of
        // numbers and meaningless for a document: there is no value the whole document could be
        // compared to.
        return refuse(`${what} over a collection names a field; there is no value to compare a whole document to`)
    if (field === 'id' || field === '_id') return '_id'
    const segments = field.split('.')
    if (segments.length > MAX_PATH_SEGMENTS) return refuse(`${what} names a path ${segments.length} deep; ${MAX_PATH_SEGMENTS} is the most this node will follow`)
    for (const segment of segments) {
        if (!segment) return refuse(`${what} names ${JSON.stringify(field)}, which has an empty path segment`)
        if (segment.startsWith('$')) return refuse(`${what} names ${JSON.stringify(field)}, and a field beginning with $ is an operator rather than a field`)
        if (segment.includes('\u0000')) return refuse(`${what} names a field containing a NUL`)
    }
    return field
}

/**
 * A literal, with every regular-expression metacharacter disarmed.
 *
 * This is the safety half of `contains` and `startsWith`, and the failure it prevents is the one
 * `DataProvider.ts` names in its own comment: the provider this design came from compiled an
 * operator's search box straight into `new RegExp`, which is harmless in a browser over an
 * in-memory store and is a stall on a plant server. An unescaped operand here would be exactly
 * that, one layer down - a user-supplied regular expression evaluated per document.
 *
 * Escaped rather than rejected, because `.` and `*` and `(` are characters people have in their
 * data and type into search boxes, and a filter that refuses them would be a filter that cannot
 * find half of what is there.
 */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const condition = (given: RpcFilterCondition): Filter<Document> => {
    const field = fieldFor(given.field, 'a filter condition')
    const { op, operand } = given

    if (operand === null) {
        // `{ field: null }` would match a document that *lacks* the field as well as one that holds
        // an explicit null, and the in-memory rule keeps those apart: a missing value matches
        // nothing except under `ne`. `$type: 'null'` is the precise reading.
        if (op === 'eq') return { [field]: { $type: 'null' } }
        if (op === 'ne') return { [field]: { $not: { $type: 'null' } } }
        return refuse(`${op} against null is not a comparison - use eq or ne to test for a missing value`)
    }

    switch (op) {
        case 'eq':
            return { [field]: { $eq: operand } }
        // Matches a document that lacks the field, which is what the in-memory rule asks for and
        // what `$ne` already does - the one place this translation is simpler than the SQL one.
        case 'ne':
            return { [field]: { $ne: operand } }
        case 'lt':
            return { [field]: { $lt: operand } }
        case 'lte':
            return { [field]: { $lte: operand } }
        case 'gt':
            return { [field]: { $gt: operand } }
        case 'gte':
            return { [field]: { $gte: operand } }
        case 'startsWith':
            if (typeof operand !== 'string') return refuse(`startsWith compares text, and ${JSON.stringify(operand)} is a ${typeof operand}`)
            return { [field]: { $regex: `^${literal(operand)}` } }
        case 'contains':
            if (typeof operand !== 'string') return refuse(`contains compares text, and ${JSON.stringify(operand)} is a ${typeof operand}`)
            return { [field]: { $regex: literal(operand) } }
        default:
            return refuse(`${String(op)} is not a comparison this node serves`)
    }
}

/**
 * A whole filter, as one query document.
 *
 * No depth guard here: the library bounds a filter at eight levels and sixty-four nodes before it
 * reaches any component, and a second limit in a second place is one that drifts from the first.
 */
export const queryFor = (filter: RpcFilter): Filter<Document> => {
    const group = filter as { all?: readonly RpcFilter[]; any?: readonly RpcFilter[] }
    if (group.all) return { $and: group.all.map(queryFor) }
    if (group.any) return { $or: group.any.map(queryFor) }
    return condition(filter as RpcFilterCondition)
}

export interface SortField {
    readonly field: string
    readonly direction: 1 | -1
}

/**
 * The order to read a page in, always ending at `_id`.
 *
 * The tiebreaker is not a refinement: no store guarantees an order among documents its sort cannot
 * tell apart, so paging by skip over a non-unique sort will show one document on two pages and
 * never show another - silently, and more often the larger the collection.
 */
export const sortFor = (sort: RpcSort | undefined): readonly SortField[] => {
    const direction: 1 | -1 = sort?.order === 'DESC' ? -1 : 1
    if (sort?.field === undefined) return [{ field: '_id', direction }]
    const field = fieldFor(sort.field, 'a sort')
    if (field === '_id') return [{ field, direction }]
    // Ascending regardless of the caller's direction: the tiebreaker only has to make the order
    // total, and which end it starts from is not something anybody asked about.
    return [
        { field, direction },
        { field: '_id', direction: 1 }
    ]
}

/**
 * The name of the field added while sorting to hold "this document has no value here".
 *
 * MongoDB sorts missing and null before everything, and the in-memory rule is the opposite: an
 * absent value sorts after everything ascending, and descending inverts the whole comparison, so
 * **missing is the greatest value**. There is no `NULLS LAST` to ask for, so the ordering is done
 * the way MySQL has to do it - by a computed term placed ahead of the column - which here means an
 * aggregation stage rather than a plain `find`.
 *
 * Deliberately unlikely rather than short: it is added to every document on its way through the
 * pipeline, and a collision with a real field would silently reorder the answer.
 */
export const ABSENT_FIELD = '__sourceRpcAbsent'
