import { RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import type { RpcServer } from '@source-repo/rpc'
import type { RpcDataCache, RpcQuestion } from '@source-repo/query'
import {
    hitAddress,
    movedNode,
    scopesIn,
    ValueGrid,
    watchKey,
    withNode,
    withoutNode,
    type BranchQuestion,
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
 * ## The cost ladder, which is the whole design in three lines
 *
 * Opening the pane costs **nothing**: `everything` lists *peers*, whose names this console already
 * knows from the network. Opening a peer costs **one describe** - a console cannot list what a peer
 * serves without asking it, and that is the only irreducible cost here. Opening a scope costs **one
 * channel**, which is what opening that node has always cost.
 *
 * Which is what the grouping is for, rather than tidiness. A peer serving forty resources is forty
 * headings, and the peer is the thing a reader is choosing between; more to the point, a flat list
 * has to describe every peer to know what to put in it, so it spends a round trip per machine on a
 * pane somebody may have opened to look at one of them.
 *
 * A section inside a closed peer is not observed, even if the reader had opened it - a channel for
 * something nobody can see is the defect this pane exists to avoid. The expansion is *remembered*
 * rather than discarded, so collapsing a peer releases its channels and expanding it again brings
 * back what was open.
 *
 * **`chosen` is not grouped**, and that is not an oversight. It is in the reader's order because
 * they put it in one, and grouping it by peer would re-sort it - which is exactly what somebody
 * comparing the same line on two machines does not want. `everything` is derived and has no order to
 * destroy.
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
    branchQuestion: ((resource, parentId, page, pageSize) => ({
        target: peer,
        namespace,
        method: 'getChildren',
        resource,
        params: { pagination: { page, pageSize }, ...(parentId !== undefined ? { parentId } : {}) }
    })) as BranchQuestion,
    rowQuestion: ((resource, id) => ({ target: peer, namespace, method: 'getOne', resource, params: { id } })) as RowQuestion,
    scopedQuestion: ((resource, under, page, size, filter, sort) => ({
        target: peer,
        namespace,
        method: 'getList',
        resource,
        // `recursive`, because this is the question that means *everything beneath this branch* -
        // which `getList` used to mean on its own and now says out loud.
        params: { pagination: { page, pageSize: size }, recursive: true, ...(under !== undefined ? { under } : {}), ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) }
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

/**
 * One peer, and what it serves - the outer level of `everything`.
 *
 * Drawn from the peer list rather than from what has been described, so a peer that is unreachable
 * or has not been asked yet is *here*, saying so. A list built from descriptions would leave it out
 * entirely, and a reader would read a shorter network rather than a broken one.
 */
const PeerGroup = ({
    peer,
    title,
    open,
    scopes,
    refusal,
    describing,
    onToggle,
    children
}: {
    peer: string
    title: string
    open: boolean
    scopes: number | undefined
    refusal: string | undefined
    describing: boolean
    onToggle: () => void
    children: React.ReactNode
}) => (
    <section className={`watch-peer${open ? '' : ' shut'}`}>
        <button className="watch-peer-head" onClick={onToggle} title={open ? 'close this peer, and release whatever it was serving this pane' : 'open this peer, which costs one description of it'}>
            <span className="twist">{open ? '▾' : '▸'}</span>
            <span className="entity-title">
                <span>{title}</span>
                <span className="entity-id mono">{peer}</span>
            </span>
            {/* A closed peer that has been described says how much is in it, because that is the
                number somebody deciding whether to open it wants. One that has not been described
                says nothing rather than nothing-shaped-like-zero. */}
            {refusal ? <span className="badge warn">unreachable</span> : describing ? <span className="muted">describing…</span> : scopes !== undefined ? <span className="badge">{scopes}</span> : null}
        </button>
        {open && (refusal ? <p className="component-error">{peer} could not be described: {refusal}</p> : children)}
    </section>
)

export const WatchPane = ({
    watch,
    onChange,
    server,
    known,
    refusals,
    onNeed,
    peers,
    title,
    peerTitle,
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
    peerTitle: (peer: string) => string
    cache: RpcDataCache
    period: number | undefined
    pageSize: number
}) => {
    const [mode, setMode] = useState<'chosen' | 'everything'>('chosen')
    /**
     * Which sections and which peers are open, and so which of them cost anything.
     *
     * Kept for the session rather than stored. What somebody chose is worth remembering across a
     * reload and is; which parts of the network they had expanded while looking through it is a fact
     * about the last few minutes.
     */
    const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(() => new Set(watch.map(watchKey)))
    const [openPeers, setOpenPeers] = useState<ReadonlySet<string>>(() => new Set())

    /**
     * The nodes this pane could draw at all - which for `everything` is the scopes of the peers that
     * are *open*, and nothing from the rest.
     *
     * A closed peer contributes none, so nothing under it can be observed however the reader left
     * it, and the hook releases those channels without being told to. The expansion itself is kept,
     * so opening the peer again brings back what was open inside it.
     */
    const nodes = useMemo(
        () => (mode === 'chosen' ? watch : peers.filter((peer) => openPeers.has(peer)).flatMap((peer) => (known[peer] ? scopesIn(peer, known[peer]) : []))),
        [mode, watch, peers, openPeers, known]
    )

    /**
     * Describe what is *open*, and nothing else - the same rule in both modes.
     *
     * In `everything` that is the peers somebody expanded, which is why opening the pane costs
     * nothing at all: the list of peers is something this console already knows, and describing one
     * is what expanding it buys. In `chosen` it is the peers whose sections are open, which is
     * usually all of them - a node somebody added starts open - but not always, and a collapsed
     * section should no more cost a description than it costs a channel.
     *
     * Either way these may be peers this console has never looked at: a chosen list comes back from
     * storage and nothing says its peers were ever selected.
     */
    useEffect(() => {
        onNeed(mode === 'chosen' ? [...new Set(watch.filter((node) => openNodes.has(watchKey(node))).map((node) => node.peer))] : peers.filter((peer) => openPeers.has(peer)))
    }, [mode, watch, peers, openNodes, openPeers, onNeed])

    const parts = useWatchParts(nodes, openNodes, server, known, refusals, title)

    const toggleNode = useCallback(
        (key: string) =>
            setOpenNodes((held) => {
                const next = new Set(held)
                if (!next.delete(key)) next.add(key)
                return next
            }),
        []
    )
    const togglePeer = useCallback(
        (peer: string) =>
            setOpenPeers((held) => {
                const next = new Set(held)
                if (!next.delete(peer)) next.add(peer)
                return next
            }),
        []
    )
    const remove = useCallback(
        (key: string) => {
            onChange((held) => withoutNode(held, key))
            setOpenNodes((held) => new Set([...held].filter((one) => one !== key)))
        },
        [onChange]
    )
    const move = useCallback((key: string, by: -1 | 1) => onChange((held) => movedNode(held, key, by)), [onChange])
    // Keeping a derived section opens it too, for the same reason adding one does: choosing it is
    // saying you want to watch it.
    const pin = useCallback(
        (node: WatchNode) => {
            onChange((held) => withNode(held, node))
            setOpenNodes((held) => new Set(held).add(watchKey(node)))
        },
        [onChange]
    )

    const section = (part: WatchPart, at: number, of: number, derived: boolean) => (
        <Section
            key={watchKey(part.node)}
            part={part}
            first={at === 0}
            last={at === of - 1}
            derived={derived}
            cache={cache}
            period={period}
            pageSize={pageSize}
            onToggle={toggleNode}
            onRemove={remove}
            onMove={move}
            onPin={pin}
        />
    )

    const observed = parts.filter((part) => part.observed).length
    const measure = mode === 'chosen' ? `${nodes.length} node${nodes.length === 1 ? '' : 's'}` : `${peers.length} peer${peers.length === 1 ? '' : 's'}`

    return (
        <>
            <header className="peer-head">
                <h1>
                    <span>watch</span>
                    <span className="entity-id mono">
                        {measure} · {observed} open
                    </span>
                </h1>
                <span className="watch-modes">
                    {(['chosen', 'everything'] as const).map((one) => (
                        <button key={one} className={mode === one ? 'toggle on' : 'toggle'} onClick={() => setMode(one)} title={one === 'chosen' ? 'the nodes you added, in your order' : 'every peer on the network, and what each one serves'}>
                            {one}
                        </button>
                    ))}
                </span>
            </header>
            {/* Said once, at the top, because it is what makes the list safe to be long. */}
            <p className="muted watch-note">
                {mode === 'chosen'
                    ? 'A section costs nothing until it is opened — a closed one holds no subscription and asks no questions.'
                    : 'Opening this pane costs nothing. Opening a peer costs one description of it; opening a scope costs one subscription. Nothing closed costs anything.'}
            </p>
            {mode === 'chosen' ? (
                nodes.length === 0 ? (
                    <p className="muted">
                        Nothing chosen yet. Open a peer, pick a scope, and press <span className="mono">add to watch</span> — from as many peers as you like. What you choose stays here until you take it out. Or switch to <span className="mono">everything</span> and keep what looks useful.
                    </p>
                ) : (
                    parts.map((part, at) => section(part, at, parts.length, false))
                )
            ) : peers.length === 0 ? (
                <p className="muted">No peer has announced itself yet.</p>
            ) : (
                peers.map((peer) => {
                    const mine = parts.filter((part) => part.node.peer === peer)
                    const open = openPeers.has(peer)
                    return (
                        <PeerGroup
                            key={peer}
                            peer={peer}
                            title={peerTitle(peer)}
                            open={open}
                            scopes={known[peer] ? scopesIn(peer, known[peer]).length : undefined}
                            refusal={refusals[peer]}
                            describing={open && !known[peer] && !refusals[peer]}
                            onToggle={() => togglePeer(peer)}
                        >
                            {known[peer] && mine.length === 0 ? <p className="muted">nothing observable here — this peer serves services rather than components</p> : mine.map((part, at) => section(part, at, mine.length, true))}
                        </PeerGroup>
                    )
                })
            )}
        </>
    )
}
