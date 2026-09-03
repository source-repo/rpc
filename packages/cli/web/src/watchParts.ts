import { RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { rpcComponent, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcServer } from '@source-repo/rpc'
import { channelsFor, staticSource, storeSource, watchKey, watchProjection, type DescribedComponent, type ServerDescription, type TypeNode, type ValueSource, type Watch, type WatchNode } from '@source-repo/react'

/**
 * Turning a watch list - a list of locators - into something drawable, which is the half that holds
 * links.
 *
 * `WatchPane` draws parts and opens nothing, the way `Search` merges answers and asks nothing. This
 * is the other side of that line, and it lives in the console because addressing a peer is the
 * application's business: what a name resolves to, which link it travels over, and who may ask are
 * three questions a UI toolkit has no way to answer and no business guessing at.
 *
 * ## Only what is open is observed
 *
 * The list says what sections exist; `observed` says which of them somebody has actually opened, and
 * **only those cost anything**. That one split is what decides how large a watch list may be, and it
 * was the missing piece behind an argument this code lost: that a set derived from the whole network
 * is too big to be useful. The number of *headings* is nothing - a heading is a peer name, a
 * namespace and a path, all of which are already known. What costs is a channel and a question per
 * section, and holding one for something nobody has opened is the actual defect. Once a closed
 * section costs nothing, the size of the list stops being the interesting number.
 *
 * ## One channel per component, not one per node
 *
 * `channelsFor` groups and this opens, so twelve tags from four machines cost four subscriptions.
 * What travels in each is `watchProjection` - the leaves under the nodes chosen from *that*
 * component, and nothing else. A watch list is the one place narrowing is free: the component panel
 * asks for a whole component because its selection changes with every click, and a watch list's set
 * does not change until the reader edits it.
 *
 * ## What a channel is keyed on, and why it matters
 *
 * On the peer, the namespace **and the paths**. Closing one section of four changes what the
 * projection should ask for, and a channel keyed only on where it points would go on serving the
 * old one forever - a subscription quietly wider than the screen, which is the exact cost this is
 * arranged to avoid and the kind that never shows up as a bug.
 */

type Store = RpcComponentStore<RpcComponentData, RpcComponentData>

const NOTHING = staticSource({})

/**
 * One node of the list, resolved: what the console learnt about it, and where its values come from.
 *
 * Declared here rather than in the toolkit because everything in it is something the console
 * resolved - a description it fetched, a channel it opened - and a type describing the console's own
 * work belongs beside the code that does it.
 */
export interface WatchPart {
    readonly node: WatchNode
    /** How the console would name this place, under the display names the rest of it uses. */
    readonly title: string
    /** Whether somebody has opened this section, which is the same question as whether it costs anything. */
    readonly observed: boolean
    /** The contract, once the peer has been described. Absent while that is still happening. */
    readonly component?: DescribedComponent
    readonly types?: { [name: string]: TypeNode }
    readonly source: ValueSource
    /** Why this one cannot be shown: a peer that would not describe itself, or a channel that refused. */
    readonly refusal?: string
}

export const useWatchParts = (
    nodes: Watch,
    observed: ReadonlySet<string>,
    server: RefObject<RpcServer | null>,
    known: { readonly [peer: string]: ServerDescription },
    refusals: { readonly [peer: string]: string },
    title: (peer: string, namespace: string) => string
): readonly WatchPart[] => {
    const watched = useMemo(() => nodes.filter((node) => observed.has(watchKey(node))), [nodes, observed])
    const channels = useMemo(() => channelsFor(watched), [watched])
    const [stores, setStores] = useState<{ readonly [channel: string]: Store | { error: string } }>({})

    /**
     * Open a channel per component, and close the ones nothing is looking at any more.
     *
     * Held in a ref rather than in state because closing is the point: a store that fell out of a
     * re-render without being closed is a subscription the peer keeps serving to nobody, and the
     * only way to be sure is to hold the open ones where renders cannot lose them.
     */
    const open = useRef(new Map<string, { paths: string; store: Store }>())
    useEffect(() => {
        const link = server.current
        const wanted = new Map<string, { peer: string; namespace: string; paths: string[][] }>()
        for (const channel of channels) {
            const description = known[channel.peer]
            const namespace = description?.namespaces.find((one) => one.name === channel.namespace)
            if (!namespace?.component) continue
            const paths = watchProjection(channel.nodes, namespace.component, description.types)
            if (paths.length) wanted.set(`${channel.peer}/${channel.namespace}`, { peer: channel.peer, namespace: channel.namespace, paths })
        }

        for (const [key, held] of [...open.current])
            if (!wanted.has(key) || wanted.get(key)!.paths.map((path) => path.join('.')).join(',') !== held.paths) {
                void held.store?.close()
                open.current.delete(key)
                setStores((all) => Object.fromEntries(Object.entries(all).filter(([one]) => one !== key)))
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
    }, [channels, known, server])

    // Every channel closed when the pane is left, for the same reason the component panel closes its
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
            nodes.map((node) => {
                const key = watchKey(node)
                const isOpen = observed.has(key)
                const description = known[node.peer]
                const channel = stores[`${node.peer}/${node.namespace}`]
                const namespace = description?.namespaces.find((one) => one.name === node.namespace)
                const refusal = !isOpen
                    ? undefined
                    : refusals[node.peer]
                      ? `${node.peer} could not be described: ${refusals[node.peer]}`
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
                    observed: isOpen,
                    component: namespace?.component,
                    types: description?.types,
                    source: channel && !('error' in channel) ? storeSource(channel, []) : NOTHING,
                    ...(refusal ? { refusal } : {})
                }
            }),
        [nodes, observed, known, refusals, stores, title]
    )
}
