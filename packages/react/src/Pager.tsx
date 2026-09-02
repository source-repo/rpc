import type { PageControls } from './paging.js'

/**
 * Where you are in a set, and how to move.
 *
 * One component for both halves of the pane, because they page the same way over the same shapes:
 * a collection of a component's own record, and the leaves under a branch of a tree. Two pagers that
 * looked slightly different would be two pagers to keep in step, and a reader would have to learn
 * which one they were looking at.
 *
 * ## What it can say, and what it must not
 *
 * The count of pages is drawn **only where a total made it knowable**. A resource that cannot afford
 * `COUNT(*)` over its predicate, or a subtree walk that stopped when the page filled, answers with
 * no total at all - and a denominator invented for those would be a number somebody trusts. So it
 * says `3` where it cannot count and `3/9` where it can, which is `pageControls`' rule and not this
 * component's; all of that is decided in `pager.ts`, where it can be tested without a browser.
 *
 * The page size is offered here because it belongs to the reader rather than to the resource: what
 * fits on a screen is a fact about the screen. It is the one control here that changes what is
 * *asked* rather than which answer is shown, which is why changing it returns to the first page -
 * page four of fifties is not page four of two hundreds, and staying put would silently move
 * somebody somewhere they did not navigate to.
 */

/** Offered sizes. Small enough to scan, large enough to be worth a round trip, and a big one. */
const SIZES = [25, 50, 100, 250] as const

export const Pager = ({
    page,
    pageSize,
    controls,
    onPage,
    onPageSize,
    showCount = true
}: {
    page: number
    pageSize: number
    controls: PageControls
    onPage: (page: number) => void
    /** Absent leaves the size fixed, which is right where the host decides it. */
    onPageSize?: (size: number) => void
    /** Off where the host already prints it somewhere better - the grid says it in its header. */
    showCount?: boolean
}) => (
    <span className="pager">
        {onPageSize && (
            <select
                className="period"
                value={String(pageSize)}
                onChange={(event) => {
                    onPageSize(Number(event.target.value))
                    onPage(0)
                }}
                title="rows per page"
            >
                {SIZES.map((size) => (
                    <option key={size} value={String(size)}>
                        {size} rows
                    </option>
                ))}
            </select>
        )}
        {controls.paged && (
            <>
                <button className="toggle" disabled={!controls.hasPrevious} onClick={() => onPage(page - 1)} title="previous page">
                    ◂
                </button>
                {/* `2/9` where the pages can be counted, `2` where they cannot - a page number over a
                    total nobody knows would be a made-up denominator. */}
                <span className="muted mono">{controls.position}</span>
                <button className="toggle" disabled={!controls.hasNext} onClick={() => onPage(page + 1)} title="next page">
                    ▸
                </button>
            </>
        )}
        {showCount && <span className="muted">{controls.count}</span>}
    </span>
)
