import { useEffect, useState } from 'react'
import { navigable } from './navigable.js'

/**
 * One object of an aspect provider, opened.
 *
 * The tree beside this draws placements; this draws the thing itself. Opening is a call rather than
 * a subscription because a document is not a value that changes under you - it changes when somebody
 * edits it, which is a different event and a `rescan` away.
 *
 * ## Content is shown, not rendered
 *
 * Markdown arrives as Markdown and is displayed **as written**. That is a deliberate limit rather
 * than an unfinished feature: rendering it means turning text from another peer into markup in this
 * page, which is a sanitizing decision with a security boundary attached, and the aspects design is
 * explicit that a viewer runs no code a node supplied. When a renderer arrives it will be one this
 * console installs locally and an object may *request* - never one an object can provide.
 *
 * So the honest thing to draw today is the source, in a monospace block, with the reader left in no
 * doubt about which they are looking at.
 */

export interface Ref {
    provider: { peer: string; instance: string }
    resource: string[]
    id: string
}

export interface Block {
    kind: 'markdown' | 'code' | 'attachment'
    id: string
    markdown?: string
    code?: string
    language?: string
    label?: string
    href?: string
}

export interface Link {
    id: string
    target: Ref
    label?: string
    relation?: string
}

export interface Binding {
    kind: string
    role: string
    target: { type: 'rpc'; ref: { peer: string; instance: string } } | { type: 'external'; system: string; id: string; endpoint?: string }
    fields?: Record<string, unknown>
}

export interface Opened {
    ref: Ref
    kind: string
    title: string
    summary?: string
    fields?: Record<string, unknown>
    origin?: { system?: string; updatedAt?: string; retrievedAt?: string }
    content?: Block[]
    links?: Link[]
    bindings?: Binding[]
}

export interface Where {
    target: Ref
    aspectId?: string
    occurrenceId?: string
    inherited: boolean
    fallbackUsed?: 'target-default' | 'canonical'
}

/** What the panel needs from the peer. Supplied, so this component opens nothing itself. */
export interface ObjectAccess {
    open(target: Ref): Promise<Opened>
    follow(link: Link, from: Where | undefined): Promise<Where | { refused: string }>
}

const isRefused = (answer: Where | { refused: string }): answer is { refused: string } => 'refused' in answer

/** A value in a row of fields. Objects and arrays are flattened rather than dropped. */
const shown = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value))


/**
 * Where a binding points, in one line.
 *
 * The system's own name for the thing, because that is what somebody would paste into the tool that
 * understands it.
 */
const bindingTarget = (target: Binding['target']): string =>
    target.type === 'rpc' ? `${target.ref.peer} / ${target.ref.instance}` : `${target.system} ${target.id}`

const Content = ({ block }: { block: Block }) => {
    if (block.kind === 'attachment') {
        const address = navigable(block.href)
        return (
            <p className="object-block">
                {/* A link only where the address is one the browser may be handed. Anything else is
                    shown as the text it is: a reader can still see what the peer published, and
                    nothing in this page will act on it. */}
                {address ? (
                    <a href={address} target="_blank" rel="noreferrer noopener">
                        {block.label ?? address}
                    </a>
                ) : (
                    <span className="muted" title="not an http(s) address, so it is not offered as a link">
                        {block.label ?? block.href}
                    </span>
                )}
            </p>
        )
    }
    const text = block.kind === 'markdown' ? block.markdown : block.code
    return (
        <div className="object-block">
            <div className="muted object-block-kind">{block.kind === 'markdown' ? 'markdown, shown as written' : (block.language ?? 'text')}</div>
            <pre className="object-text">{text}</pre>
        </div>
    )
}

export const ObjectPanel = ({ target, access, where, onWhere }: { target: Ref; access: ObjectAccess; where: Where | undefined; onWhere?: (where: Where) => void }) => {
    const [opened, setOpened] = useState<Opened | undefined>()
    const [problem, setProblem] = useState<string | undefined>()
    const [note, setNote] = useState<string | undefined>()

    useEffect(() => {
        let current = true
        setOpened(undefined)
        setProblem(undefined)
        access
            .open(target)
            .then((answer) => current && setOpened(answer))
            .catch((error: unknown) => current && setProblem(String(error)))
        return () => {
            current = false
        }
        // Keyed by the reference rather than the object: two placements of one document are the same
        // object, and re-opening it because the reader arrived by another route would be a request
        // for something already on screen.
    }, [access, target.id, target.provider.peer, target.provider.instance])

    const follow = async (link: Link) => {
        const answer = await access.follow(link, where)
        if (isRefused(answer)) {
            setNote(answer.refused)
            return
        }
        // Said out loud when the aspect could not be kept. A viewer that changed which structure
        // somebody is reading without telling them would leave them looking at a tree they did not
        // choose, with no way to notice they had been moved.
        setNote(answer.fallbackUsed ? `that document is not in this structure — showing it in ${answer.aspectId ?? 'no structure'} instead` : undefined)
        onWhere?.(answer)
    }

    if (problem) return <p className="error">{problem}</p>
    if (!opened) return <p className="muted">opening…</p>

    return (
        <div className="object-panel">
            <div className="object-head">
                <strong>{opened.title}</strong>
                <span className="muted"> {opened.kind}</span>
                {opened.origin?.updatedAt && <span className="muted"> · changed {opened.origin.updatedAt.slice(0, 10)}</span>}
            </div>
            {note && <p className="object-note">{note}</p>}
            {/* Fields before content, because an object that has no content is usually one whose
                fields *are* the content: a UA variable has a node id, a class and an access level
                and no prose at all, and a panel built only for documents showed it as a heading and
                nothing else. */}
            {opened.fields && Object.keys(opened.fields).length > 0 && (
                <dl className="object-fields">
                    {Object.entries(opened.fields).map(([name, value]) => (
                        <div className="object-field" key={name}>
                            <dt className="muted">{name}</dt>
                            <dd>{shown(value)}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {(opened.content ?? []).map((block) => (
                <Content key={block.id} block={block} />
            ))}
            {!!opened.bindings?.length && (
                <div className="object-bindings">
                    {/* ## Named, navigable, and no further
                     *
                     * A binding still says how an object *can* be reached rather than that this page
                     * may reach it. The console does not fetch one, embed one, or send anything to
                     * one, and none of that changes here.
                     *
                     * What is new is that an `http(s)` address is drawn as a link. That is a
                     * different act from the ones above, and the difference is the whole reason it
                     * is allowed: clicking it is the *browser* making a request as itself, in a tab
                     * of its own, against an origin that is not this one. This page hands over an
                     * address and takes no part in what follows - no credential of the console's
                     * goes with it, and nothing comes back into this origin.
                     *
                     * Everything else stays text, including an `opc.tcp://` endpoint, which is the
                     * common case and is exactly right: a binding a browser cannot open is a fact
                     * somebody pastes into the tool that can. */}
                    <div className="muted">reachable through</div>
                    {opened.bindings.map((binding, at) => (
                        <div className="object-binding" key={`${binding.kind}-${at}`}>
                            <span className="object-binding-kind">{binding.kind}</span>
                            <span className="object-binding-role">{binding.role}</span>
                            <span className="muted">{bindingTarget(binding.target)}</span>
                            {binding.target.type === 'external' &&
                                (navigable(binding.target.endpoint) ? (
                                    <a className="binding-open" href={navigable(binding.target.endpoint)} target="_blank" rel="noreferrer noopener" title={binding.target.endpoint}>
                                        {binding.target.endpoint} ↗
                                    </a>
                                ) : (
                                    binding.target.endpoint && <span className="muted">at {binding.target.endpoint}</span>
                                ))}
                            {binding.fields &&
                                Object.entries(binding.fields)
                                    .filter(([name]) => name !== 'nodeClass')
                                    .map(([name, value]) => (
                                        <span className="tree-detail" key={name}>
                                            <span className="muted">{name}</span> {shown(value)}
                                        </span>
                                    ))}
                        </div>
                    ))}
                </div>
            )}
            {!!opened.links?.length && (
                <div className="object-links">
                    <div className="muted">links</div>
                    {opened.links.map((link) => (
                        <button key={link.id} className="object-link" onClick={() => void follow(link)} title={`${link.relation ?? 'links to'} ${link.target.id}`}>
                            {link.label ?? link.target.id}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
