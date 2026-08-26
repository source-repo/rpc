import { useMemo } from 'react'
import type { RpcSourceBinding } from '@source-repo/diagnostics/catalogue'
import type { ValueSource } from './ValueTree'

/**
 * The component's own source, with its live values beside the lines that declare them.
 *
 * The oldest way of looking at a machine, and the one a PLC has always had: the program on screen
 * with what each thing currently is written next to it. What makes it possible here without a
 * debugger is that the values are **already** being observed - the panel is subscribed, `authorize()`
 * has already ruled, the projection has already narrowed - so the only thing the node had to add is
 * where each path is written, which is static and free.
 *
 * **Nothing is drawn unless the source matches what is running.** A value positioned by a line
 * number from a file that has since been edited is worse than no value: it is a number somebody will
 * act on, sitting beside a declaration that is no longer the one it came from.
 */

/** How many characters of a summary a line will carry before it stops being a line. */
const MAX_INLINE = 60

/**
 * One value, small enough to sit at the end of a line.
 *
 * Objects and arrays become summaries rather than being spelled out - a line is not a place for a
 * record of three hundred tags - and the summary says what was left out rather than trailing off,
 * because "12 more" is information and an ellipsis is not.
 */
const inline = (value: unknown): string => {
    if (value === undefined) return '—'
    if (value === null) return 'null'
    if (typeof value === 'string') return value.length > MAX_INLINE ? `"${value.slice(0, MAX_INLINE)}" +${value.length - MAX_INLINE}` : `"${value}"`
    if (typeof value !== 'object') return String(value)
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return `[${value.length}]`
    const keys = Object.keys(value as Record<string, unknown>)
    // A shallow preview and then the count, which is what tells a reader whether to open it.
    const preview = keys
        .slice(0, 3)
        .map((key) => `${key}: ${inline((value as Record<string, unknown>)[key])}`)
        .join(', ')
    return keys.length > 3 ? `{ ${preview}, +${keys.length - 3} }` : `{ ${preview} }`
}

export interface SourceDocument {
    readonly fileId: string
    readonly text: string
}

export const SourceView = ({
    document,
    bindings,
    source,
    stale,
    refusal
}: {
    document: SourceDocument
    /** Where this component's paths are declared, as the node's own build recorded them. */
    bindings: readonly RpcSourceBinding[]
    /** The live snapshot the panel is already subscribed to. This view opens no channel of its own. */
    source: ValueSource
    /** Whether the feed has gone quiet, so every value on screen is last-known rather than current. */
    stale: boolean
    /** Why overlays are not being drawn, when they are not. A sentence, because somebody is reading it. */
    refusal?: string
}) => {
    const lines = useMemo(() => document.text.split('\n'), [document.text])
    // One pass rather than a filter per rendered line: a source file is a few hundred lines and a
    // component has a few dozen paths, and doing it per line is that product on every snapshot.
    const byLine = useMemo(() => {
        const map = new Map<number, RpcSourceBinding[]>()
        for (const binding of bindings) {
            if (binding.fileId !== document.fileId) continue
            for (const span of binding.spans) {
                const held = map.get(span.startLine) ?? []
                held.push(binding)
                map.set(span.startLine, held)
            }
        }
        return map
    }, [bindings, document.fileId])

    return (
        <div className="source-view">
            {refusal && (
                <p className="uncertain">
                    Values are not being shown: {refusal}.
                    <span className="muted">The file below is what this viewer has, not what is running.</span>
                </p>
            )}
            <pre className={`source-listing${refusal ? ' unbound' : ''}`}>
                {lines.map((text, index) => {
                    const line = index + 1
                    const here = refusal ? undefined : byLine.get(line)
                    return (
                        <div className="source-line" key={line}>
                            <span className="source-number">{line}</span>
                            <span className="source-text">{text || ' '}</span>
                            {here?.map((binding) => {
                                // A field the source says holds something sensitive is marked rather
                                // than drawn. Read-only visibility is not harmless: a value can be a
                                // credential or somebody's name, and the person who knows that is
                                // the one who wrote the declaration.
                                if (binding.sensitivity)
                                    return (
                                        <span key={binding.sourceRpcPath} className="source-value redacted" title={`${binding.sourceRpcPath}: withheld as ${binding.sensitivity}`}>
                                            {binding.sensitivity}
                                        </span>
                                    )
                                return (
                                    <span
                                        key={binding.sourceRpcPath}
                                        className={`source-value${stale ? ' stale' : ''}`}
                                        title={`${binding.sourceRpcPath}: ${binding.declaredType}${stale ? ' — last known, the feed has gone quiet' : ''}`}
                                    >
                                        {inline(source.read(binding.sourceRpcPath.split('.')))}
                                    </span>
                                )
                            })}
                        </div>
                    )
                })}
            </pre>
        </div>
    )
}
