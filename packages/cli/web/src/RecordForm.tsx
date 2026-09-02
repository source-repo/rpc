import { useState } from 'react'
import { ArgumentField, FieldState, toValue } from './ArgumentField'
import type { ServerDescription, TypeNode } from './types'

/**
 * One row, changed.
 *
 * The write contract has been complete and unused by any browser since it was written: `create`,
 * `update` and `delete` with per-column allow-lists, refusals that are outcomes rather than
 * exceptions, and a precondition on every write. This draws the `update` half of it.
 *
 * ## The stamp is the point, not a detail
 *
 * `update` takes the stamp the row was read under, and the peer refuses if the row has moved since.
 * That is what makes two people editing one row a *visible outcome* rather than a silent lost
 * update - and it is why the row is read through the write surface's own `getOne` rather than taken
 * from the table beside it. A stamp minted by a different question a minute ago is a precondition
 * that has stopped meaning anything.
 *
 * A conflict deliberately comes back with **no new stamp**, and this deliberately does not offer to
 * retry with one. Retrying against a stamp the peer just handed over is compare-and-set comparing
 * with itself - a blind overwrite one click away. Somebody who means to proceed reads the row again
 * and decides again, which is what the button offers.
 *
 * ## Only what changed
 *
 * The patch carries the fields somebody actually edited. Sending every offered field would claim
 * authorship of values nobody touched, and against a rule that permits two columns of a table it
 * would be refused for a field the form only displayed.
 */

/** The current value as the text an input starts from. A row's value, not a type's skeleton. */
const textOf = (value: unknown): string => {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
}

export type WriteOutcome = { status: 'ok' } | { status: 'missing' } | { status: 'conflict' } | { status: 'refused'; message: string }

export const RecordForm = ({
    resource,
    id,
    name,
    fields,
    row,
    shape,
    types,
    busy,
    outcome,
    onSubmit,
    onReread,
    onCancel
}: {
    /** What is being changed, for the heading - the resource, and the row within it. */
    resource: string
    id: string
    /** What the row is called, where the resource said which field names it. */
    name?: string
    /** The fields to offer, already narrowed to what `writable()` permits and ordered by the node. */
    fields: readonly string[]
    /** The row as the write surface read it, which is the state the stamp names. */
    row: Record<string, unknown>
    /**
     * The shape `writable()` declared for the columns it permits, not the read resource's row.
     *
     * The difference is not cosmetic: the write side says `name` is required and `city` is
     * nullable, which is what the *rule* permits, while the read row describes what the table
     * holds. A form built from the second would offer to clear a column the first will not have
     * cleared, and the refusal would arrive after somebody had typed.
     */
    shape?: TypeNode
    types: ServerDescription['types']
    busy: boolean
    outcome?: WriteOutcome
    onSubmit: (patch: Record<string, unknown>) => void
    onReread: () => void
    onCancel: () => void
}) => {
    const [held, setHeld] = useState<Record<string, FieldState>>(() => Object.fromEntries(fields.map((field) => [field, { text: textOf(row[field]), include: true }])))
    const [problem, setProblem] = useState<string>()

    const typeFor = (field: string): TypeNode | undefined => (shape?.kind === 'object' ? shape.fields[field]?.type : undefined)
    const changed = fields.filter((field) => held[field]?.text !== textOf(row[field]))

    const submit = () => {
        try {
            const patch = Object.fromEntries(changed.map((field) => [field, toValue(held[field].text, typeFor(field), types)]))
            setProblem(undefined)
            onSubmit(patch)
        } catch (e) {
            setProblem((e as { message?: string }).message ?? String(e))
        }
    }

    return (
        <div className="record-form">
            <div className="action-form-head">
                <strong className="mono">edit</strong>
                <span className="muted">
                    {resource} · {name ?? id}
                </span>
                <button className="toggle" onClick={onCancel} title="leave the row as it is">
                    cancel
                </button>
            </div>
            {fields.map((field) => (
                <ArgumentField key={field} name={field} type={typeFor(field)} types={types} state={held[field]} onChange={(next) => setHeld({ ...held, [field]: next })} />
            ))}
            {problem && <p className="component-error">{problem}</p>}
            {outcome?.status === 'refused' && <p className="component-error">{outcome.message}</p>}
            {outcome?.status === 'missing' && <p className="component-error">there is no longer a row with this id, and nothing was written</p>}
            {outcome?.status === 'conflict' && (
                <p className="component-error">
                    this row changed since it was read, and nothing was written —{' '}
                    <button className="toggle" onClick={onReread}>
                        read it again
                    </button>
                </p>
            )}
            <div className="action-form-foot">
                <span className="muted">{changed.length ? `${changed.length} field${changed.length === 1 ? '' : 's'} changed` : 'nothing changed yet'}</span>
                <button className="primary" disabled={busy || !changed.length} onClick={submit}>
                    {busy ? 'sending…' : 'save'}
                </button>
            </div>
        </div>
    )
}
