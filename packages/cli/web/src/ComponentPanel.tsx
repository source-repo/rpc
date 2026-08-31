import { RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { rpcComponent, type RpcCallOptions, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcMethodSemantics, type RpcServer } from '@source-repo/rpc'
import type { RpcDataCache } from '@source-repo/query'
import { Uncertain, useCommanding } from './command'
import { SourceView, type SourceDocument } from './SourceView'
import { overlayRefusal, type RpcSourceBinding, type RpcSourceCatalogue, type RpcActiveSourceIdentity } from '@source-repo/diagnostics/catalogue'
import { staticSource, storeSource, type EditAffordance } from './ValueTree'
import { ScopeTree } from './ScopeTree'
import { ValueGrid, type PageQuestion } from './ValueGrid'
import type { BranchQuestion, RowQuestion } from './ResourceTree'
import type { ObjectAccess, Link, Ref, Where } from './ObjectPanel'
import { actionsFor, leavesUnder, scopeTree } from './scope'
import type { DescribedAction, DescribedComponent, DescribedMethod, TypeNode } from './types'

/**
 * An observable component, rendered from the library's own store and against its own contract.
 *
 * The page is a peer, so it observes the way any peer does: component() over its own link, the
 * shared channel, the epoch/revision acceptance rules - not a feed the console re-serves. What
 * this panel adds is only rendering: the channel status beside the values, last-known data kept
 * visible while stale - because "20 °C, stale since 14:03" is an answer and a blank is not - and
 * the two panes drawn from the props and state interfaces the contract publishes.
 *
 * **Two panes, and two ways of getting the data, split on the same line.** The left pane is scope:
 * the typed containers the contract names, drawn before any value arrives and costing nothing on
 * the wire. The right pane is values, flat, everything beneath the selection recursively. Within
 * it, typed leaves are *subscribed* to - the contract bounds how many there are - and collections
 * are *asked* for a page at a time, because a record's keys are data and nothing can name page two
 * without first receiving all three hundred entries. Type ends, data begins.
 *
 * Which is why the subscription here names paths rather than taking the whole snapshot: a panel
 * that pulled fifty rows while its subscription pushed all three hundred would look exactly like
 * the feature working.
 *
 * Editing is the same principle from the other side: a value is not written, a method is called.
 *
 * **Which method is read from the contract, never guessed from a name.** A method declaring
 * `@rpc({ sets: 'setpoint' })` is the only thing that puts an editor on `setpoint`. The panel used
 * to look for a one-argument `set<Field>` instead, which is right almost always - the residue being
 * methods like `setMode`, which may begin a transition with an interlock behind it rather than
 * assign `state.mode`, or `setPressure` beside a measured `state.pressure`. A guess that is wrong
 * is wrong silently and in the direction of commanding a plant, so the claim is now the author's:
 * a peer that declares nothing offers no editors at all.
 *
 * The row still proposes the *call* and shows it in full before it is sent - what the operator
 * commits is `setSetpoint(180)`, not "the setpoint" - because a declared path says which method
 * changes a value, not that the value is a writable field. See notes/setting-state-from-a-console.md.
 */

type Store = RpcComponentStore<RpcComponentData, RpcComponentData>

/** Just what the source view asks for, so the panel needs no generic over the diagnostics class. */
type DiagnosticsProxy = {
    bindings(componentType: string): Promise<readonly RpcSourceBinding[]>
    activeSource(componentType: string): Promise<RpcActiveSourceIdentity | undefined>
    source(fileId: string): Promise<{ fileId: string; text: string; contentHash: string }>
    catalogue(): Promise<RpcSourceCatalogue>
}

/** How to call whatever claims a path: the method, and whether the path travels as an argument. */
type Setter = { method: DescribedMethod; generic: boolean }

/**
 * The method that claims this path, when one does.
 *
 * A declaration and nothing else: `sets` is matched against the path the row draws, so a nested
 * `zones.top.setpoint` is reachable where the old naming rule could only ever see a top-level field.
 *
 * A per-field claim wins over a generic one where both exist, and it should: the specific method is
 * the one whose body was written for that value, with whatever clamp and interlock belong to it,
 * where the generic setter is the blunt instrument that happens to reach the same place.
 *
 * The parameter counts are what stop a row inventing arguments. A per-field setter takes exactly the
 * one value this row sends; a generic one takes the path and the value and nothing else. Anything
 * with a third parameter changes something the row cannot describe, and guessing it is how a console
 * writes something nobody asked for. A method with *no* described signature is not refused, though:
 * a peer serving no schema publishes its declarations and no parameter lists, and the declaration is
 * the claim - the count only refines it where the contract carries one.
 */
const takesArguments = (method: DescribedMethod, count: number) => method.params === undefined || method.params.length === count

const setterMethod = (path: string[], methods: DescribedMethod[]): Setter | undefined => {
    const wanted = path.join('.')
    const named = methods.find((method) => method.sets === wanted && takesArguments(method, 1))
    if (named) return { method: named, generic: false }
    // `sets: '*'` reaches this host only when it opted in - describe() withholds the claim
    // otherwise - so an editor drawn from one is an editor the next call will actually accept.
    const generic = methods.find((method) => method.sets === '*' && takesArguments(method, 2))
    return generic ? { method: generic, generic: true } : undefined
}

/**
 * One fact *about* the channel, never a value in it.
 *
 * Each of these is a primitive, so useSyncExternalStore compares it and bails out - which is what
 * keeps a snapshot that moved a temperature from re-rendering the panel, and therefore from
 * re-rendering the grid underneath it. Without this the arrangement below is pointless at the top:
 * one spinning tag would redraw every one of its siblings by way of their parent.
 */
const useChannelFact = <T,>(store: Store | null, select: (view: ReturnType<Store['getSnapshot']>) => T, absent: T): T =>
    useSyncExternalStore(
        useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => undefined), [store]),
        useCallback(() => (store ? select(store.getSnapshot()) : absent), [store, select, absent])
    )

/** Hoisted, so their identity is stable and the read is not rebuilt on every render. */
const statusOf = (view: ReturnType<Store['getSnapshot']>) => view.status

/**
 * The one line that legitimately moves on every snapshot, so it moves on its own. Three words in
 * a span is a cheap thing to redraw at ten hertz; three hundred rows is not.
 */
const at = (time: number) => new Date(time).toLocaleTimeString()

const Revision = ({ store }: { store: Store }) => {
    const view = useSyncExternalStore(
        useCallback((listener: () => void) => store.subscribe(listener), [store]),
        useCallback(() => store.getSnapshot(), [store])
    )
    if (view.receivedAt === 0) return null
    const updated = at(view.receivedAt)
    const confirmed = at(view.confirmedAt)
    return (
        <span className="muted">
            rev {view.revision} ·{' '}
            {view.status === 'stale' && view.staleSince
                ? `last known ${updated}, stale since ${at(view.staleSince)}`
                : // Two facts where they differ, one where they do not. A component that has not
                  // moved since 14:03 and answered a re-subscribe at 14:19 is current *and* three
                  // quarters of an hour old, and an operator reading one number cannot tell which
                  // of those they are looking at.
                  confirmed === updated
                  ? `updated ${updated}`
                  : `updated ${updated}, confirmed ${confirmed}`}
        </span>
    )
}

/** What an operator may spend on staying current. `undefined` is manual, which a long link wants. */
const PERIODS: { label: string; ms: number | undefined }[] = [
    { label: '1s', ms: 1000 },
    { label: '5s', ms: 5000 },
    { label: '30s', ms: 30000 },
    { label: 'manual', ms: undefined }
]

/**
 * What every command from this panel carries.
 *
 * The key is what makes a retry the same command. The semantics travel nowhere and decide nothing -
 * they are the caller's claim, kept so the operations registry can show beside an uncertain outcome
 * that *this one was a non-repeatable command*, rather than offering an operator six identical rows.
 */
const commandOptions = (idempotencyKey: string, semantics: string | undefined): RpcCallOptions => ({
    idempotencyKey,
    ...(semantics ? { semantics: semantics as RpcMethodSemantics } : {})
})

/** Nothing to read from until a channel is open, and a component may legitimately never have one. */
const NOTHING = staticSource({})

export const ComponentPanel = ({
    peer,
    namespace,
    component,
    methods,
    types,
    server,
    data,
    onSubscribed,
    standalone
}: {
    peer: string
    namespace: string
    /**
     * This panel is the whole page rather than one section of a peer's description.
     *
     * Two differences follow. It offers no link to itself, and it starts observing on its own -
     * because a page whose entire purpose is this observer, opened onto a wall display, is wrong
     * on that wall until somebody walks over and presses a button.
     */
    standalone?: boolean
    component: DescribedComponent
    /** This namespace's described methods, which is where the editors come from. */
    methods: DescribedMethod[]
    /** Named types from the contract, for resolving the refs inside props and state. */
    types?: { [name: string]: TypeNode }
    /** The page's own RpcServer - the peer this page is - read at observe time, like sendChat. */
    server: RefObject<RpcServer | null>
    /** The page's one cache. Holds the answers, and decides whether a period tick asks anything. */
    data: RpcDataCache
    /** The peer's observer count just changed, so a re-describe will show it moving. */
    onSubscribed?: () => void
}) => {
    const [store, setStore] = useState<Store | null>(null)
    const [observing, setObserving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState<{ path: string; message: string } | undefined>()
    /**
     * Every command this panel sends, and the key that makes a second attempt at one the *same*
     * command rather than another one. Shared by the editors and the row actions, because an
     * operator has one hand and can only be waiting on one of them.
     */
    const commanding = useCommanding()
    const pending = commanding.pending
    const [period, setPeriod] = useState<number | undefined>(5000)
    /**
     * The component's own source, with its values beside the lines that declare them.
     *
     * Fetched on request rather than when the panel opens, because reading a peer's source is a
     * disclosure with its own permission - and a panel that asked for it every time somebody looked
     * at a setpoint would be asking for it on their behalf.
     */
    const [listing, setListing] = useState<{ document: SourceDocument; bindings: readonly RpcSourceBinding[]; refusal?: string } | null>(null)
    const [sourceError, setSourceError] = useState<string | null>(null)
    const [fetching, setFetching] = useState(false)

    const status = useChannelFact(store, statusOf, undefined)

    const tree = useMemo(() => scopeTree(component, types), [component, types])
    // Nothing under any root: a list of choices rather than a hierarchy to walk.
    const flatScope = tree.length > 0 && tree.every((node) => !node.children.length)

    /**
     * State first where there is one, and otherwise whatever the tree begins with.
     *
     * A component that is purely a data source - a table, a queue - may publish no state at all, and
     * opening it on a root that does not exist would show an empty grid beside a tree that plainly
     * has something in it.
     */
    const [scope, setScope] = useState<string[]>(() => (component.state ? ['state'] : (tree[0]?.path ?? ['state'])))

    /**
     * What the subscription asks for: every typed leaf in the whole component, and no collection.
     *
     * The whole component rather than the current scope, because the contract bounds this set - that
     * is the entire argument for subscribing to it - so narrowing it per selection would buy nothing
     * and would make every click a re-subscribe, which one peer per component cannot do in place.
     *
     * A component whose state is *only* a record has no typed leaves at all, and asks for no
     * subscription rather than falling back to the whole snapshot - which would fetch the very
     * record the grid exists to page.
     */
    const projection = useMemo(
        () =>
            (['props', 'state'] as const)
                .flatMap((root) => (component[root] ? leavesUnder(component[root], [root], types) : []))
                .filter((leaf) => !leaf.collection)
                .map((leaf) => leaf.path),
        [component, types]
    )

    const source = useMemo(() => (store ? storeSource(store, []) : NOTHING), [store])

    // The one place the channel is released: stopping sets store to null and unmounting does the
    // same implicitly, so switching peers cannot leak a subscription the server keeps serving.
    useEffect(() => () => void store?.close(), [store])

    /**
     * Hand the channel to the cache, so a page can be told it is *current* rather than given an age.
     *
     * The cache opens nothing itself, deliberately - subscribing to a whole snapshot in order to
     * learn a revision would spend exactly what the pull half exists to save - so it takes the
     * signal from the channel this panel already has. Where there is none, and a component with no
     * typed leaves legitimately has none, every page here reads `age unknown` and says so.
     */
    useEffect(() => {
        if (!store) return
        return data.observe(peer, namespace, store)
    }, [data, store, peer, namespace])

    const observe = async () => {
        const link = server.current
        if (!link) return
        setBusy(true)
        setError(null)
        try {
            if (projection.length) {
                const remote = await link.component<RpcComponentLike>(namespace, peer, { paths: projection })
                setStore(remote[rpcComponent] as Store)
            }
            setObserving(true)
            onSubscribed?.()
        } catch (e) {
            setError((e as { message?: string }).message ?? String(e))
        } finally {
            setBusy(false)
        }
    }

    /**
     * Observe once, unprompted, when this panel is the page.
     *
     * Guarded by a ref rather than by the dependency list: `observe` is rebuilt on every render, so
     * an effect that watched it would fire on every render, and one that did not would be a lie
     * about what it reads. The ref says plainly that this happens once per mount.
     */
    const startedItself = useRef(false)
    useEffect(() => {
        if (!standalone || startedItself.current) return
        startedItself.current = true
        void observe()
    }, [standalone, observe])

    const stop = () => {
        setStore(null)
        setObserving(false)
        onSubscribed?.()
    }

    /**
     * Doing it: an ordinary call to the component's own method, with the row's id.
     *
     * Nothing is written locally on success, for the same reason an editor writes nothing - the
     * only report that the component agrees is what it says next time it is asked. Which is now,
     * rather than a period from now.
     *
     * **What is asked again is the resource this button belongs to, and nothing else.** The action
     * came from that resource's own `actions` list, so where the button lives is a structural fact
     * about what it touched rather than a guess. What this replaces is a counter that made every
     * collection in the pane a different question after any successful call - one round trip per
     * collection, on the link least able to spare it, for a command that touched one row.
     */
    const runAction = async (action: DescribedAction, id: string, resource: readonly string[]) => {
        const link = server.current
        if (!link) return
        // The author says which of its methods are final; a console guessing from the word
        // "discard" would be guessing about a plant.
        if (action.confirm && !window.confirm(`${action.method}(${id})?`)) return
        setFailed(undefined)
        await commanding
            .run(id, async (idempotencyKey) => {
                const proxy = await link.proxy<Record<string, (...args: unknown[]) => Promise<unknown>>>(namespace, peer)
                await proxy.$with(commandOptions(idempotencyKey, methods.find((one) => one.name === action.method)?.semantics))[action.method](id)
                data.settled({ target: peer, namespace, resource })
            })
            .catch((e) => setFailed({ path: id, message: (e as { message?: string }).message ?? String(e) }))
    }

    /**
     * Ask the peer where this component's values are written, and for the file that says so.
     *
     * Two calls and a comparison. What makes it safe is the comparison: a value drawn beside source
     * that is not the source that is running is a number somebody will act on, positioned by a line
     * that means something else - so a mismatch shows the file with the reason and no values at all,
     * rather than approximating.
     */
    const openSource = async () => {
        const link = server.current
        if (!link) return
        setFetching(true)
        setSourceError(null)
        try {
            const diagnostics = await link.proxy<DiagnosticsProxy>('diagnostics', peer)
            const [bindings, identity] = await Promise.all([diagnostics.bindings(namespace), diagnostics.activeSource(namespace)])
            if (!identity) throw new Error(`${peer} serves diagnostics and does not describe ${namespace}`)
            const first = bindings.find((binding) => binding.spans.length > 0)
            if (!first) throw new Error(`${namespace} declares no props or state this build could place in source`)
            const file = await diagnostics.source(first.fileId)
            // The node's own catalogue is what the comparison is against, and it is asked for here
            // rather than carried: a viewer holding a catalogue from a previous deploy is exactly
            // the case being guarded.
            const catalogue = await diagnostics.catalogue()
            const refusal = overlayRefusal(catalogue, identity, { fileId: file.fileId, contentHash: file.contentHash })
            setListing({ document: { fileId: file.fileId, text: file.text }, bindings, ...(refusal ? { refusal } : {}) })
        } catch (e) {
            setSourceError((e as { message?: string }).message ?? String(e))
        } finally {
            setFetching(false)
        }
    }

    /**
     * One page of one collection, *named* rather than fetched.
     *
     * The panel says which question a grid is showing and the cache decides what asking it costs -
     * which is the whole of the change: two panes on the same page ask it once, a page turned back
     * to is answered from what is held, and a period tick over a page the component has published
     * nothing since costs nothing at all.
     */
    const pageQuestion: PageQuestion = (resource, page, pageSize, filter, sort) => ({
        target: peer,
        namespace,
        method: 'getList',
        resource,
        params: { pagination: { page, pageSize }, ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) }
    })

    /**
     * One branch of a tree resource, named the same way and answered from the same cache.
     *
     * An absent `parentId` is the roots, and it is left out of the params rather than sent as
     * empty - the two are different questions, and the cache keys on what is actually asked.
     */
    /**
     * Opening an object and following its links, as ordinary calls on the provider.
     *
     * `follow` is answered by the peer rather than worked out here, and that is not layering for its
     * own sake: only the provider knows where an object appears, and a console that tried would have
     * to fetch the whole structure to find out - the walk the tree verb exists to avoid.
     */
    const objectAccess: ObjectAccess = {
        open: async (target: Ref) => {
            const link = server.current
            if (!link) throw new Error('no link to this peer')
            const face = await link.proxy<{ openObject(target: Ref): Promise<never> }>(namespace, peer)
            return face.openObject(target)
        },
        follow: async (following: Link, from: Where | undefined) => {
            const link = server.current
            if (!link) throw new Error('no link to this peer')
            const face = await link.proxy<{ follow(link: Link, from?: Where): Promise<never> }>(namespace, peer)
            return face.follow(following, from)
        }
    }

    const branchQuestion: BranchQuestion = (resource, parentId, page, pageSize) => ({
        target: peer,
        namespace,
        method: 'getChildren',
        resource,
        params: { pagination: { page, pageSize }, ...(parentId !== undefined ? { parentId } : {}) }
    })

    /**
     * One row, opened on its own.
     *
     * Watched on the same period as the pane it was opened from, rather than fetched once: the
     * fields a table has no room for are usually the ones that move - error counts, overruns, the
     * text of the last failure - and a panel frozen at the moment it was opened would be showing an
     * operator a plant that has since changed.
     */
    const rowQuestion: RowQuestion = (resource, id) => ({ target: peer, namespace, method: 'getOne', resource, params: { id } })

    /**
     * State only: props are the host's inputs and are not the caller's to set. Depth is no longer
     * the limit it was - a declaration can name `zones.top.setpoint` - so a path renders with an
     * editor exactly when some method claims it, and without one when none does, which is the
     * honest answer rather than a guess that ran out of rope.
     */
    const edit: EditAffordance = {
        setterFor: (path) => {
            const setter = setterMethod(path, methods)
            if (!setter) return undefined
            const { method, generic } = setter
            return {
                method: method.name,
                call: async (value: unknown) => {
                    const link = server.current
                    if (!link) return
                    setFailed(undefined)
                    await commanding
                        .run(path.join('.'), async (idempotencyKey) => {
                            const proxy = await link.proxy<Record<string, (...args: unknown[]) => Promise<unknown>>>(namespace, peer)
                            const commanded = proxy.$with(commandOptions(idempotencyKey, method.semantics))
                            // The generic form is told where to write; the per-field one already knows.
                            await (generic ? commanded[method.name](path, value) : commanded[method.name](value))
                            // Nothing is written locally on success. The value on screen changes when
                            // the component publishes its next snapshot, which is the only report that
                            // the plant agrees - an optimistic row would show a setpoint the oven
                            // refused. A subscribed leaf gets that by itself; a pulled page would not
                            // until its period came round, so what this method claims to have changed
                            // is asked again now. Waiting five seconds to learn whether the plant
                            // accepted a command is the one place a period is plainly wrong.
                            //
                            // The path is the claim, and it came from a `sets` declaration - an editor
                            // is drawn on this row precisely because some method said it writes here.
                            // A page of a record elsewhere in the same component is not re-asked, which
                            // is what the counter this replaces could not express.
                            data.settled({ target: peer, namespace, resource: path })
                        })
                        .catch((e) => setFailed({ path: path.join('.'), message: (e as { message?: string }).message ?? String(e) }))
                }
            }
        },
        ...(pending ? { pending } : {}),
        ...(failed ? { failed } : {})
    }

    const stale = status === 'stale'
    const fullPageHref = `${window.location.pathname}?observe=${encodeURIComponent(peer)}&ns=${encodeURIComponent(namespace)}`
    return (
        <div className={`component${stale ? ' stale' : ''}`}>
            <div className="component-head">
                <span className="comp-label">component</span>
                {status && <span className={`status-badge ${status}`}>{status}</span>}
                {store && <Revision store={store} />}
                <span className="muted">
                    {component.subscribers} observer{component.subscribers === 1 ? '' : 's'}
                </span>
                {observing && (
                    <select className="period" value={String(period)} onChange={(event) => setPeriod(PERIODS.find((option) => String(option.ms) === event.target.value)?.ms)} title="how often a page is asked for again">
                        {PERIODS.map((option) => (
                            <option key={option.label} value={String(option.ms)}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                )}
                {!observing && (
                    <button className="toggle" onClick={() => void observe()} disabled={busy}>
                        {busy ? 'observing…' : 'observe'}
                    </button>
                )}
                {observing && (
                    <button className="toggle on" onClick={stop}>
                        stop
                    </button>
                )}
                {/* An anchor rather than a button, so it behaves like the address it is: middle-click
                    opens it beside the console, ctrl-click in a new tab, right-click copies
                    something somebody can put on a wall display or leave in a runbook. The current
                    pathname is kept because a console mounted under a base path serves this page
                    from the same place. */}
                {!standalone && (
                    <a className="full-page" href={fullPageHref} title={`observe ${namespace} on a page of its own`}>
                        full page ↗
                    </a>
                )}
            </div>
            {error && <p className="component-error">{error}</p>}
            {/* Above the panes rather than beside the row that failed: a command whose outcome
                nobody knows is a fact about the component, not about the field it was aimed at, and
                a row can be scrolled away from while this must not be. */}
            <Uncertain commanding={commanding} />
            {!observing && !error && <p className="muted">Cached props and state, read without a call. Observe to subscribe.</p>}
            {observing && (
                <div className="component-body">
                    {/* A pane when the scope has depth, a selector when it has not.
                     *
                     * `props` and `state` are a real hierarchy and the tree is the way to read one.
                     * A provider that has neither - an aspect provider, a rack, anything whose
                     * scope is a list of the resources it serves - gets roots with no children,
                     * and a tree of those is a flat list wearing a tree's clothes, holding a whole
                     * column to do it. Derived from the scope rather than declared, because a list
                     * of choices with nothing under them is something the console can see for
                     * itself.
                     *
                     * The choice matters more on such a node, not less: on an aspect provider it is
                     * the choice of *which structure* is being looked at, which is the most
                     * consequential control on the screen. So it moves to the top of it. */}
                    {flatScope ? (
                        <div className="scope-pick">
                            <label className="muted" htmlFor="scope-pick">
                                scope
                            </label>
                            <select id="scope-pick" className="period" value={scope.join('.')} onChange={(event) => setScope(tree.find((node) => node.path.join('.') === event.target.value)?.path ?? scope)}>
                                {tree.map((node) => (
                                    <option key={node.path.join('.')} value={node.path.join('.')}>
                                        {node.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : (
                        <div className="scope-pane">
                            <h4>scope</h4>
                            <ScopeTree nodes={tree} selected={scope.join('.')} onSelect={setScope} />
                        </div>
                    )}
                    <div className="value-table">
                        <h4>
                            {listing ? listing.document.fileId : scope.join('.')}
                            {/* Asked for rather than fetched when the panel opens: reading a peer's
                                source is its own disclosure, and a panel that took it every time
                                somebody looked at a setpoint would be taking it on their behalf. */}
                            <button className="toggle" onClick={() => (listing ? setListing(null) : void openSource())} disabled={fetching} title="the component's own source, with these values beside the lines that declare them">
                                {fetching ? 'reading…' : listing ? 'values' : 'source'}
                            </button>
                        </h4>
                        {sourceError && <p className="component-error">{sourceError}</p>}
                        {listing ? (
                            // The same snapshot the grid draws from, so the source view opens no
                            // channel of its own and can show nothing the grid could not.
                            <SourceView document={listing.document} bindings={listing.bindings} source={source} stale={stale} refusal={listing.refusal} />
                        ) : (
                            <ValueGrid component={component} types={types} scope={scope} source={source} edit={edit} branchQuestion={branchQuestion} rowQuestion={rowQuestion} objectAccess={objectAccess} cache={data} pageQuestion={pageQuestion} period={period} actionsFor={(path) => actionsFor(component, path, methods)} onAction={(action, id, resource) => void runAction(action, id, resource)} />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
