import { useState } from 'react'
import { ArgumentField, FieldState, initialText, toValue } from './ArgumentField'
import { isOptional, type ServerDescription } from './types'
import type { DescribedAction, DescribedMethod } from './types'

/**
 * A row action that needs saying more than which row.
 *
 * The declaration carries one fact - this method is about this row - and the signature carries the
 * rest, because `describe()` published it long before actions existed. So the row fills the first
 * parameter and this asks for what is left: `write(nodeId, value)` becomes a box for the value with
 * the node already in it.
 *
 * ## The bound argument is shown, not implied
 *
 * The first field is drawn read-only rather than left out. Nothing can check from the outside that a
 * method's first parameter really is the row - it is the author's claim, the same way `appliesTo`
 * is - and the difference between a claim that is wrong and a claim that is wrong *and invisible* is
 * an operator watching `write` send a node id into a parameter called `recipient`. It costs one line
 * and it is the only place the claim can be seen.
 *
 * ## Why this is not `MethodPanel`
 *
 * That panel is for exploring a method: presets, timings, repeat counts, copy-as-CLI. This is for
 * doing one thing to one row, and the two would fight - a preset is about a method, and half of
 * these arguments belong to whichever row happens to be selected. They share what is actually
 * shared, which is the field widgets and the text-to-value conversion.
 */

export const ActionForm = ({
    action,
    method,
    subject,
    subjectLabel,
    types,
    busy,
    refused,
    onRun,
    onCancel
}: {
    action: DescribedAction
    /** The method as the peer describes it, or absent where it declares no signature. */
    method: DescribedMethod | undefined
    /** What the row is, as the argument that will be sent. */
    subject: string
    /** What to call the row on screen, where it has a name a person would recognise. */
    subjectLabel?: string
    types: ServerDescription['types']
    busy: boolean
    /** What the peer said when it would not do it. Held here so the arguments stay beside it. */
    refused?: string
    onRun: (rest: unknown[]) => void
    onCancel: () => void
}) => {
    const params = method?.params ?? []
    const names = method?.paramNames ?? params.map((_, index) => `argument ${index}`)
    // Everything after the row. A method taking only the row has none, and then this panel is here
    // because the action asked to be confirmed rather than because anything is missing.
    const rest = params.slice(1)
    const restNames = names.slice(1)
    const [fields, setFields] = useState<FieldState[]>(() => rest.map((type) => ({ text: initialText(type, types), include: !isOptional(type) })))
    const [problem, setProblem] = useState<string>()

    const run = () => {
        try {
            // Trailing optionals left out are not sent, which is what optional means - the same rule
            // the method panel follows, because it is a fact about calls rather than about a panel.
            const args = rest.map((type, index) => (fields[index].include ? toValue(fields[index].text, type, types) : undefined))
            while (args.length && args[args.length - 1] === undefined && isOptional(rest[args.length - 1])) args.pop()
            setProblem(undefined)
            onRun(args)
        } catch (e) {
            setProblem((e as { message?: string }).message ?? String(e))
        }
    }

    return (
        <div className="action-form">
            <div className="action-form-head">
                <strong className="mono">{action.label ?? action.method}</strong>
                <span className="muted">
                    {action.method}({names.join(', ')})
                </span>
                <button className="toggle" onClick={onCancel} title="leave the row alone">
                    cancel
                </button>
            </div>
            <dl className="action-bound">
                <dt className="muted">{names[0] ?? 'row'}</dt>
                <dd className="mono" title={subject}>
                    {subjectLabel && subjectLabel !== subject ? `${subjectLabel} — ${subject}` : subject}
                </dd>
            </dl>
            {rest.map((type, index) => (
                <ArgumentField
                    key={index}
                    name={restNames[index]}
                    type={type}
                    types={types}
                    state={fields[index]}
                    onChange={(next) => setFields(fields.map((field, at) => (at === index ? next : field)))}
                />
            ))}
            {/* What this form could not build, and what the peer would not do. Both are answers to
                the same press and both belong here rather than somewhere else on the page. */}
            {problem && <p className="component-error">{problem}</p>}
            {!problem && refused && <p className="component-error">{refused}</p>}
            <div className="action-form-foot">
                <button className="primary" disabled={busy} onClick={run}>
                    {busy ? 'sending…' : (action.label ?? action.method)}
                </button>
            </div>
        </div>
    )
}
