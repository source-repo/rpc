/**
 * What a pager can say about a page, when it may not know how many there are.
 *
 * A record held in memory always reports `total`: the matched set *is* the answer, so its length is
 * a byproduct that costs nothing. A table is two questions - the page comes off an index and
 * `COUNT(*)` over the same predicate walks it, routinely most of the request - so a store-backed
 * resource may answer `hasMore` instead, and the grid has to page on that alone.
 *
 * Pulled out of the component because it is the whole of the decision and none of the rendering,
 * and because the case that decides its shape is invisible in a screenshot: **an absent total is
 * not zero.** A page past the end of an uncounted set returns no rows and nothing beyond it, which
 * is exactly what an empty collection returns - so a grid that read a missing count as zero would
 * tell an operator "nothing matches" over a filter that matched sixty.
 */

export interface PagedAnswer {
    readonly ids: readonly string[]
    /** Absent means unknown. Never read it as zero. */
    readonly total?: number
    readonly hasMore?: boolean
}

export interface PageControls {
    /** How many pages there are, where a count made that knowable. */
    readonly pages?: number
    readonly hasNext: boolean
    readonly hasPrevious: boolean
    /** Whether to draw a pager at all: only where there is somewhere to go. */
    readonly paged: boolean
    /** What the pager prints - `2/9` where the pages can be counted, `2` where they cannot. */
    readonly position: string
    /** What the header prints - `50 of 300` counted, `50 rows` uncounted, `asking…` before an answer. */
    readonly count: string
    /** Which of the three nothings an empty page is, or undefined where the page has rows. */
    readonly emptiness?: 'past the end' | 'nothing matches' | 'empty'
}

export const pageControls = (page: number, pageSize: number, answer: PagedAnswer | undefined, filtered: boolean): PageControls => {
    const total = answer?.total
    const pages = total !== undefined && pageSize > 0 ? Math.ceil(total / pageSize) : undefined
    // Known exactly from a count, said directly by a resource that could not afford one, and false
    // before the first answer arrives - at which point there is no pager to draw anyway.
    const hasNext = pages !== undefined ? page + 1 < pages : (answer?.hasMore ?? false)
    const hasPrevious = page > 0

    return {
        pages,
        hasNext,
        hasPrevious,
        paged: hasPrevious || hasNext,
        position: pages !== undefined ? `${page + 1}/${pages}` : String(page + 1),
        count: answer === undefined ? 'asking…' : total !== undefined ? `${answer.ids.length} of ${total}` : `${answer.ids.length} rows`,
        emptiness:
            answer === undefined || answer.ids.length > 0
                ? undefined
                : // Past the end is the only one of the three that can happen on a page other than
                  // the first, so where there is no count the page number answers what the total
                  // would have.
                  (total !== undefined ? total > 0 : hasPrevious)
                  ? 'past the end'
                  : filtered
                    ? 'nothing matches'
                    : 'empty'
    }
}
