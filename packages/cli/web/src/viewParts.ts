import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { rpcComponent, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcServer } from '@source-repo/rpc'
import { channelsFor, staticSource, storeSource, viewProjection, type DescribedComponent, type ServerDescription, type TypeNode, type ValueSource, type View, type ViewNode } from '@source-repo/react'

/**
 * Turning a view - a list of locators - into something drawable, which is the half that holds links.
 *
 * `ViewPanel` draws parts and opens nothing, the way `Search` merges answers and asks nothing. This
 * is the other side of that line, and it lives in the console because addressing a peer is the
 * application's business: what a name resolves to, which link it travels over, and who is allowed
 * to ask are three questions a UI toolkit has no way to answer and no business guessing at.
 *
 * ## One channel per component, not one per node
 *
 * `channelsFor` does the grouping and this does the opening, so twelve tags from four machines cost
 * four subscriptions. What travels in each is `viewProjection` - the leaves under the nodes chosen
 * from *that* component, and nothing else. A view is the one place narrowing is free: the component
 * panel asks for a whole component because its selection changes with every click, and a view's set
 * does not change until the reader edits it.
 *
 * ## What a channel is keyed on, and why it matters
 *
 * On the peer, the namespace **and the paths**. Removing one node from a view of four changes what
 * the projection should ask for, and a channel keyed only on where it points would keep serving the
 * old projection forever - a subscription quietly wider than the screen, which is the exact cost
 * this is arranged to avoid and the kind that never shows up as a bug.
 */

type Store = RpcComponentStore<RpcComponentData, RpcComponentData>

/**
 * One chosen node, resolved: what the console learnt about it, and where its values come from.
 *
 * Declared here rather than in the toolkit because everything in it is something the console
 * resolved - a description it fetched, a channel it opened - and a type describing the console's
 * own work belongs with the code that does it.
 */
export interface ViewPart {
    readonly node: ViewNode
    /** How the console would name this place, under the display names the rest of it uses. */
    readonly title: string
    /** The contract, once the peer has been described. Absent while that is still happening. */
    readonly component?: DescribedComponent
    readonly types?: { [name: string]: TypeNode }
    readonly source: ValueSource
    /** Why this one cannot be shown: a peer that would not describe itself, or a channel that refused. */
    readonly refusal?: string
}

const NOTHING = staticSource({})

export const useViewParts = (
    view: View,
    server: RefObject<RpcServer | null>,
    describe: (peer: string) => Promise<ServerDescription | { error: string }>,
    title: (peer: string, namespace: string) => string
): readonly ViewPart[] => {
    const channels = useMemo(() => channelsFor(view), [view])
    const [described, setDescribed] = useState<{ readonly [peer: string]: ServerDescription | { error: string } }>({})
    const [stores, setStores] = useState<{ readonly [channel: string]: Store | { error: string } }>({})

    /**
     * Describe each peer the view names, once.
     *
     * The console describes peers lazily - a search does the same - so a view of four peers may name
     * three this page has never asked about. A peer that refuses is remembered as a refusal rather
     * than retried on every render, which is what an unreachable machine would otherwise turn a
     * view into.
     */
    useEffect(() => {
        const missing = [...new Set(channels.map((channel) => channel.peer))].filter((peer) => !(peer in described))
        if (!missing.length) return
        let dropped = false
        void Promise.all(
            missing.map(async (peer) => {
                try {
                    return [peer, await describe(peer)] as const
                } catch (failure) {
                    return [peer, { error: (failure as { message?: string }).message ?? String(failure) }] as const
                }
            })
        ).then((answers) => {
            if (!dropped) setDescribed((held) => ({ ...held, ...Object.fromEntries(answers) }))
        })
        return () => {
            dropped = true
        }
    }, [channels, described, describe])

    /**
     * Open a channel per component, and close the ones the view no longer wants.
     *
     * Held in a ref rather than in state because closing is the point: a store that fell out of a
     * re-render without being closed is a subscription the peer keeps serving to nobody, and the
     * only way to be sure is to hold the open ones somewhere renders cannot lose them.
     */
    const open = useRef(new Map<string, { paths: string; store: Store }>())
    useEffect(() => {
        const link = server.current
        const wanted = new Map<string, { peer: string; namespace: string; paths: string[][] }>()
        for (const channel of channels) {
            const description = described[channel.peer]
            if (!description || 'error' in description) continue
            const namespace = description.namespaces.find((one) => one.name === channel.namespace)
            if (!namespace?.component) continue
            const paths = viewProjection(channel.nodes, namespace.component, description.types)
            if (paths.length) wanted.set(`${channel.peer}/${channel.namespace}`, { peer: channel.peer, namespace: channel.namespace, paths })
        }

        for (const [key, held] of [...open.current])
            if (!wanted.has(key) || wanted.get(key)!.paths.map((path) => path.join('.')).join(',') !== held.paths) {
                void held.store.close()
                open.current.delete(key)
                setStores((all) => Object.fromEntries(Object.entries(all).filter(([held]) => held !== key)))
            }

        let dropped = false
        for (const [key, want] of wanted) {
            if (open.current.has(key) || !link) continue
            const paths = want.paths.map((path) => path.join('.')).join(',')
            // Marked open before the await, so a second render in the same tick cannot start a
            // second channel to the same component - which would leak the first.
            open.current.set(key, { paths, store: undefined as unknown as Store })
            void link
                .component<RpcComponentLike>(want.namespace, want.peer, { paths: want.paths })
                .then((remote) => {
                    const store = remote[rpcComponent] as Store
                    if (dropped || open.current.get(key)?.paths !== paths) return void store.close()
                    open.current.set(key, { paths, store })
                    setStores((all) => ({ ...all, [key]: store }))
                })
                .catch((failure: { message?: string }) => {
                    open.current.delete(key)
                    if (!dropped) setStores((all) => ({ ...all, [key]: { error: failure.message ?? String(failure) } }))
                })
        }
        return () => {
            dropped = true
        }
    }, [channels, described, server])

    // Every channel closed when the view is left, for the same reason the component panel closes its
    // one: a page that navigated away while a peer kept publishing to it is a leak nobody sees.
    useEffect(() => {
        const holding = open.current
        return () => {
            for (const held of holding.values()) void held.store?.close()
            holding.clear()
        }
    }, [])

    return useMemo(
        () =>
            view.map((node) => {
                const description = described[node.peer]
                const channel = stores[`${node.peer}/${node.namespace}`]
                const namespace = description && !('error' in description) ? description.namespaces.find((one) => one.name === node.namespace) : undefined
                const refusal =
                    description && 'error' in description
                        ? `${node.peer} could not be described: ${description.error}`
                        : description && !namespace
                          ? `${node.peer} no longer serves ${node.namespace}`
                          : namespace && !namespace.component
                            ? `${node.namespace} is a service rather than an observable component`
                            : channel && 'error' in channel
                              ? `could not observe ${node.namespace}: ${channel.error}`
                              : undefined
                return {
                    node,
                    title: title(node.peer, node.namespace),
                    component: namespace?.component,
                    types: description && !('error' in description) ? description.types : undefined,
                    source: channel && !('error' in channel) ? storeSource(channel, []) : NOTHING,
                    ...(refusal ? { refusal } : {})
                }
            }),
        [view, described, stores, title]
    )
}
