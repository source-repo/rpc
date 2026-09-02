import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { RpcServer, TransportEvent, type RpcGetListParams, type RpcGetManyParams, type RpcGetOneParams, type RpcGetOneResult, type RpcGetListResult, type RpcGetManyResult, type RpcSchema } from '@source-repo/rpc'
import { RpcDataCache, rpcOnlineFrom } from '@source-repo/query'
import { RpcOperations } from '@source-repo/rpc'
import { pageName } from './peerName'
import { Chat } from './Chat'
import { ChatMessage, ChatService } from './ChatService'
// Extracted from ChatService by `npm run contract` and committed. A page is the one peer nobody can
// read the source of at runtime, so shipping its contract is what lets another console show
// `say(from: string, text: string)` instead of `say(…)`.
import chatContract from './chat.types.json'
import { ComponentPanel } from './ComponentPanel'
import { ContextPanel } from './ContextPanel'
import { StructurePanel } from './StructurePanel'
import { MethodPanel } from './MethodPanel'
import { Operations } from './Operations'
import { Traffic, TRAFFIC_KEPT } from './Traffic'
import { Problems } from './Problems'
import { Presence } from './Presence'
import { ConsoleService, DescribedEvent, NetworkProblem, PeerChange, PeerRole, PeerStructure, ServerDescription, StreamedEvent, TappedFrame, fetchConsoleName, socketPath, typeText } from './types'
import { displayNameForId, namespaceDisplayName, peerDisplayName } from './displayName'

/**
 * The page talks to the CLI over msgrpc itself, and is a peer of the network in its own right.
 *
 * One RpcServer does both. It serves over the connection it opens to the console - the only thing
 * a browser can do, since it cannot listen - which is what lets another peer call the chat service
 * exposed here. The same object calls outwards with proxy(), so browsing the network and hosting a
 * service on it share one link and one name.
 *
 * The name is derived from the console this page is attached to, so it is the same on every reload
 * and two pages on different consoles are plainly different peers.
 */

/** How many times the page will try the handshake again before giving up and saying so. */
const RECONNECT_ATTEMPTS = 3

const useConsole = () => {
    const [service, setService] = useState<ConsoleService | null>(null)
    const [me, setMe] = useState('')
    const [status, setStatus] = useState('connecting')
    const events = useRef<((event: StreamedEvent) => void) | null>(null)
    const peerChange = useRef<((peer: string, state: string, change: PeerChange) => void) | null>(null)
    const said = useRef<((from: string, text: string) => void) | null>(null)
    const frames = useRef<((frame: TappedFrame) => void) | null>(null)
    const problems = useRef<((problem: NetworkProblem) => void) | null>(null)
    const peer = useRef<RpcServer | null>(null)
    /** Who is relaying. The tray names it, because a relayed command has two places to fail. */
    const [relay, setRelay] = useState('')

    /**
     * One cache for the page, because the questions are the page's rather than any pane's.
     *
     * Two panels open on the same peer ask one question between them, and a page reopened on a
     * collection somebody was reading a moment ago is answered without a round trip. Per-panel it
     * would be neither - and the freshness signal, which is per component, would be registered
     * twice against the same channel.
     *
     * The link is read at call time, like every other call this page makes, so a request issued
     * during a reconnect uses the link that exists then rather than one captured when the page
     * loaded.
     */
    /**
     * What this page has asked other peers to do, and how each turned out.
     *
     * Owned here rather than read off the server, so it exists before the link does: the tray mounts
     * with the page and the server is built inside `connect()`. It is the same registry either way -
     * `callWith` is the only thing that writes to it.
     */
    const operations = useMemo(() => new RpcOperations(), [])

    const data = useMemo(
        () =>
            new RpcDataCache({
                ask: async ({ target, namespace, method, resource, params }) => {
                    const link = peer.current
                    if (!link) throw new Error('no link')
    // Four verbs, and the list is still an allow-list rather than a pass-through. `getList` is a
                    // page of a collection, `getChildren` is one branch of a tree, `getOne` is a single row
                    // opened on its own, and `getMany` is the ids a page of rows referred to - which is what
                    // makes fifty referenced customers one round trip instead of fifty. `getManyReference`
                    // stays out until something draws the reverse side. The others stay refused out loud,
                    // because serving a `getMany` as a `getList` would answer the wrong question with a
                    // straight face - and the verb is passed through rather than re-stated, so a question
                    // asking for a branch cannot be answered with a page.
                    if (method !== 'getList' && method !== 'getChildren' && method !== 'getOne' && method !== 'getMany')
                        throw new Error(`the console asks for lists, tree branches, single rows and batches of ids; ${method} is not wired here`)
                    const proxy = await link.proxy<DataProxy>(namespace, target)
                    // Declared, because it is true and because it is what keeps the operations tray
                    // readable: `$data` reads and answers, so a page of rows is not a row an
                    // operator has to look at twice. The claim travels nowhere and decides nothing.
                    return proxy.$with({ semantics: 'query' }).$data(method, resource, params as RpcGetListParams | RpcGetOneParams | RpcGetManyParams)
                }
            }),
        []
    )
    useEffect(() => () => data.close(), [data])

    useEffect(() => {
        let server: RpcServer | undefined
        let attempts = 0
        let cancelled = false
        let undoOnline: (() => void) | undefined
        /**
         * Closed on the way out of the page as well as on unmount.
         *
         * React's cleanup does not run when a document is torn down by a navigation, so a page that
         * was navigated away from left its connection for the console to reap on a timeout - and in
         * the meantime it is still a peer, still in everyone's list, and still being sent the events
         * it subscribed to. Five stale pages after five reloads is the ordinary shape of a debugging
         * session. `pagehide` covers navigation, tab close and the back/forward cache, where
         * `unload` is unreliable and increasingly ignored.
         */
        const leaving = () => void server?.close()
        window.addEventListener('pagehide', leaving)

        const connect = async () => {
            try {
                // Ask who is serving this page before addressing it: the console's name is its own
                // name on the network, so it differs between instances.
                const consoleName = await fetchConsoleName()
                setRelay(consoleName)
                // Random per tab, kept across its reloads. See peerName: anything derived from the
                // URL gives every browser on this console the same name, and a name is an address.
                const name = pageName()
                setMe(name)

                server = new RpcServer({
                    name,
                    operations,
                    // Origin in the url, mount point in the path - see socketPath. Together they
                    // are where this page came from, so a proxied console reaches its own server.
                    transports: [{ connect: window.location.origin, path: socketPath() }],
                    readyTimeout: 10000,
                    schema: chatContract as RpcSchema,
                    // So a page can be selected in another page's console and describe itself.
                    // Without it every peer here answers ClassNotFound, which is true but useless.
                    exposeIntrospection: true
                })
                // No name here: @rpcNamespace('chat') carries it. That matters in a bundle, where
                // the class name is minified to something like `Mv` and would be the fallback.
                server.exposeClassInstance(new ChatService((from, text) => said.current?.(from, text)))
                /**
                 * Connected means *reachable*, not merely dialled.
                 *
                 * A reconnect repeats the first connection exactly: the transport announces itself
                 * when the socket opens and the peers list comes back a round trip later, so for
                 * that round trip there is no route to the console. Saying "connected" at the socket
                 * event puts a green word on screen over a link that answers `no route` to the next
                 * button pressed - and after a console restart or a laptop waking, pressing a button
                 * is precisely what happens next.
                 */
                const reachable = async () => {
                    if (!(await server?.awaitPeer(consoleName, 10000))) return setStatus(`nobody on this link is answering to '${consoleName}'`)
                    setStatus('connected')
                }
                const link = server.transports[0]
                link?.on(TransportEvent.disconnected, () => setStatus('reconnecting'))
                link?.on(TransportEvent.connected, () => void reachable())
                await server.ready()
                // Attached after ready(): transports are built asynchronously, so before it there
                // is nothing to listen to.
                for (const transport of server.transports) {
                    transport.on(TransportEvent.disconnected, () => setStatus('reconnecting'))
                    transport.on(TransportEvent.connected, () => void reachable())
                }
                peer.current = server
                // So that "offline" means this link rather than `navigator.onLine`, which is true
                // on a plant LAN with no route to the console. Taken from the transports *after*
                // ready() for the same reason the listeners above are - before it there is nothing
                // to listen to - and re-wired on a reconnect, which replaces the previous listener
                // rather than stacking on it.
                const live = server.transports[0]
                undoOnline?.()
                undoOnline = live ? rpcOnlineFrom(live) : undefined

                // `ready()` is this page's own links being up. It says nothing about the console
                // having announced itself over them, and presence arrives a moment later - a moment
                // that is nothing across loopback and a whole round trip from another machine.
                //
                // So this never looked like a race. The gap is the same length on every attempt, so
                // every attempt lost it the same way: a console opened from anywhere but the host it
                // runs on said `no route to '<its own name>'`, said it again through each retry, and
                // was faultless on localhost. Which is the worst shape a fault can have in the page
                // somebody opens to find out what is wrong.
                setStatus('waiting for the console to announce itself')
                if (!(await server.awaitPeer(consoleName, 10000))) throw new Error(`nobody on this link is answering to '${consoleName}'`)
                const proxy = await server.proxy<ConsoleService & { on: (e: string, h: (...a: unknown[]) => void) => Promise<unknown> }>('console', consoleName)
                await proxy.on('event', (event: unknown) => events.current?.(event as StreamedEvent))
                await proxy.on('peer', (change: unknown) => {
                    const coming = change as PeerChange
                    peerChange.current?.(coming.peer, coming.state, coming)
                })
                // Subscribed once, whether or not anything is tapping: the console emits nothing
                // here until a tap is started, and re-subscribing per tap would drop frames in the
                // gap between the two calls.
                await proxy.on('frame', (frame: unknown) => frames.current?.(frame as TappedFrame))
                await proxy.on('problem', (problem: unknown) => problems.current?.(problem as NetworkProblem))
                const remote = proxy as ConsoleService
                // The console does the waiting: it holds the broker link, enforces --timeout, and
                // its answer says what went wrong. A browser giving up first would replace that
                // diagnosis with a bare 'Timeout' at almost exactly the same moment.
                const { callTimeout } = await remote.peers()
                if (callTimeout) server.caller.callTimeout = callTimeout + 5000
                setService(remote)
                setStatus('connected')
            } catch (e) {
                if (cancelled) return
                // Retried rather than left dead. The handshake occasionally times out on a page
                // loaded moments after the last one, and until now that left the console showing an
                // error and no peers with a manual reload as the only way out - which is a poor
                // answer when the page is the thing you opened to find out what was wrong.
                await server?.close().catch(() => undefined)
                server = undefined
                if (++attempts <= RECONNECT_ATTEMPTS) {
                    setStatus(`cannot reach the console, trying again (${attempts}/${RECONNECT_ATTEMPTS})`)
                    await new Promise((wait) => setTimeout(wait, attempts * 1000))
                    if (!cancelled) await connect()
                    return
                }
                setStatus(`cannot reach the console: ${(e as Error).message}`)
            }
        }
        void connect()
        return () => {
            cancelled = true
            window.removeEventListener('pagehide', leaving)
            undoOnline?.()
            void server?.close()
        }
    }, [])

    return { service, status, me, events, peerChange, said, frames, problems, peer, data, operations, relay }
}

/**
 * Saves what is on screen as jsonl, which is the shape `msgrpc record` writes and `jq` reads. Built
 * here rather than fetched, so it works on a plant network with no route to anywhere.
 */
const download = (rows: unknown[], filename: string) => {
    const blob = new Blob([rows.map((row) => JSON.stringify(row)).join('\n') + '\n'], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
}

/** Just the DataProvider verb, so the page needs no generic over anybody's component class. */
/**
 * The three verbs this console asks for, and the shapes they answer with.
 *
 * Widened alongside the allow-list rather than left as `getList`'s shape: `getOne` answers one row
 * and no ids, so a type that claimed otherwise would let a pane read a page's fields off a record
 * and only find out in a browser.
 */
type DataProxy = {
    $data(
        method: 'getList' | 'getChildren' | 'getOne' | 'getMany',
        resource: readonly string[],
        params?: RpcGetListParams | RpcGetOneParams | RpcGetManyParams
    ): Promise<RpcGetListResult | RpcGetOneResult | RpcGetManyResult>
}

/** Which of the side panel's three views is showing. */
type SideTab = 'chat' | 'events' | 'traffic' | 'problems' | 'presence' | 'operations'

export const App = () => {
    const { service, status, me, events, peerChange, said, frames, problems, peer, data, operations, relay } = useConsole()
    const [chats, setChats] = useState<{ [peer: string]: ChatMessage[] }>({})
    /**
     * Messages that have arrived and not been looked at, per peer.
     *
     * Without this a message changes nothing on screen at all: the log is keyed by the peer selected
     * in the sidebar and the chat tab is one of five, so unless you already had that exact peer
     * selected with that tab open, a peer could say hello and you would never learn it had. Traffic
     * and problems have carried a count since they were written; chat was the one that let its
     * arrivals pass in silence.
     */
    const [unread, setUnread] = useState<{ [peer: string]: number }>({})
    const [peers, setPeers] = useState<string[]>([])
    const [offline, setOffline] = useState<Set<string>>(new Set())
    const [selected, setSelected] = useState<string | null>(null)
    /**
     * The observer this page was opened onto, when it was opened as one.
     *
     * `?observe=<peer>&ns=<namespace>` draws that component alone and full height - the scope tree
     * and the value list, and none of the console around them. Read once from the address the
     * document was loaded with, because this is a different page rather than a view the console
     * switches between: nothing here pushes history, and there is no state to keep in step.
     */
    const observing = useMemo(() => {
        const asked = new URLSearchParams(window.location.search)
        const peer = asked.get('observe')
        const namespace = asked.get('ns')
        return peer && namespace ? { peer, namespace } : undefined
    }, [])
    const [described, setDescribed] = useState<ServerDescription | { error: string; code?: string } | null>(null)
    const [watching, setWatching] = useState<Set<string>>(new Set())
    const [stream, setStream] = useState<StreamedEvent[]>([])
    const [tab, setTab] = useState<SideTab>('events')
    const [traffic, setTraffic] = useState<TappedFrame[]>([])
    const [trafficPaused, setTrafficPaused] = useState(false)
    const [trouble, setTrouble] = useState<NetworkProblem[]>([])
    const [links, setLinks] = useState<{ [peer: string]: string }>({})
    const [network, setNetwork] = useState<{ broker?: string; hub?: string; prefix?: string }>({})
    const [roles, setRoles] = useState<{ [peer: string]: PeerRole }>({})
    const [structure, setStructure] = useState<{ [peer: string]: PeerStructure }>({})
    const [comings, setComings] = useState<PeerChange[]>([])
    const [eventFilter, setEventFilter] = useState('')
    const [eventsPaused, setEventsPaused] = useState(false)

    const refreshPeers = useCallback(async () => {
        if (!service) return
        const state = await service.peers()
        setPeers(state.peers)
        setWatching(new Set(state.watching))
        setLinks(state.links ?? {})
        setNetwork(state.network ?? {})
        setRoles(state.roles ?? {})
        setStructure(state.structure ?? {})
    }, [service])

    // The tab is where two consoles are told apart when both are open, so it carries the peer name
    // rather than a title that is the same on every one of them.
    useEffect(() => {
        if (me) document.title = me
    }, [me])

    useEffect(() => {
        said.current = (from, text) => {
            setChats((current) => ({ ...current, [from]: [...(current[from] ?? []), { from, text, at: Date.now(), mine: false }] }))
            // Counted unconditionally and cleared below when it is genuinely on screen. Deciding it
            // here would mean reading `tab` and `selected` out of a closure this effect installs
            // once, so every message after the first would be judged against a stale view.
            setUnread((current) => ({ ...current, [from]: (current[from] ?? 0) + 1 }))
        }
    }, [said])

    // What you are looking at is not unread. An effect rather than something folded into `select`
    // and the tab buttons, because a message can arrive while its own chat is already open, and
    // that one has to clear too. Returning `current` unchanged when there is nothing to clear is
    // what keeps this from setting state on every render for ever.
    useEffect(() => {
        if (tab !== 'chat' || !selected) return
        setUnread((current) => (current[selected] ? { ...current, [selected]: 0 } : current))
    }, [tab, selected, chats])

    /** Calls the peer's own chat service - the page at the other end, not the console. */
    const sendChat = async (text: string) => {
        if (!peer.current || !selected) return 'not connected'
        setChats((current) => ({ ...current, [selected]: [...(current[selected] ?? []), { from: me, text, at: Date.now(), mine: true }] }))
        try {
            const proxy = await peer.current.proxy<{ say: (from: string, text: string) => Promise<string> }>('chat', selected)
            await proxy.say(me, text)
            return undefined
        } catch (e) {
            // Most often the peer is not running this console, so it exposes no chat namespace.
            return `${selected} did not take it: ${(e as { code?: string; message?: string }).message ?? String(e)}`
        }
    }

    useEffect(() => {
        void refreshPeers()
        // Paused stops the buffer filling rather than only the list rendering, the same way the
        // traffic tab does - a paused pane on a busy network should stay as it was.
        events.current = (event) => {
            if (eventsPaused) return
            setStream((current) => [event, ...current].slice(0, 500))
        }
        peerChange.current = (peer, state, change) => {
            if (state === 'reshaped') {
                // The peer is still here - its surface changed and the console has dropped what it
                // cached. Not a coming or a going, so the presence history is left alone; what
                // matters is that an open panel stops showing the old shape without a reselection.
                void refreshPeers()
                if (service && peer === selected) void service.describe(peer).then(setDescribed).catch(() => undefined)
                return
            }
            setOffline((current) => {
                const next = new Set(current)
                if (state === 'offline') next.add(peer)
                else next.delete(peer)
                return next
            })
            setComings((current) => [change, ...current].slice(0, 200))
            void refreshPeers()
        }
    }, [service, refreshPeers, events, peerChange, eventsPaused, selected])

    useEffect(() => {
        // Pausing stops the buffer filling rather than only the list rendering, so a paused tab on a
        // busy plant is actually paused - and what was on screen when it was paused stays there.
        frames.current = (frame) => {
            if (trafficPaused) return
            setTraffic((current) => [frame, ...current].slice(0, TRAFFIC_KEPT))
        }
    }, [frames, trafficPaused])

    useEffect(() => {
        problems.current = (problem) => setTrouble((current) => [problem, ...current].slice(0, 200))
        // Fetched as well as streamed: the console keeps what happened before this page was opened,
        // and on a network that is already misbehaving that is the part worth reading.
        if (service) void service.problems().then(({ problems: history }) => setTrouble(history)).catch(() => undefined)
        if (service) void service.presence().then(({ changes }) => setComings(changes)).catch(() => undefined)
    }, [service, problems])

    const select = async (peer: string) => {
        setSelected(peer)
        setDescribed(null)
        if (!service) return
        setDescribed(await service.describe(peer))
        await refreshPeers()
    }

    /**
     * The peer the address asks for, when the console was opened with one.
     *
     * The other half of the full-page view's way back: it returns here naming the peer somebody was
     * looking at, so they land where they left rather than at a list.
     */
    const asked = useMemo(() => new URLSearchParams(window.location.search).get('peer') ?? undefined, [])

    /**
     * Describe the peer this page was opened onto, once there is a console to ask.
     *
     * The same describe a click makes: a standalone observer still needs the contract to know what
     * to draw. Guarded on `selected` rather than run once, so the reconnect that brings a new
     * `service` does not re-describe what is already on screen and reset the panel under somebody
     * watching it.
     */
    useEffect(() => {
        if (!service || selected) return
        const wanted = observing?.peer ?? asked
        if (wanted) void select(wanted)
    }, [observing, asked, service, selected])

    /** Every event in one namespace, in one click - the usual first move on an unfamiliar peer. */
    const watchAll = async (namespace: string, events: DescribedEvent[]) => {
        if (!service || !selected) return
        for (const event of events) {
            if (watching.has(`${selected}/${namespace}/${event.name}`)) continue
            const answer = await service.watch(selected, namespace, event.name)
            if (answer.watching) setWatching((current) => new Set(current).add(`${selected}/${namespace}/${event.name}`))
        }
        setDescribed(await service.describe(selected))
    }

    const toggleWatch = async (namespace: string, event: DescribedEvent) => {
        if (!service || !selected) return
        const key = `${selected}/${namespace}/${event.name}`
        const answer = watching.has(key) ? await service.unwatch(selected, namespace, event.name) : await service.watch(selected, namespace, event.name)
        setWatching((current) => {
            const next = new Set(current)
            if (answer.watching) next.add(key)
            else next.delete(key)
            return next
        })
        if (selected) setDescribed(await service.describe(selected))
    }

    const failed = described && 'error' in described ? described : null
    const description = described && !('error' in described) ? described : null
    const unreadTotal = Object.values(unread).reduce((total, count) => total + count, 0)
    /**
     * How many commands were left in the air.
     *
     * Through the registry's own `select` rather than by reading the whole list here: this is in the
     * tab bar, which re-renders on everything, and a count that changed identity on every call would
     * redraw the entire chrome once per `$data` page.
     */
    const uncertainCount = useMemo(() => operations.select((all) => all.filter((one) => one.status === 'unknown-outcome').length), [operations])
    const uncertain = useSyncExternalStore(uncertainCount.subscribe, uncertainCount.getSnapshot)

    /**
     * The observer on its own.
     *
     * Returned ahead of the console's layout rather than hidden inside it, because these are not two
     * states of one screen: this one has no peer list, no traffic column and no tabs, and the two
     * panes get the whole window instead of the middle third of it. Everything else - the link, the
     * describe, the store, the editors - is the same code, which is the point. It is the same
     * observer, given the room.
     */
    if (observing) {
        const shown = description?.namespaces.find((one) => one.name === observing.namespace)
        return (
            <div className="app observing">
                <header className="observing-head">
                    <h1>
                        <span>{description ? peerDisplayName(description.name, structure[description.name]) : observing.peer}</span>
                        <span className="entity-id mono">
                            {observing.peer} · {observing.namespace}
                        </span>
                    </h1>
                    <span className={`status ${status === 'connected' ? 'ok' : 'warn'}`}>{status}</span>
                    {/* Back to the console *and* to the peer this page was opened from. Without
                        the peer the console reopens with nothing selected, so a reader who came
                        here from a description lands back at a peer list and has to find their way
                        in again - which is a worse answer the deeper they had gone. */}
                    <a className="full-page observing-back" href={`${window.location.pathname}?peer=${encodeURIComponent(observing.peer)}`}>
                        ← console
                    </a>
                </header>
                <main className="observing-body">
                    {failed && <p className="component-error">{failed.error}</p>}
                    {!described && !failed && <p className="muted">Describing {observing.peer}…</p>}
                    {description && !shown && (
                        <p className="muted">
                            {observing.peer} exposes no namespace called {observing.namespace}.
                        </p>
                    )}
                    {description && shown && !shown.component && <p className="muted">{observing.namespace} is a service rather than an observable component.</p>}
                    {description && shown?.component && (
                        <ComponentPanel
                            standalone
                            peer={observing.peer}
                            namespace={shown.name}
                            component={shown.component}
                            methods={shown.methods}
                            types={description.types}
                            server={peer}
                            data={data}
                            onSubscribed={() => {
                                if (service) void service.describe(observing.peer).then(setDescribed).catch(() => undefined)
                            }}
                        />
                    )}
                </main>
            </div>
        )
    }

    return (
        <div className="app">
            <aside>
                {/*
                 * This page is a peer of the network, not a viewer of it - it hosts an RpcServer of
                 * its own - so it says which peer it is, in the one place that is always visible.
                 * The same name appears in the list below, marked, because that is where someone
                 * looking at two consoles side by side will actually compare them.
                 */}
                <div className="identity">
                    <span className="muted">this page is</span>
                    <span className="name">{me ? displayNameForId(me) : '…'}</span>
                    {me && (
                        <span className="mono small-id" title="the peer name this page serves and calls under">
                            {me}
                        </span>
                    )}
                </div>
                <header>
                    <h1>Peers</h1>
                    <span className={`status ${status === 'connected' ? 'ok' : 'warn'}`}>{status}</span>
                </header>
                {peers.length === 0 && <p className="muted">Waiting for a peer to announce itself…</p>}
                {/*
                 * A tree over what the descriptions have taught so far: a peer whose host root is
                 * attached under another renders beneath it, place beside the name. A peer with no
                 * declared structure - or whose parent is not here - sits at the root, which is
                 * where an unknown belongs. The tree grows as the network is used, like the roles.
                 */}
                {(() => {
                    const known = new Set(peers)
                    const roots = peers.filter((name) => {
                        const parent = structure[name]?.parent
                        return !parent || parent === name || !known.has(parent)
                    })
                    const entry = (name: string, depth: number, seen: Set<string>) => (
                        <div key={name}>
                            <button
                                className={`peer${name === selected ? ' selected' : ''}`}
                                style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
                                onClick={() => void select(name)}
                            >
                                <span className={`dot${offline.has(name) ? ' off' : ''}`} />
                                <span className="peer-lines">
                                    <span className="peer-primary">
                                        <span className="peer-display">{peerDisplayName(name, structure[name])}</span>
                                        <span className="peer-id mono">{name}</span>
                                        {name === me && <span className="you">you</span>}
                                        {/* Which peer to select. The tab count says a message is
                                            waiting; without this you would have to click through
                                            every peer to find out whose. */}
                                        {unread[name] > 0 && <span className="count">{unread[name]}</span>}
                                        {/* Learned from a description already made, so peers label
                                            themselves as the network is used rather than by
                                            describing everything on sight. */}
                                        {roles[name] && <span className={`role ${roles[name]}`}>{roles[name] === 'undescribed' ? 'no contract' : roles[name]}</span>}
                                        {/* Which link it was found on. On a plant with the devices
                                            on a broker and the HMIs on a hub, that is the first
                                            thing worth knowing about a peer. */}
                                        {links[name] && links[name] !== 'this console' && <span className="link">{links[name]}</span>}
                                    </span>
                                    {structure[name]?.place && (
                                        <span className="peer-place">
                                            {structure[name]?.place?.join(' / ') ?? ''}
                                        </span>
                                    )}
                                </span>
                            </button>
                            {/* The visited set is the cycle guard: two hosts each claiming the
                                other as parent must not recurse the sidebar to death. */}
                            {!seen.has(name) &&
                                peers
                                    .filter((child) => structure[child]?.parent === name && child !== name)
                                    .map((child) => entry(child, depth + 1, new Set([...seen, name])))}
                        </div>
                    )
                    return roots.map((name) => entry(name, 0, new Set()))
                })()}
            </aside>

            <main>
                {!selected && <p className="muted">Select a peer to see what it exposes.</p>}
                {selected && !described && <p className="muted">Describing {selected}…</p>}
                {failed && (
                    <div className="notice">
                        <strong>{failed.code ?? 'Error'}</strong>
                        <p>{failed.error}</p>
                        <p className="muted">A server answers this only when it is started with exposeIntrospection.</p>
                    </div>
                )}
                {description && (
                    <>
                        <header className="peer-head">
                            <h1>
                                <span>{peerDisplayName(description.name, structure[description.name])}</span>
                                <span className="entity-id mono">{description.name}</span>
                            </h1>
                            <span className="muted">
                                {description.version ? `contract ${description.version} · ` : ''}
                                {description.validating ? 'arguments checked' : 'arguments not checked'}
                            </span>
                        </header>
                        {/* Above everything, and impossible to scroll past. A peer that can do
                            something dangerous says so continuously, so the question "is anything
                            unlocked on this network right now" has an answer without asking. An
                            entry with no `until` is drawn as the worse case, because nothing will
                            close it and somebody has to remember to - which is the failure the
                            whole idea exists to catch. */}
                        {description.elevated?.length ? (
                            <div className="elevated" role="alert">
                                <strong>elevated</strong>
                                {description.elevated.map((one) => (
                                    <span key={one.capability} className={`elevation${one.until === undefined ? ' unbounded' : ''}`}>
                                        <span className="mono">{one.capability}</span>
                                        {one.reason ? ` — ${one.reason}` : ''}
                                        {one.until === undefined ? ' · until someone closes it' : ` · until ${new Date(one.until).toLocaleTimeString()}`}
                                        {one.grantedBy ? ` · by ${one.grantedBy}` : ''}
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        <StructurePanel description={description} peers={peers} onSelectPeer={(other) => void select(other)} />
                        {description.namespaces.map((namespace) => (
                            <section key={namespace.name} className="namespace">
                                <h2>
                                    <span className="entity-title">
                                        <span>{namespaceDisplayName(namespace)}</span>
                                        <span className="entity-id mono">{namespace.name}</span>
                                    </span>
                                    {namespace.version && <span className="badge">@{namespace.version}</span>}
                                    <span className="muted mono">
                                        {namespace.className}
                                        {namespace.created ? ' · created at runtime' : ''}
                                    </span>
                                    {/* From the schema, never the class name above - which a bundle
                                        mangles while the extracted contract stays intact. */}
                                    {namespace.capabilities?.map((capability) => (
                                        <span key={capability} className="capability" title="implements this contract interface">
                                            {capability}
                                        </span>
                                    ))}
                                </h2>
                                {/* Observed by the page itself over its own peer link - the console
                                    relays nothing. Refreshing the description after subscribing is
                                    only so the observer count moves while you watch it. */}
                                {namespace.component && (
                                    <ComponentPanel
                                        peer={selected!}
                                        namespace={namespace.name}
                                        component={namespace.component}
                                        methods={namespace.methods}
                                        types={description.types}
                                        server={peer}
                                        data={data}
                                        onSubscribed={() => {
                                            if (service && selected) void service.describe(selected).then(setDescribed).catch(() => undefined)
                                        }}
                                    />
                                )}
                                {/* A namespace with a place in the topology is a node, and a node
                                    is the thing context is resolved for. One without is just a
                                    service, and has no chain to walk. */}
                                {namespace.topology && <ContextPanel peer={selected!} node={namespace.name} server={peer} />}
                                {namespace.methods.map((method) => (
                                    <MethodPanel
                                        key={method.name}
                                        peer={selected!}
                                        namespace={namespace.name}
                                        method={method}
                                        types={description.types}
                                        service={service!}
                                        network={network}
                                        operations={operations}
                                        relay={relay}
                                    />
                                ))}
                                {namespace.events.length > 0 && (
                                    <div className="events">
                                        <h3>
                                            events
                                            {namespace.events.some((event) => !watching.has(`${selected}/${namespace.name}/${event.name}`)) && (
                                                <button className="toggle" onClick={() => void watchAll(namespace.name, namespace.events)}>
                                                    watch all
                                                </button>
                                            )}
                                        </h3>
                                        {namespace.events.map((event) => {
                                            const on = watching.has(`${selected}/${namespace.name}/${event.name}`)
                                            return (
                                                <div key={event.name} className="event-row">
                                                    <code>
                                                        {event.name}({event.params ? event.params.map(typeText).join(', ') : '…'})
                                                    </code>
                                                    <button className={on ? 'toggle on' : 'toggle'} onClick={() => void toggleWatch(namespace.name, event)}>
                                                        {on ? 'unwatch' : 'watch'}
                                                    </button>
                                                    <span className="muted">
                                                        {event.subscribers} subscriber{event.subscribers === 1 ? '' : 's'}
                                                    </span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </section>
                        ))}
                    </>
                )}
            </main>

            <section className="side">
                {/*
                 * Three views of one column rather than three stacked panes: traffic is a list that
                 * fills, and giving it a third of the height would make it useless on the network
                 * where it matters most.
                 */}
                <nav className="tabs">
                    {(['events', 'operations', 'traffic', 'problems', 'presence', 'chat'] as const).map((name) => (
                        <button key={name} className={tab === name ? 'tab on' : 'tab'} onClick={() => setTab(name)}>
                            {name}
                            {name === 'traffic' && traffic.length > 0 && <span className="count">{traffic.length}</span>}
                            {name === 'problems' && trouble.length > 0 && <span className="count bad">{trouble.length}</span>}
                            {/* The one badge that is not a count of things to read: it is a count of
                                commands nobody knows the outcome of, so it stays until somebody
                                deals with each of them rather than clearing when the tab is opened. */}
                            {name === 'operations' && uncertain > 0 && <span className="count bad">{uncertain}</span>}
                            {name === 'chat' && unreadTotal > 0 && <span className="count">{unreadTotal}</span>}
                        </button>
                    ))}
                </nav>

                {tab === 'chat' && <Chat peer={selected} messages={selected ? (chats[selected] ?? []) : []} onSend={sendChat} />}

                {tab === 'operations' && <Operations operations={operations} />}

                {tab === 'problems' && <Problems problems={trouble} onClear={() => setTrouble([])} />}

                {tab === 'presence' && <Presence changes={comings} onClear={() => setComings([])} />}

                {/* Always mounted, so switching tabs does not drop the tap. See Traffic's `hidden`. */}
                <Traffic
                    service={service}
                    selected={selected}
                    frames={traffic}
                    onClear={() => setTraffic([])}
                    paused={trafficPaused}
                    onPaused={setTrafficPaused}
                    hidden={tab !== 'traffic'}
                />

                {tab === 'events' && (
                    <div className="stream">
                        <header>
                            <h1>Events</h1>
                            <div className="traffic-actions">
                                {stream.length > 0 && (
                                    <button className="toggle" onClick={() => download(stream, 'events.jsonl')} title="save what is here as jsonl">
                                        export
                                    </button>
                                )}
                                {stream.length > 0 && (
                                    <button className="toggle" onClick={() => setStream([])}>
                                        clear
                                    </button>
                                )}
                                <button className={eventsPaused ? 'toggle on' : 'toggle'} onClick={() => setEventsPaused(!eventsPaused)}>
                                    {eventsPaused ? 'paused' : 'pause'}
                                </button>
                            </div>
                        </header>
                        {stream.length > 0 && (
                            <input className="control" placeholder="filter by peer, event or payload" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} />
                        )}
                        {stream.length === 0 && <p className="muted">Watch an event to see it here.</p>}
                        {stream
                            .filter((event) => {
                                const search = eventFilter.trim().toLowerCase()
                                return !search || `${event.peer} ${event.namespace}.${event.event} ${JSON.stringify(event.args)}`.toLowerCase().includes(search)
                            })
                            .map((event, index) => (
                                <div key={`${event.at}-${index}`} className="streamed">
                                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                                    <code>
                                        {event.peer}/{event.namespace}.{event.event}
                                    </code>
                                    <pre>{JSON.stringify(event.args)}</pre>
                                </div>
                            ))}
                    </div>
                )}
            </section>
        </div>
    )
}
