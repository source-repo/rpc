/** One branch's own record, shown separately from the leaves beneath that branch. */

export interface ScopeSummaryField {
    readonly name: string
    readonly value: unknown
}

/** Kept outside React so non-visual tests can pin the generic record rule. */
export const scopeSummaryFields = (value: unknown): readonly ScopeSummaryField[] =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>).map(([name, field]) => ({ name, value: field }))
        : []

const shown = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
}

/**
 * Metadata about the selected scope, independent of what kind of branch supplied it.
 *
 * A branch is both a place and, sometimes, a useful record. The tree uses its identity and label;
 * the grid asks for its descendant leaves; this section keeps the record itself visible without
 * turning it into a leaf or requiring a renderer for folders, components, interfaces, or nodes.
 */
export const ScopeSummary = ({ label, value }: { label: string; value: unknown }) => {
    const fields = scopeSummaryFields(value)
    return (
        <section className="scope-summary" aria-label={`Selected scope ${label}`}>
            <div className="scope-summary-head">
                <span className="muted">scope</span>
                <strong>{label}</strong>
            </div>
            {fields.length ? (
                <dl className="scope-summary-fields">
                    {fields.map((field) => (
                        <div className="scope-summary-field" key={field.name}>
                            <dt className="muted">{field.name}</dt>
                            <dd>{shown(field.value)}</dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <div className="scope-summary-scalar mono">{shown(value)}</div>
            )}
        </section>
    )
}
