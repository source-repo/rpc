/**
 * One value, in a form two of them can be compared as text.
 *
 * Three things in this library have to decide whether two values are *the same value*, and they all
 * arrive at the same question from different directions:
 *
 * - **A row stamp** digests the state a row was read in, so a caller can write only if nothing moved
 *   underneath. See `DataWrites.ts`.
 * - **A projection comparison** decides whether a re-subscribe asks for what the old one asked for,
 *   or for something else. See `sameProjection`, in the client and the server both.
 * - **A cache key** decides whether two `$data` requests are one question. See `@source-repo/query`.
 *
 * They were three encoders, two of them `JSON.stringify`, and that is why this file exists rather
 * than the obvious factoring: `JSON.stringify` answers **key insertion order**, which nothing
 * promises. A JSON column round-trips through a driver, a document store hands back a `BSON` object,
 * and a caller builds an options object in whatever order its code reads - so the same value written
 * twice compares unequal, and each of the three fails differently and quietly. The stamp reports a
 * conflict on a row nobody touched. The projection comparison re-subscribes, spending a targeted
 * snapshot on a slow link to receive what it already had. The cache key misses, and asks the plant
 * again for a page it is holding.
 *
 * One encoder, so the three cannot drift - and the stamp's pinned fixtures in `DataWrites.test.ts`
 * gate all three, because a one-character change here makes every stamp a caller is holding answer
 * *conflict*.
 */

/**
 * The canonical form of one value.
 *
 * **Tagged by kind rather than stringified**, because `1` and `'1'` are different states of a column
 * and an encoding that could not tell them apart would report no change across a type change. Dates
 * and byte arrays are given canonical forms rather than left to `JSON.stringify`, which turns the
 * first into an ISO string and the second into an object of numeric keys - both stable enough by
 * accident today and neither promised by anything.
 *
 * **Object keys are sorted**, which is the one that matters in practice and the reason above.
 *
 * **A key whose value is `undefined` is omitted**, so an absent option and an explicit `undefined`
 * are the same value. That is a claim about all three callers rather than a convenience for one.
 * `{ offset: undefined }` and `{}` describe the same subscription, and treating them as different
 * costs a re-subscribe; `{ filter: undefined }` and `{}` are the same question, and treating them as
 * different costs a round trip on the link this library exists for. It is also the *stamp's* answer:
 * a driver that round-trips a JSON column through JSON drops the key, and one that hands back a live
 * object keeps it as `undefined` - digesting those differently reports a conflict on a row nobody
 * touched, which is the same failure key order produces and is fixed the same way.
 *
 * Total, deliberately: a function or a symbol reaching here is a caller holding it wrong rather than
 * a value a store handed back, and describing it keeps this from throwing inside a precondition.
 */
export const canonicalValue = (value: unknown): unknown => {
    if (value === null || value === undefined) return ['n']
    if (typeof value === 'boolean') return ['b', value]
    if (typeof value === 'number') return ['d', Number.isFinite(value) ? value : String(value)]
    if (typeof value === 'bigint') return ['i', value.toString()]
    if (typeof value === 'string') return ['s', value]
    if (value instanceof Date) return ['t', value.toISOString()]
    if (value instanceof Uint8Array) return ['y', Array.from(value)]
    // An array's order is part of its value - a page of rows in a different order is a different
    // page - so this is the one place order is kept rather than sorted away.
    if (Array.isArray(value)) return ['a', value.map(canonicalValue)]
    if (typeof value === 'object')
        return [
            'o',
            Object.keys(value as Record<string, unknown>)
                .sort()
                .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
                .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])])
        ]
    return ['?', String(value)]
}

/**
 * The canonical text of one value: what two of them are compared as, and what a digest is taken of.
 *
 * `JSON.stringify` is safe *here* because it is stringifying the canonical form rather than the
 * value - every object in it is an array, so nothing is left for key order to decide.
 */
export const canonicalText = (value: unknown): string => JSON.stringify(canonicalValue(value))
