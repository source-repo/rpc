import { RefObject, useCallback, useMemo } from 'react'
import type { RpcServer } from '@source-repo/rpc'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import {
    hitAddress,
    movedNode,
    ValueGrid,
    viewKey,
    withoutNode,
    type BranchQuestion,
    type PageQuestion,
    type RowQuestion,
    type ScopedQuestion,
    type ServerDescription,
    type View
} from '@source-repo/react'
import { useViewParts, type ViewPart } from './viewParts'

/**
 * The view, as a pane of the console: the nodes a reader chose, from wherever they are.
 *
 * ## Why the arrangement is here and not in the toolkit
 *
 * The *model* is in `@source-repo/react` - what a chosen node is, how the set is grouped into
 * subscriptions, what a stored one reads back as - because that is the part a CLI or an MCP server
 * would otherwise write again. What is here is a layout, and layout is what the toolkit says it does
 * not do. The first cut of this had a `ViewPanel` in the package taking a bag of resolved props per
 * section, which is a component whose entire interface is *whatever ValueGrid needs*, restated one
 * layer up and kept in step by hand.
 *
 * ## Sections, and why each one is a whole grid
 *
 * A section per chosen node, headed by where it is, containing `ValueGrid` for that scope. Which
 * means a view holds whatever the console can show: typed values, a record paged a page at a time,
 * an OPC UA branch browsed a level at a time, a SQL table. The first cut of this drew value rows
 * itself and so could hold only typed state - and on the network it was built against, every
 * interesting node is an aspect provider or a relational service, so a view could hold nothing at
 * all. The rule it was enforcing was real but was about the *subscription*: a collection is paged
 * rather than watched, which `viewProjection` still says, and which is not the same claim as a view
 * cannot contain one.
 *
 * The heading is where "which one is this" is answered, rather than a column repeating it on every
 * row: two machines running the same line publish the same paths under the same names, and four
 * `Filler01.Speed` rows in one list is a screen worse than no screen.
 *
 * ## Read-only, deliberately
 *
 * No editors, no action buttons. Not because a view could not have them, but because the machinery
 * that makes them safe - the argument form, the write discovery, the conflict re-read - belongs to
 * `ComponentPanel` and to *a* component. A view is a place to watch four machines from; `open` on
 * any section is one click to the page where all of it is. Commanding a plant from a screen
 * assembled out of four peers is a thing to design on purpose rather than to inherit by passing one
 * more prop.
 */

/** The questions one section asks, which differ from another's only in which peer answers them. */
const questionsFor = (peer: string, namespace: string) => ({
    pageQuestion: ((resource, page, pageSize, filter, sort) => ({
        target: peer,
        namespace,
        method: 'getList',
        resource,
        params: { pagination: { page, pageSize }, ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) }
    })) as PageQuestion,
    branchQuestion: ((resource, parentId, page, pageSize) => ({
        target: peer,
        namespace,
        method: 'getChildren',
        resource,
        params: { pagination: { page, pageSize }, ...(parentId !== undefined ? { parentId } : {}) }
    })) as BranchQuestion,
    rowQuestion: ((resource, id) => ({ target: peer, namespace, method: 'getOne', resource, params: { id } })) as RowQuestion,
    scopedQuestion: ((resource, under, page, size, filter) => ({
        target: peer,
        namespace,
        method: 'getList',
        resource,
        params: { pagination: { page, pageSize: size }, ...(under !== undefined ? { under } : {}), ...(filter ? { filter } : {}) }
    })) as ScopedQuestion,
    manyQuestion: (resource: readonly string[], ids: readonly string[]): RpcQuestion => ({ target: peer, namespace, method: 'getMany', resource, params: { ids: [...ids] } })
})

const Section = ({
    part,
    first,
    last,
    cache,
    period,
    pageSize,
    onRemove,
    onMove
}: {
    part: ViewPart
    first: boolean
    last: boolean
    cache: RpcDataCache
    period: number | undefined
    pageSize: number
    onRemove: (key: string) => void
    onMove: (key: string, by: -1 | 1) => void
}) => {
    const key = viewKey(part.node)
    const questions = useMemo(() => questionsFor(part.node.peer, part.node.namespace), [part.node.peer, part.node.namespace])

    return (
        <section className="view-node">
            <header className="view-node-head">
                <span className="entity-title">
                    <span>{part.title}</span>
                    <span className="entity-id mono">{part.node.path.join('.')}</span>
                </span>
                <span className="view-node-controls">
                    {/* The same address a search hit resolves to, from the same function. A locator
                        is a locator however it was arrived at, and two ways of spelling one place
                        would be two things to keep in step. */}
                    <a className="toggle" href={hitAddress(part.node.peer, part.node.namespace, part.node.path)} title="open this node on its own page, where it can be commanded">
                        open ↗
                    </a>
                    <button className="toggle" disabled={first} onClick={() => onMove(key, -1)} title="move up">
                        ↑
                    </button>
                    <button className="toggle" disabled={last} onClick={() => onMove(key, 1)} title="move down">
                        ↓
                    </button>
                    <button className="toggle" onClick={() => onRemove(key)} title="take this node out of the view">
                        remove
                    </button>
                </span>
            </header>
            {/* A part that could not be resolved says so where it was, rather than vanishing: one
                peer rebooting is the ordinary state of any network worth making a view of, and a
                section that quietly disappeared would let a reader take the remaining three for the
                whole view - or conclude they had removed it themselves. */}
            {part.refusal ? (
                <p className="component-error">{part.refusal}</p>
            ) : !part.component ? (
                <p className="muted">describing {part.node.peer}…</p>
            ) : (
                <ValueGrid
                    component={part.component}
                    types={part.types}
                    scope={[...part.node.path]}
                    source={part.source}
                    cache={cache}
                    period={period}
                    pageSize={pageSize}
                    actionsFor={() => undefined}
                    {...questions}
                />
            )}
        </section>
    )
}

export const ViewPane = ({
    view,
    onChange,
    server,
    describe,
    title,
    cache,
    period,
    pageSize
}: {
    view: View
    onChange: (change: (held: View) => View) => void
    server: RefObject<RpcServer | null>
    describe: (peer: string) => Promise<ServerDescription | { error: string }>
    title: (peer: string, namespace: string) => string
    cache: RpcDataCache
    period: number | undefined
    pageSize: number
}) => {
    const parts = useViewParts(view, server, describe, title)
    const remove = useCallback((key: string) => onChange((held) => withoutNode(held, key)), [onChange])
    const move = useCallback((key: string, by: -1 | 1) => onChange((held) => movedNode(held, key, by)), [onChange])

    return (
        <>
            <header className="peer-head">
                <h1>
                    <span>view</span>
                    <span className="entity-id mono">
                        {view.length} node{view.length === 1 ? '' : 's'}
                    </span>
                </h1>
                <span className="muted">the nodes you chose, from wherever they are — watched while this pane is open</span>
            </header>
            {parts.length === 0 ? (
                <p className="muted">
                    Nothing chosen yet. Open a peer, pick a scope, and press <span className="mono">add to view</span> — from as many peers as you like. What you choose stays here until you take it out.
                </p>
            ) : (
                parts.map((part, at) => (
                    <Section key={viewKey(part.node)} part={part} first={at === 0} last={at === parts.length - 1} cache={cache} period={period} pageSize={pageSize} onRemove={remove} onMove={move} />
                ))
            )}
        </>
    )
}
