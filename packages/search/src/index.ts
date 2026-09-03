import type { RpcFilter } from '@source-repo/rpc'

/**
 * One question, asked of everything a network serves.
 *
 * The console proved the shape of this against a single peer and the experiment's findings are what
 * this package is built around - so they are worth restating, because each one decides something
 * here rather than being a note about somewhere else.
 *
 * **A search asks for things by their name.** The one clause is `representation contains text`,
 * against the field a resource itself nominated as what a row is called. Not a sweep over every
 * field: an object-valued field does not match a string in any meaningful sense, and asking a SQL
 * node to scan every column of every table is a query nobody sized, issued by a search box, against
 * a database somebody else owns. What that buys is a bound anybody can reason about; what it costs
 * is that a row whose *contents* match is not found, which is a limit to state rather than hide.
 *
 * **A resource that only answers `getChildren` cannot be searched at all.** A tree browsed a branch
 * at a time has no way to be asked a question about all of it, so a document library is absent from
 * results entirely. That is the largest gap and the clearest specification for the verb this does
 * not yet invent: `leaves` on every aspect provider that wants to be found in, or a `search` of its
 * own. Until one exists, this asks what exists.
 *
 * **Nothing here ranks by relevance, because nothing here could.** A client cannot say whether a
 * customer or an OPC UA node better answers `er` - that is a judgement only a node can make about
 * its own rows, and no node makes it yet. What a client *can* see is how well the name it got back
 * matches the text that was typed, which is a different and smaller claim, made explicitly by
 * `MatchQuality` rather than dressed up as a score.
 */

/** Where a hit is. Everything needed to go there, and nothing about how a viewer would show it. */
export interface SearchLocator {
    readonly peer: string
    readonly namespace: string
    readonly resource: readonly string[]
    readonly id: string
}

/**
 * How well a name matched, which is **not** how relevant the thing is.
 *
 * The distinction matters enough to be in the type rather than in a comment. A node that ranked its
 * own rows would be saying "this is the better answer"; this says "this name begins with what you
 * typed", which is a fact about two strings. When nodes gain a real score, it arrives beside this
 * rather than replacing it, and the two can be told apart by anybody reading a result.
 */
export type MatchQuality = 'exact' | 'prefix' | 'contains'

export interface SearchHit {
    readonly at: SearchLocator
    /** What the resource says this row is called - the field the search was against. */
    readonly name: string
    readonly match: MatchQuality
}

/** One resource of one peer that can be asked. */
export interface SearchTarget {
    readonly peer: string
    readonly namespace: string
    readonly resource: readonly string[]
    /** The field a query is matched against, which is also what a hit is named by. */
    readonly representation: string
    /** What to call the resource on screen, where its path is not what a person would read. */
    readonly label?: string
}

/** What a target answered: the rows, as ids and their names. */
export interface SearchAnswer {
    readonly ids: readonly string[]
    readonly rows: readonly unknown[]
}

export interface SearchOptions {
    /**
     * How many rows to ask any one target for.
     *
     * Small on purpose and small by default. A search box issues this to every resource of every
     * peer on a settled keystroke, over a link that may be a plant network - so the question has to
     * be one a node can answer without thinking about it. Enough to see whether the thing is there;
     * the way to see the rest is to open the resource.
     */
    readonly perTarget?: number
    /** How many hits to return in all, after merging. The rest are counted, never silently dropped. */
    readonly limit?: number
    /**
     * How many targets to have questions out to at once.
     *
     * The number that keeps this from being a denial of service written as a feature: five peers
     * serving forty resources each is two hundred questions, and issuing them together would arrive
     * at every node in the network as a burst caused by somebody typing.
     */
    readonly concurrency?: number
}

const DEFAULTS = { perTarget: 5, limit: 50, concurrency: 8 } as const

/** The one clause a search asks of a target. Trimmed: a trailing space is not part of what was meant. */
export const searchFilter = (query: string, representation: string): RpcFilter | undefined => {
    const text = query.trim()
    return text ? { field: representation, op: 'contains', operand: text } : undefined
}

/**
 * How well one name matches what was typed, case-insensitively.
 *
 * Case-insensitive because a person typing `acme` means `Acme Ltd`, and because the filter that
 * found it may or may not have been - `contains` is defined by the library's own matcher and the
 * backends are held to it, but this is about presenting what came back rather than about finding it.
 */
export const matchQuality = (name: string, query: string): MatchQuality => {
    const haystack = name.toLowerCase()
    const needle = query.trim().toLowerCase()
    if (haystack === needle) return 'exact'
    if (haystack.startsWith(needle)) return 'prefix'
    return 'contains'
}

const ORDER: readonly MatchQuality[] = ['exact', 'prefix', 'contains']

/**
 * Merge what every target answered into one list.
 *
 * Ordered by how well the name matched, then by the name itself - and **not** by anything claiming
 * to be relevance. Within one quality the order is alphabetical rather than the order the answers
 * happened to arrive in, because arrival order is a fact about the network: the same query would
 * otherwise produce a different list each time it was asked, and a list that reshuffles under a
 * cursor is worse than one that is merely arbitrary.
 *
 * The total is the number found, not the number returned. A search that quietly truncated would let
 * a reader conclude a thing is not there when it is one row past the cap.
 */
export const merge = (found: readonly SearchHit[], limit: number = DEFAULTS.limit): { readonly hits: readonly SearchHit[]; readonly total: number } => {
    const sorted = [...found].sort((a, b) => ORDER.indexOf(a.match) - ORDER.indexOf(b.match) || a.name.localeCompare(b.name) || a.at.peer.localeCompare(b.at.peer))
    return { hits: sorted.slice(0, limit), total: sorted.length }
}

/**
 * Run `work` over `items`, never more than `width` at a time.
 *
 * Written here rather than taken from a dependency because it is nine lines and because the bound is
 * the point of the package: a federation that fans out without one is a way to make one person's
 * keystroke everybody else's outage.
 */
const throttled = async <T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> => {
    const answers: R[] = new Array(items.length)
    let next = 0
    const runner = async () => {
        for (;;) {
            const mine = next++
            if (mine >= items.length) return
            answers[mine] = await work(items[mine])
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, runner))
    return answers
}

/** What went wrong asking one target, kept beside the results rather than thrown over them. */
export interface SearchRefusal {
    readonly target: SearchTarget
    readonly reason: string
}

export interface SearchResult {
    readonly hits: readonly SearchHit[]
    /** How many matched in all, of which `hits` is the first page. */
    readonly total: number
    /** Targets that could not answer, named. A network where three nodes are down still answers. */
    readonly refused: readonly SearchRefusal[]
    /** How many targets were asked, so an empty result can be told from an empty network. */
    readonly asked: number
}

/**
 * Ask every target, and say what came back.
 *
 * `ask` is supplied by the caller for the reason `RpcDataCache` takes one: what a peer is called and
 * how it is reached belongs to whoever holds the link, and a package that built its own proxies
 * would be a second place addressing has to be right. It is handed a target and a filter and gives
 * back rows; everything about ordering, bounding and merging is here.
 *
 * **A target that fails is a refusal, not an exception.** One peer being unreachable is the ordinary
 * state of a network with more than three machines on it, and a search that threw would answer
 * nothing at all because one node was rebooting. They come back named, so a viewer can say which.
 */
export const searchAcross = async (
    targets: readonly SearchTarget[],
    query: string,
    ask: (target: SearchTarget, filter: RpcFilter, limit: number) => Promise<SearchAnswer>,
    options: SearchOptions = {}
): Promise<SearchResult> => {
    const perTarget = options.perTarget ?? DEFAULTS.perTarget
    const limit = options.limit ?? DEFAULTS.limit
    const text = query.trim()
    if (!text) return { hits: [], total: 0, refused: [], asked: 0 }

    const refused: SearchRefusal[] = []
    const found: SearchHit[] = []

    await throttled(targets, options.concurrency ?? DEFAULTS.concurrency, async (target) => {
        const filter = searchFilter(text, target.representation)
        if (!filter) return
        try {
            const answer = await ask(target, filter, perTarget)
            answer.ids.forEach((id, at) => {
                const row = answer.rows[at]
                const named = row && typeof row === 'object' ? (row as Record<string, unknown>)[target.representation] : undefined
                // A row whose name did not come back is still a hit - the target matched it - but it
                // can only be named by its id, which is what a viewer would have shown anyway.
                const name = typeof named === 'string' && named ? named : String(id)
                found.push({ at: { peer: target.peer, namespace: target.namespace, resource: target.resource, id: String(id) }, name, match: matchQuality(name, text) })
            })
        } catch (failure) {
            refused.push({ target, reason: (failure as { message?: string }).message ?? String(failure) })
        }
    })

    const merged = merge(found, limit)
    return { ...merged, refused, asked: targets.length }
}
