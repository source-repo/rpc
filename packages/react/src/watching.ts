import { leavesUnder, scopeTree, typeAt } from './scope.js'
import type { DescribedComponent, ServerDescription, TypeNode } from './types.js'

/**
 * A watch list: the nodes a reader chose to look at together, from wherever those nodes are.
 *
 * Everything else here shows one scope, of one component, of one peer, and every navigation replaces
 * the last. That is right for reading a node and wrong for watching a plant, where the four things
 * somebody is comparing sit on four machines - so "how is the line doing" is a question the console
 * cannot be asked at all, however good its answer about any one node is.
 *
 * ## The argument this file used to make, and why it was wrong
 *
 * It said that a set derived from the whole network - every scope of every peer, in one list - was
 * not worth offering, because a federation is thousands of values and a screen showing all of them
 * shows none. That is an argument about *size*, and size is not something the network root
 * introduces. One OPC UA address space on the rig this was built against is four hundred nodes and a
 * real one is far larger, and the console already deals with it: the scope tree is bounded by the
 * contract, collections are paged, trees are browsed a branch at a time. The network root is the
 * same problem one level up, and refusing it avoided a confrontation rather than settling one.
 *
 * What genuinely did not scale was never the number of nodes but **holding a channel per section**.
 * That is a defect wherever it happens - a hand-picked list of thirty has it too - so it is fixed
 * rather than dodged: a section costs nothing until it is opened, which makes a list of headings
 * free and leaves opening one costing exactly what opening that node has always cost. The console
 * offers both lists over the same rendering, and how big either one is stopped being the question.
 *
 * A chosen list is still the more useful of the two, for a reason that survives all of that: it is
 * small because somebody chose it, it crosses peers because a locator does, and it outlives
 * navigating away - which is the walk that made them want one.
 *
 * ## What is here and what is not
 *
 * The model, and nothing that fetches. A node is a *locator*: a claim about where something is, not
 * a way to reach it. So nothing in this file opens a link, and nothing in it draws: the arrangement
 * is a layout, and layout is the thing this package says it does not do. The console builds the pane
 * out of `ValueGrid`, one per open node, which is how a watch list comes to hold whatever a console
 * can show rather than only what this file could have anticipated.
 *
 * Persistence is the host's as well. Where a reader's list is kept is an application decision - a
 * browser console has `localStorage`, a CLI has a file, a hosted console has an account - and a
 * package that picked one of those would be picking wrong for the other two. What *is* here is
 * `asWatch`, because reading a stored list back is not persistence but validation: the text was
 * written by an older version of this software, and a node it can no longer make sense of has to be
 * dropped rather than take a pane down with it.
 *
 * ## One list, ordered, unnamed
 *
 * There is one and it has no name. A set of named lists is the obvious next shape and is
 * deliberately not built yet: naming and multiplicity arrive together, they arrive with a picker and
 * a create-and-delete of their own, and none of that is needed to find out whether reading four
 * machines on one screen is worth the code. `Watch` is an ordered list rather than a set so that
 * becoming one element of a longer list is an addition rather than a rewrite.
 */

/** Where a chosen node is. Enough to find it again after a reload, and nothing about drawing it. */
export interface WatchNode {
    readonly peer: string
    readonly namespace: string
    /** Spelled from the component root, exactly as a scope selection is: `['state', 'zones', 'top']`. */
    readonly path: readonly string[]
}

/**
 * The reader's set, in the reader's order.
 *
 * Ordered because they put it in an order, and it is theirs: a list that re-sorted itself
 * alphabetically, or by peer, would be answering a question nobody asked over one somebody did.
 */
export type Watch = readonly WatchNode[]

/**
 * The identity of a chosen node.
 *
 * `\u0000` separates the parts for the reason the rest of this repository uses it: it cannot occur in
 * a peer name, a namespace or a path segment, so no clever choice of one part can spell a key that
 * collides with another. Written as an escape and never as the byte - a literal NUL makes a source
 * file binary to everything that decides by sniffing content, and `grep` then matches it and prints
 * nothing at all. See CLAUDE.md, which has the scars.
 */
export const watchKey = (node: WatchNode): string => `${node.peer}\u0000${node.namespace}\u0000${node.path.join('.')}`

export const holds = (watch: Watch, node: WatchNode): boolean => watch.some((held) => watchKey(held) === watchKey(node))

/**
 * Add, idempotently, at the end.
 *
 * Adding what is already there is neither an error nor a duplicate. The button that does this sits
 * on a screen that may not be showing the list, so a reader pressing it twice is ordinary rather
 * than careless - and a set with the same tag in it twice is something they now have to repair.
 */
export const withNode = (watch: Watch, node: WatchNode): Watch =>
    holds(watch, node) ? watch : [...watch, { peer: node.peer, namespace: node.namespace, path: [...node.path] }]

export const withoutNode = (watch: Watch, key: string): Watch => watch.filter((held) => watchKey(held) !== key)

/** Move one node one place, staying inside the list. A move off either end is no move, not a wrap. */
export const movedNode = (watch: Watch, key: string, by: -1 | 1): Watch => {
    const at = watch.findIndex((held) => watchKey(held) === key)
    const to = at + by
    if (at < 0 || to < 0 || to >= watch.length) return watch
    const moved = [...watch]
    ;[moved[at], moved[to]] = [moved[to], moved[at]]
    return moved
}

/**
 * Read a view back from whatever it was stored as, keeping what is still intelligible.
 *
 * Anything at all may come back: a document from a version that spelled a node differently, a
 * hand-edited file, `null`. So each node is checked rather than the document, and one that does not
 * read as a locator is dropped while the rest survive. Refusing the whole thing over one bad entry
 * would lose a reader their entire view because of one node on a peer that has since been renamed,
 * which is the moment they would least like to lose it.
 */
export const asWatch = (held: unknown): Watch =>
    Array.isArray(held)
        ? held.filter(
              (node): node is WatchNode =>
                  !!node &&
                  typeof node === 'object' &&
                  typeof (node as WatchNode).peer === 'string' &&
                  typeof (node as WatchNode).namespace === 'string' &&
                  Array.isArray((node as WatchNode).path) &&
                  (node as WatchNode).path.every((segment) => typeof segment === 'string')
          )
        : []

/**
 * How a screen offers to put what it is showing onto the watch list.
 *
 * An affordance rather than a callback pair, for the reason `EditAffordance` is one: a control has
 * to know whether to offer the action *and* what it is already, and a component given only the verb
 * would have to guess the state or ask for it separately. `holds` is what makes the button able to
 * say `on watch` instead of pretending nothing has happened when it is pressed a second time.
 *
 * Optional wherever it appears. A console with no view - or a screen where adding would mean
 * nothing - passes none, and the control is simply absent rather than present and inert.
 */
export interface WatchAffordance {
    holds(node: WatchNode): boolean
    add(node: WatchNode): void
}

/** The chosen nodes of one component of one peer, which is one subscription's worth. */
export interface WatchChannel {
    readonly peer: string
    readonly namespace: string
    readonly nodes: readonly WatchNode[]
}

/**
 * Group the view by what would have to be observed, which is the bound this whole idea needs.
 *
 * Twelve tags from four machines is four channels rather than twelve: a component is observed once
 * and the paths of every node chosen from it travel in the one projection. Without this a view would
 * cost a subscription per entry, and the property that makes a view attractive - that a reader keeps
 * adding to it - would be the one that makes it expensive.
 *
 * First appearance decides the order of the groups, so a view somebody arranged does not come back
 * rearranged by peer name.
 */
export const channelsFor = (watch: Watch): readonly WatchChannel[] => {
    const groups = new Map<string, { peer: string; namespace: string; nodes: WatchNode[] }>()
    for (const node of watch) {
        const key = `${node.peer}\u0000${node.namespace}`
        const group = groups.get(key)
        if (group) group.nodes.push(node)
        else groups.set(key, { peer: node.peer, namespace: node.namespace, nodes: [node] })
    }
    return [...groups.values()]
}

/**
 * What one channel subscribes to: every typed leaf under every node chosen from it, and no more.
 *
 * **Narrowed to the chosen nodes, where the component panel deliberately asks for the whole
 * component.** The rule there is that the selection changes with every click, so narrowing per
 * selection would buy nothing and would make each click a re-subscribe. A view is the opposite case:
 * the set is fixed until the reader edits it, so narrowing costs nothing - and it matters more,
 * because a view borrowing one number from a machine carrying three hundred tags must not subscribe
 * to three hundred of them. Two answers from the same rule about what changes.
 *
 * Collections contribute nothing to a *projection*, which is not the same claim as a view cannot
 * hold one. A record's keys are data and its rows are fetched a page at a time, so no subscription
 * can name them - a view showing one asks for its pages exactly as any other pane does. The first
 * cut of this conflated the two and drew only what it could subscribe to, which on a network of
 * aspect providers and relational services meant a view that could hold nothing at all.
 */
export const watchProjection = (nodes: readonly WatchNode[], component: DescribedComponent, types?: { [name: string]: TypeNode }): string[][] => {
    const paths = new Map<string, string[]>()
    for (const node of nodes)
        for (const leaf of leavesUnder(typeAt(component, [...node.path], types), [...node.path], types))
            // Deduped across nodes: two chosen scopes may overlap - a reader can add a zone and then
            // the plant above it - and a projection naming the same path twice is a question asked
            // twice.
            if (!leaf.collection) paths.set(leaf.path.join('.'), leaf.path)
    return [...paths.values()]
}

/**
 * Every scope one peer serves, from its description.
 *
 * Roots only - the top of each component's scope tree, plus each declared resource - rather than
 * every node of every tree. A list of what is there is for finding out what is there; the way into
 * one of them is to open it, which is where the scope tree and its whole depth already are.
 *
 * A namespace that is a service rather than an observable component contributes nothing, rather than
 * an empty entry under its name: an empty section would claim it has something to show *and* that it
 * is empty, which are two different statements and only one of them is true.
 */
export const scopesIn = (peer: string, description: ServerDescription): Watch =>
    description.namespaces.flatMap((namespace) =>
        namespace.component ? scopeTree(namespace.component, description.types).map((node) => ({ peer, namespace: namespace.name, path: node.path })) : []
    )

/**
 * Every scope of every described peer - the whole network, flat.
 *
 * The console draws this grouped by peer, because a peer serving forty resources is forty headings
 * and the peer is the thing a reader is actually choosing between. The flat form stays because it is
 * the honest answer to *what does this network serve*, and because a caller that is not drawing a
 * tree - a CLI printing it, an MCP server answering about it - wants the list rather than the
 * arrangement.
 *
 * Only *described* peers appear, which is a property to know rather than to work around: a peer
 * nobody has asked has no scopes to report, and inventing an entry for it would be reporting a guess.
 * A console listing the network lists **peers** first for exactly that reason - it knows their names
 * without asking anything - and describes one when somebody opens it.
 */
export const everythingIn = (known: { readonly [peer: string]: ServerDescription }): Watch =>
    Object.entries(known).flatMap(([peer, description]) => scopesIn(peer, description))
