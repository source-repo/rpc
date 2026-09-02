import { describe, expect, test } from 'vitest'
import { pageControls } from './paging.js'

/**
 * Paging a resource that could not afford to count itself.
 *
 * The library-served path always reports a total, because a record held in memory produces the
 * matched set and the count is its length. A table is two questions, and a store-backed resource may
 * answer `hasMore` instead - so every one of these assertions is about the console still working
 * when the number it used to draw a pager from simply is not there.
 */

describe('with a count', () => {
    const counted = (page: number, rows: number, total: number) =>
        pageControls(page, 50, { ids: Array.from({ length: rows }, (_, at) => String(at)), total }, false)

    test('says how many there are and how many pages that is', () => {
        const first = counted(0, 50, 300)
        expect(first.count).toBe('50 of 300')
        expect(first.position).toBe('1/6')
        expect(first.hasNext).toBe(true)
        expect(first.hasPrevious).toBe(false)
    })

    test('and stops at the last page', () => {
        const last = counted(5, 50, 300)
        expect(last.position).toBe('6/6')
        expect(last.hasNext).toBe(false)
        expect(last.hasPrevious).toBe(true)
    })

    test('a set that fits on one page needs no pager at all', () => {
        expect(counted(0, 12, 12).paged).toBe(false)
    })
})

describe('with only hasMore', () => {
    const uncounted = (page: number, rows: number, hasMore: boolean) =>
        pageControls(page, 50, { ids: Array.from({ length: rows }, (_, at) => String(at)), hasMore }, false)

    test('falls back to next and previous, with no denominator invented', () => {
        const first = uncounted(0, 50, true)
        expect(first.count).toBe('50 rows')
        expect(first.pages).toBeUndefined()
        expect(first.position).toBe('1')
        expect(first.hasNext).toBe(true)
        expect(first.hasPrevious).toBe(false)
        expect(first.paged).toBe(true)
    })

    test('and the last page says so without knowing which number it is', () => {
        const last = uncounted(3, 20, false)
        expect(last.position).toBe('4')
        expect(last.hasNext).toBe(false)
        expect(last.hasPrevious).toBe(true)
    })

    test('a resource that says nothing about more is not paged forward on a guess', () => {
        const silent = pageControls(0, 50, { ids: ['a'] }, false)
        expect(silent.hasNext).toBe(false)
        expect(silent.paged).toBe(false)
    })
})

describe('the three nothings, which an operator has to be able to tell apart', () => {
    test('an empty collection, a filter that matched none of it, and a page past the end', () => {
        expect(pageControls(0, 50, { ids: [], total: 0 }, false).emptiness).toBe('empty')
        expect(pageControls(0, 50, { ids: [], total: 0 }, true).emptiness).toBe('nothing matches')
        expect(pageControls(3, 50, { ids: [], total: 60 }, false).emptiness).toBe('past the end')
    })

    test('and the same three without a count, which is the case the optional total exists for', () => {
        // This is the whole argument against answering `total: 0` when a store did not count. Page
        // five of a 60-row table returns no rows and nothing beyond - identical to an empty
        // collection - and a console reading a missing count as zero would print "nothing matches"
        // over a filter that matched sixty. The page number is what tells them apart.
        expect(pageControls(5, 50, { ids: [], hasMore: false }, true).emptiness).toBe('past the end')
        expect(pageControls(0, 50, { ids: [], hasMore: false }, true).emptiness).toBe('nothing matches')
        expect(pageControls(0, 50, { ids: [], hasMore: false }, false).emptiness).toBe('empty')
    })

    test('a page with rows on it is not any of them', () => {
        expect(pageControls(0, 50, { ids: ['a'], hasMore: true }, false).emptiness).toBeUndefined()
    })
})

test('before the first answer there is nothing to page and nothing to report', () => {
    const asking = pageControls(0, 50, undefined, false)
    expect(asking.count).toBe('asking…')
    expect(asking.paged).toBe(false)
    expect(asking.emptiness).toBeUndefined()
})
