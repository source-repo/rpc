import type { RpcGetOneResult } from '@source-repo/rpc'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import { useRpcData } from './data'

/**
 * One row, opened.
 *
 * The counterpart to a column: a list answers what a row looks like *among its siblings* - the four
 * fields worth reading down a page - and this answers what it looks like *on its own*, which for a
 * serial port or a drive is twenty fields no table has room for. Both come from the same resource
 * and the same declared row type; what differs is which of its fields the peer bothers to populate.
 *
 * ## Why this is not the object panel
 *
 * `ObjectPanel` draws what an *aspects* provider returns from `openObject`: content blocks, links to
 * other objects, bindings saying how a thing can be reached. Those are the things a document has,
 * and they arrive over a protocol an ordinary component does not implement. This draws what any
 * component with a data resource can answer, which is a record - and that is the whole point of
 * serving `getOne` at all. A node had to become an aspect provider to have a detail view, and a rack
 * of serial ports is not a structure of a plant; it is a table with more columns than fit.
 *
 * ## Watched, not fetched once
 *
 * Through the same cache as the grid beside it, on the same period. A document does not change while
 * somebody reads it, so `ObjectPanel` opens once; a port's error count changes exactly while
 * somebody is looking at it, which is usually why they opened it.
 */

/** A value in a row of fields. Objects and arrays are flattened rather than dropped. */
const shown = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value))

const isRecord = (value: unknown): value is { [field: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value)

export const RecordPanel = ({
    cache,
    question,
    id,
    period,
    columns,
    onClose
}: {
    cache: RpcDataCache
    /**
     * The question that opens this row, built by the host exactly as `branchQuestion` is.
     *
     * Named by the caller rather than assembled here, for the reason every other question in this
     * pane is: what a peer is called and how it is reached belongs to whoever holds the link, and a
     * panel that built its own would be a second place addressing has to be right.
     */
    question: RpcQuestion
    /** The row being opened, for the heading - the same id the question carries. */
    id: string
    period: number | undefined
    /**
     * What the table beside this already shows, so those fields can be marked rather than repeated
     * in a different order. Not used to hide them: a reader comparing the panel against the row it
     * came from should find every field in both.
     */
    columns?: readonly string[]
    onClose?: () => void
}) => {
    const { data, error, fetching } = useRpcData<RpcGetOneResult>(cache, question, period)

    const row = data?.data
    const fields = isRecord(row) ? Object.entries(row) : undefined
    const inTable = new Set(columns ?? [])

    return (
        <div className="record-panel">
            <div className="record-head">
                <span className="record-id mono">{id}</span>
                {fetching && !data && <span className="muted">reading…</span>}
                {onClose && (
                    <button className="toggle record-close" onClick={onClose} title="close">
                        ×
                    </button>
                )}
            </div>
            {error && <p className="component-error">{error}</p>}
            {/* The one answer that is neither a row nor a failure. `getOne` leaves `data` out when
                nothing has that id, because a row can be removed between the list that named it and
                the click that opened it - a race nobody can avoid, and not a fault to report as
                one. Said plainly, so an operator knows to go back rather than to retry. */}
            {data && row === undefined && <p className="muted">there is no longer a row with this id</p>}
            {fields && (
                <dl className="object-fields">
                    {fields.map(([name, value]) => (
                        <div className={inTable.has(name) ? 'object-field in-table' : 'object-field'} key={name}>
                            <dt className="muted">{name}</dt>
                            <dd>{shown(value)}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {/* A row may be a primitive - a record of numbers is a perfectly good resource - so the
                panel has to draw one rather than assume every row is an object with fields. */}
            {row !== undefined && !fields && <p className="record-scalar mono">{shown(row)}</p>}
        </div>
    )
}
