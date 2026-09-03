import { RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import type { RpcServer } from '@source-repo/rpc'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import {
    everythingIn,
    hitAddress,
    movedNode,
    ValueGrid,
    watchKey,
    withNode,
    withoutNode,
    type BranchQuestion,
    type PageQuestion,
    type RowQuestion,
    type ScopedQuestion,
    type ServerDescription,
    type Watch,
    type WatchNode
} from '@source-repo/react'
import { useWatchParts, type WatchPart } from './watchParts'

/**
 * The watch pane: sections, each a place somewhere on the network, each drawn by the ordinary grid.
 *
 * ## Two lists, one rendering
 *
 * **Chosen** is the set somebody assembled with `add to watch`, in their order, kept until they take
 * it out. **Everything** is every scope of every observable namespace of every described peer -
 * derived rather than assembled, and offered because the argument for refusing it did not survive
 * being made out loud.
 *
 * That argument was that the whole network is thousands of values and a screen showing all of them
 * shows none. It is about *size*, and size is not something the network root introduces: one OPC UA
 * address space here is four hundred nodes and a real one is far larger, and the console already
 * deals with that - the scope tree is bounded by the contract, collections are paged, trees are
 * browsed a branch at a time. So the network root is the same problem one level up, and refusing it
 * avoided a confrontation rather than settling one. What genuinely did not scale was holding a
 * channel per section, which is fixed rather than avoided: **a closed section costs nothing.** The
 * list is then headings, which are free, and opening one costs exactly what opening that one node
 * has always cost.
 *
 * What everything still costs is one `describe` per peer, which is unavoidable - a console cannot
 * list what a peer serves without asking it - and is bounded rather than issued as a burst.
 *
 * ## Which sections start open
 *
 * A node somebody added is open, because choosing it is the act of saying they want to watch it. A
 * derived one starts closed. No threshold and no count: the rule is about how the node got into the
 * list, which is a fact rather than a guess about how big is too big.
 *
 * ## Read-only, deliberately
 *
 * No editors, no action buttons. Not because a watch list could not have them, but because the
 * machinery that makes them safe - the argument form, the write discovery, the conflict re-read -
 * belongs to `ComponentPanel` and to *a* component. `open` on any section is one click to the page
 * where all of it is. Commanding a plant from a screen assembled out of four peers is a thing to
 * design on purpose rather than to inherit by passing one more prop.
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
    derived,
    cache,
    period,
    pageSize,
    onToggle,
    onRemove,
    onMove,
    onPin
}: {
    part: WatchPart
    first: boolean
    last: boolean
    derived: boolean
    cache: RpcDataCache
    period: number | undefined
    pageSize: number
    onToggle: (key: string) => void
    onRemove: (key: string) => void
    onMove: (key: string, by: -1 | 1) => void
    onPin: (node: WatchNode) => void
}) => {
    const key = watchKey(part.node)
    const questions = useMemo(() => questionsFor(part.node.peer, part.node.namespace), [part.node.peer, part.node.namespace])

    return (
        <section className={`watch-node${part.observed ? '' : ' shut'}`}>
            <header className="watch-node-head">
                {/* The disclosure is the heading, so the whole row is the target rather than a
                    triangle somebody has to hit. */}
                <button className="watch-node-name" onClick={() => onToggle(key)} title={part.observed ? 'close this section, and stop observing it' : 'open this section, which is what makes it cost anything'}>
                    <span className="twist">{part.observed ? '▾' : '▸'}</span>
                    <span className="entity-title">
                        <span>{part.title}</span>
                        <span className="entity-id mono">{part.node.path.join('.')}</span>
                    </span>
                </button>
                <span className="watch-node-controls">
                    {/* The same address a search hit resolves to, from the same function. A locator
                        is a locator however it was arrived at, and two ways of spelling one place
                        would be two things to keep in step. */}
                    <a className="toggle" href={hitAddress(part.node.peer, part.node.namespace, part.node.path)} title="open this node on its own page, where it can be commanded">
                        open ↗
                    </a>
                    {derived ? (
                        <button className="toggle" onClick={() => onPin(part.node)} title="keep this one in the chosen list">
                            keep
                        </button>
                    ) : (
                        <>
                            <button className="toggle" disabled={first} onClick={() => onMove(key, -1)} title="move up">
                                ↑
                            </button>
                            <button className="toggle" disabled={last} onClick={() => onMove(key, 1)} title="move down">
                                ↓
                            </button>
                            <button className="toggle" onClick={() => onRemove(key)} title="take this node off the watch list">
                                remove
                            </button>
                        </>
                    )}
                </span>
            </header>
            {/* Nothing at all while closed: no grid, no channel, no question. That is what makes a
                list of every node on the network a reasonable thing to draw. */}
            {!part.observed ? null : part.refusal ? (
                /* A part that could not be resolved says so where it was rather than vanishing: one
                   peer rebooting is the ordinary state of any network worth watching, and a section
                   that quietly disappeared would let a reader take the rest for the whole list. */
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

export const WatchPane = ({
    watch,
    onChange,
    server,
    known,
    refusals,
    onNeed,
    peers,
    title,
    cache,
    period,
    pageSize
}: {
    watch: Watch
    onChange: (change: (held: Watch) => Watch) => void
    server: RefObject<RpcServer | null>
    known: { readonly [peer: string]: ServerDescription }
    refusals: { readonly [peer: string]: string }
    /** Ask the console to describe these peers, bounded and once each. */
    onNeed: (peers: readonly string[]) => void
    peers: readonly string[]
    title: (peer: string, namespace: string) => string
    cache: RpcDataCache
    period: number | undefined
    pageSize: number
}) => {
    const [mode, setMode] = useState<'chosen' | 'everything'>('chosen')
    /**
     * Which sections are open, and so which of them cost anything.
     *
     * Kept for the session rather than stored. What somebody chose is worth remembering across a
     * reload and is; which sections they had expanded while looking through the whole network is a
     * fact about the last few minutes.
     */
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(watch.map(watchKey)))

    const everything = useMemo(() => everythingIn(known), [known])
    const nodes = mode === 'chosen' ? watch : everything

    /**
     * Describe what this pane needs, and only that.
     *
     * `chosen` needs the peers its own nodes name, which may be peers this console has never looked
     * at - the list is restored from storage and nothing says its peers were ever selected.
     * `everything` needs them all, because a console cannot list what a peer serves without asking.
     */
    useEffect(() => {
        onNeed(mode === 'chosen' ? [...new Set(watch.map((node) => node.peer))] : peers)
    }, [mode, watch, peers, onNeed])

    const parts = useWatchParts(nodes, open, server, known, refusals, title)

    const toggle = useCallback((key: string) => setOpen((held) => {
        const next = new Set(held)
        if (!next.delete(key)) next.add(key)
        return next
    }), [])
    const remove = useCallback(
        (key: string) => {
            onChange((held) => withoutNode(held, key))
            setOpen((held) => new Set([...held].filter((one) => one !== key)))
        },
        [onChange]
    )
    const move = useCallback((key: string, by: -1 | 1) => onChange((held) => movedNode(held, key, by)), [onChange])
    // Keeping a derived section opens it too, for the same reason adding one does: choosing it is
    // saying you want to watch it.
    const pin = useCallback(
        (node: WatchNode) => {
            onChange((held) => withNode(held, node))
            setOpen((held) => new Set(held).add(watchKey(node)))
        },
        [onChange]
    )

    const observed = parts.filter((part) => part.observed).length

    return (
        <>
            <header className="peer-head">
                <h1>
                    <span>watch</span>
                    <span className="entity-id mono">
                        {nodes.length} node{nodes.length === 1 ? '' : 's'} · {observed} open
                    </span>
                </h1>
                <span className="watch-modes">
                    {(['chosen', 'everything'] as const).map((one) => (
                        <button key={one} className={mode === one ? 'toggle on' : 'toggle'} onClick={() => setMode(one)} title={one === 'chosen' ? 'the nodes you added, in your order' : 'every scope of every peer that has been described'}>
                            {one}
                        </button>
                    ))}
                </span>
            </header>
            {/* Said once, at the top, because it is the thing that makes the list safe to be long. */}
            <p className="muted watch-note">A section costs nothing until it is opened — a closed one holds no subscription and asks no questions.</p>
            {nodes.length === 0 ? (
                mode === 'chosen' ? (
                    <p className="muted">
                        Nothing chosen yet. Open a peer, pick a scope, and press <span className="mono">add to watch</span> — from as many peers as you like. What you choose stays here until you take it out. Or switch to <span className="mono">everything</span> and keep what looks useful.
                    </p>
                ) : (
                    <p className="muted">Describing the network…</p>
                )
            ) : (
                parts.map((part, at) => (
                    <Section
                        key={watchKey(part.node)}
                        part={part}
                        first={at === 0}
                        last={at === parts.length - 1}
                        derived={mode === 'everything'}
                        cache={cache}
                        period={period}
                        pageSize={pageSize}
                        onToggle={toggle}
                        onRemove={remove}
                        onMove={move}
                        onPin={pin}
                    />
                ))
            )}
        </>
    )
}
