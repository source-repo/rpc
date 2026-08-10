import { RefObject, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { rpcComponent, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcGetListParams, type RpcGetListResult, type RpcServer } from '@source-repo/rpc'
import { staticSource, storeSource, type EditAffordance } from './ValueTree'
import { ScopeTree } from './ScopeTree'
import { ValueGrid, type FetchPage } from './ValueGrid'
import { leavesUnder, scopeTree } from './scope'
import type { DescribedComponent, DescribedMethod, TypeNode } from './types'

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

/** Just the DataProvider verb, so the panel needs no generic over the component's own class. */
type DataProxy = { $data(method: 'getList', resource: readonly string[], params?: RpcGetListParams): Promise<RpcGetListResult> }

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
const Revision = ({ store }: { store: Store }) => {
    const view = useSyncExternalStore(
        useCallback((listener: () => void) => store.subscribe(listener), [store]),
        useCallback(() => store.getSnapshot(), [store])
    )
    if (view.receivedAt === 0) return null
    return (
        <span className="muted">
            rev {view.revision} ·{' '}
            {view.status === 'stale' && view.staleSince
                ? `last known ${new Date(view.receivedAt).toLocaleTimeString()}, stale since ${new Date(view.staleSince).toLocaleTimeString()}`
                : `updated ${new Date(view.receivedAt).toLocaleTimeString()}`}
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

/** Nothing to read from until a channel is open, and a component may legitimately never have one. */
const NOTHING = staticSource({})

export const ComponentPanel = ({
    peer,
    namespace,
    component,
    methods,
    types,
    server,
    onSubscribed
}: {
    peer: string
    namespace: string
    component: DescribedComponent
    /** This namespace's described methods, which is where the editors come from. */
    methods: DescribedMethod[]
    /** Named types from the contract, for resolving the refs inside props and state. */
    types?: { [name: string]: TypeNode }
    /** The page's own RpcServer - the peer this page is - read at observe time, like sendChat. */
    server: RefObject<RpcServer | null>
    /** The peer's observer count just changed, so a re-describe will show it moving. */
    onSubscribed?: () => void
}) => {
    const [store, setStore] = useState<Store | null>(null)
    const [observing, setObserving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [pending, setPending] = useState<string | undefined>()
    const [failed, setFailed] = useState<{ path: string; message: string } | undefined>()
    const [scope, setScope] = useState<string[]>(['state'])
    const [period, setPeriod] = useState<number | undefined>(5000)
    /** Bumped when a call settles, which is what makes the affected page refetch at once. */
    const [settled, setSettled] = useState(0)

    const status = useChannelFact(store, statusOf, undefined)

    const tree = useMemo(() => scopeTree(component, types), [component, types])

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

    const stop = () => {
        setStore(null)
        setObserving(false)
        onSubscribed?.()
    }

    /**
     * One page of one collection, asked for rather than subscribed to.
     *
     * Read from the link at call time like every other call this panel makes, so a page turn during
     * a reconnect uses the link that exists then rather than one captured when the pane opened.
     */
    const fetchPage: FetchPage = async (resource, page, pageSize, filter) => {
        const link = server.current
        if (!link) throw new Error('no link')
        const proxy = await link.proxy<DataProxy>(namespace, peer)
        return proxy.$data('getList', resource, { pagination: { page, pageSize }, ...(filter ? { filter } : {}) })
    }

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
                    setPending(path.join('.'))
                    setFailed(undefined)
                    try {
                        const proxy = await link.proxy<Record<string, (...args: unknown[]) => Promise<unknown>>>(namespace, peer)
                        // The generic form is told where to write; the per-field one already knows.
                        await (generic ? proxy[method.name](path, value) : proxy[method.name](value))
                        // Nothing is written locally on success. The value on screen changes when
                        // the component publishes its next snapshot, which is the only report that
                        // the plant agrees - an optimistic row would show a setpoint the oven
                        // refused. A subscribed leaf gets that by itself; a polled page would not
                        // until its period came round, so it is asked again now. Waiting five
                        // seconds to learn whether the plant accepted a command is the one place
                        // a period is plainly wrong.
                        setSettled((count) => count + 1)
                    } catch (e) {
                        setFailed({ path: path.join('.'), message: (e as { message?: string }).message ?? String(e) })
                    } finally {
                        setPending(undefined)
                    }
                }
            }
        },
        ...(pending ? { pending } : {}),
        ...(failed ? { failed } : {})
    }

    const stale = status === 'stale'
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
            </div>
            {error && <p className="component-error">{error}</p>}
            {!observing && !error && <p className="muted">Cached props and state, read without a call. Observe to subscribe.</p>}
            {observing && (
                <div className="component-body">
                    <div className="scope-pane">
                        <h4>scope</h4>
                        <ScopeTree nodes={tree} selected={scope.join('.')} onSelect={setScope} />
                    </div>
                    <div className="value-table">
                        <h4>{scope.join('.')}</h4>
                        <ValueGrid component={component} types={types} scope={scope} source={source} edit={edit} fetchPage={fetchPage} period={period} settled={settled} />
                    </div>
                </div>
            )}
        </div>
    )
}
