import { sameAspectRef, type AspectRef } from './Model.js'

/**
 * Following a link without losing where you were.
 *
 * A link stores **intent**, never a path. That is the whole of the design here, and the reason is
 * that a path is a fact about a tree at a moment: aspects get rebuilt, documents get refiled,
 * and a saved path then points somewhere plausible and wrong. A stored intent - *the same
 * aspect I am in, near where I am* - is re-resolved against the structure as it is now, and
 * says so when it cannot be honoured.
 *
 * The thing worth preserving is context. A reader browsing a security aspect who follows a link
 * to a document should land on that document **in the security aspect**, because the aspect
 * is why they are reading. Dropping them into the folder tree is not a smaller answer, it is a
 * different subject. So inheritance is the default and every departure from it is reported.
 */

/** Where a link points, and what it asks for on arrival. */
export interface AspectLink {
    readonly id: string
    readonly target: AspectRef
    readonly label?: string
    readonly relation?: string
    readonly navigation?: NavigationIntent
}

export interface NavigationIntent {
    /** Default: stay in the aspect the reader is already in. */
    readonly aspect?: 'inherit' | { readonly id: string }
    /** A block or field inside the target. Applied after the target itself resolves. */
    readonly focus?: string
    /** What to do when the wanted aspect cannot place the target. */
    readonly fallback?: 'target-default' | 'canonical' | 'refuse'
    /** An occurrence whose neighbourhood to prefer, when the target appears more than once. */
    readonly near?: string
}

/** Where a reader is, or ends up. */
export interface AspectLocation {
    readonly target: AspectRef
    readonly aspectId?: string
    readonly occurrenceId?: string
    readonly focus?: string
    /** Whether the aspect was carried over rather than asked for. */
    readonly inherited: boolean
    /** Set when the wanted aspect could not place the target, so a viewer can say so. */
    readonly fallbackUsed?: 'target-default' | 'canonical'
}

/** A link that could not be followed, as a value rather than an exception. */
export interface LinkRefusal {
    readonly refused: string
}

export const isRefusal = (result: AspectLocation | LinkRefusal): result is LinkRefusal => 'refused' in result

/**
 * What the resolver needs to know about the provider's structures.
 *
 * Deliberately two small questions rather than an interface over the whole provider: this file has
 * no business knowing how objects are stored, and a resolver that could only be tested by standing
 * up a provider would not get tested against the awkward cases.
 */
export interface AspectPlacements {
    /** Where this object appears in that aspect, in the provider's own order. Empty if nowhere. */
    placements(target: AspectRef, aspectId: string): readonly string[] | Promise<readonly string[]>
    /** The aspect a provider would choose for this object when nothing else decides. */
    defaultAspectFor(target: AspectRef): string | undefined | Promise<string | undefined>
    /**
     * The ancestor chain of an occurrence, root first, including the occurrence itself.
     *
     * Used only to choose between placements. A provider that cannot answer cheaply may return the
     * occurrence alone, and the resolver degrades to the provider's own order rather than failing.
     */
    ancestorsOf?(occurrenceId: string, aspectId: string): readonly string[] | Promise<readonly string[]>
}

/** How much of two ancestor chains agree, from the root down. */
const sharedDepth = (a: readonly string[], b: readonly string[]): number => {
    let shared = 0
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1
    return shared
}

/**
 * Choose which appearance of the target to land on.
 *
 * `near` wins outright when it is one of them: the caller has named the neighbourhood, and second
 * -guessing a caller who was explicit is how a resolver becomes unpredictable. Otherwise the one
 * sharing the longest visible ancestor chain with where the reader is, which is "nearest" in the
 * only sense a tree has - and, failing any information at all, the provider's first, because an
 * arbitrary choice made consistently is easier to live with than one that moves.
 */
const chooseOccurrence = async (placements: readonly string[], aspectId: string, from: AspectLocation | undefined, near: string | undefined, structure: AspectPlacements): Promise<string> => {
    if (near && placements.includes(near)) return near
    const anchor = from?.aspectId === aspectId ? from.occurrenceId : undefined
    if (!anchor || !structure.ancestorsOf) return placements[0]
    const here = await structure.ancestorsOf(anchor, aspectId)
    let best = placements[0]
    let bestDepth = -1
    for (const placement of placements) {
        const depth = sharedDepth(here, await structure.ancestorsOf(placement, aspectId))
        if (depth > bestDepth) {
            best = placement
            bestDepth = depth
        }
    }
    return best
}

/**
 * Follow a link from where the reader is, and say what happened.
 *
 * The order matters and is the specification's:
 *
 * 1. An explicitly named aspect is tried first - it is the one thing the link's author decided.
 * 2. Otherwise the reader's own aspect is inherited, which is the case that keeps context.
 * 3. Among several placements, the nearest is chosen.
 * 4. When the wanted aspect cannot place the target at all, the fallback decides, and the
 *    result **says** a fallback was used. A viewer that silently changed aspect would leave a
 *    reader looking at a tree they did not choose and have no way to notice.
 *
 * `focus` is carried through untouched. It names something inside the target, and this file has no
 * opinion about what: whether a block id exists is the provider's question, and whether a renderer
 * can honour it is the viewer's.
 */
export const resolveLink = async (link: AspectLink, from: AspectLocation | undefined, structure: AspectPlacements): Promise<AspectLocation | LinkRefusal> => {
    const asked = link.navigation?.aspect
    const wanted = asked && asked !== 'inherit' ? asked.id : from?.aspectId
    const inherited = !asked || asked === 'inherit'
    const focus = link.navigation?.focus

    if (wanted) {
        const placements = await structure.placements(link.target, wanted)
        if (placements.length)
            return {
                target: link.target,
                aspectId: wanted,
                occurrenceId: await chooseOccurrence(placements, wanted, from, link.navigation?.near, structure),
                ...(focus ? { focus } : {}),
                inherited
            }
    }

    // The wanted aspect has nowhere to put it. Which is not a failure - a document may simply
    // not be filed under the topic the reader is browsing - but it is a change of subject, and the
    // caller decides whether that is acceptable before it happens rather than discovering it after.
    const fallback = link.navigation?.fallback ?? 'target-default'
    if (fallback === 'refuse') return { refused: `${link.target.id} does not appear in ${wanted ?? 'any aspect asked for'}` }

    if (fallback === 'canonical') return { target: link.target, ...(focus ? { focus } : {}), inherited: false, fallbackUsed: 'canonical' }

    const preferred = await structure.defaultAspectFor(link.target)
    const fallbackPlacements = preferred ? await structure.placements(link.target, preferred) : []
    // The default aspect could not place it either, so there is no structure to answer with. Naming
    // one anyway - an aspect with no occurrence in it - reads to a viewer as *show this in that
    // tree*, and there is nothing in that tree to show: it would draw an empty structure, or
    // highlight nothing in a full one, and either way say the object is somewhere it is not.
    if (!preferred || !fallbackPlacements.length) return { target: link.target, ...(focus ? { focus } : {}), inherited: false, fallbackUsed: 'canonical' }
    return {
        target: link.target,
        aspectId: preferred,
        occurrenceId: await chooseOccurrence(fallbackPlacements, preferred, undefined, link.navigation?.near, structure),
        ...(focus ? { focus } : {}),
        inherited: false,
        fallbackUsed: 'target-default'
    }
}

/** Whether two locations are the same place, which is what a viewer compares to avoid a redraw. */
export const sameLocation = (a: AspectLocation | undefined, b: AspectLocation | undefined): boolean =>
    !!a && !!b && sameAspectRef(a.target, b.target) && a.aspectId === b.aspectId && a.occurrenceId === b.occurrenceId && a.focus === b.focus
