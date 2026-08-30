import { useEffect, useState } from 'react'

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

export interface Opened {
    ref: Ref
    kind: string
    title: string
    summary?: string
    fields?: Record<string, unknown>
    origin?: { system?: string; updatedAt?: string; retrievedAt?: string }
    content?: Block[]
    links?: Link[]
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

const Content = ({ block }: { block: Block }) => {
    if (block.kind === 'attachment')
        return (
            <p className="object-block">
                <a href={block.href} target="_blank" rel="noreferrer noopener">
                    {block.label ?? block.href}
                </a>
            </p>
        )
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
            {(opened.content ?? []).map((block) => (
                <Content key={block.id} block={block} />
            ))}
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
