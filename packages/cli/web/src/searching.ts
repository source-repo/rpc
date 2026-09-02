import type { RpcFilter } from '@source-repo/rpc'
import type { DescribedResource, ServerDescription } from './types'

/**
 * Looking for something across everything one peer serves.
 *
 * `searching.ts` rather than `search.ts`, beside `Search.tsx`: on a case-insensitive filesystem
 * those two are one path and the resolver picks by extension order, so `./search` would resolve to
 * the wrong one and build perfectly here while failing on Windows. `paging.ts` beside `Pager.tsx`
 * carries the same scar, and `casing.test.ts` is what catches it - it caught this one.
 *
 * **A client before it is a contract, deliberately.** There is no `search` verb and this does not
 * invent one: it asks the resources a peer already declares, with the filter language that already
 * exists, and the point of building it this way is to find out what a real search would need before
 * any of it reaches the wire. Ranking, highlights, a cost bound, a verb for stores that can do
 * better than a filter - none of those can be designed honestly from an empty page.
 *
 * ## What it asks, and what it deliberately does not
 *
 * One clause: the resource's declared `representation` **contains** the text. Not a sweep across
 * every field of every row, which is the obvious idea and the wrong one twice over. An object-valued
 * field does not match a string in any meaningful sense, so half the sweep would be noise; and
 * asking a SQL node to scan every column of every table is a query nobody sized, issued by a search
 * box, against a database somebody else owns. The representation is the field the resource itself
 * nominated as what a row is called, which is what a person typing a name is looking for.
 *
 * The bound is therefore honest and narrow: **this finds things by their name.** A row whose name
 * does not contain the text is not found, and that is a limit to state rather than to paper over.
 */

/** One resource that can answer a search, with the field the search is against. */
export interface Searchable {
    readonly namespace: string
    readonly resource: DescribedResource
    /** The field a query is matched against: the resource's own answer to what names a row. */
    readonly representation: string
}

/**
 * Which resources of a peer can be searched at all.
 *
 * Two requirements, and each excludes something real. **`getList`**, because that is the verb that
 * takes a filter - a resource answering only `getChildren` is browsed a branch at a time and has no
 * way to be asked a question about all of it, which is why a document library is not searchable here
 * and is the first thing a real search contract would have to fix. And a **`representation`**,
 * because without one there is no field to match and no name to show for what was found.
 */
export const searchable = (description: ServerDescription | undefined): readonly Searchable[] =>
    (description?.namespaces ?? []).flatMap((namespace) =>
        (namespace.component?.resources ?? [])
            .filter((resource) => resource.verbs.includes('getList') && resource.presentation?.representation)
            .map((resource) => ({ namespace: namespace.name, resource, representation: resource.presentation!.representation! }))
    )

/** The one clause a search asks. Trimmed, because a trailing space is not part of what was meant. */
export const searchFilter = (query: string, representation: string): RpcFilter | undefined => {
    const text = query.trim()
    return text ? { field: representation, op: 'contains', operand: text } : undefined
}

/**
 * Where a hit is, as somewhere the console can go.
 *
 * The observer is already addressed by the query string, so resolving a hit is building that address
 * rather than inventing a second way to name a place. `scope` lands the reader on the resource the
 * hit came from instead of on whichever the component opens by default - which is most of the way
 * to the row, and the rest of the way is a URL this page does not yet read.
 */
export const hitAddress = (peer: string, namespace: string, resource: readonly string[]): string =>
    `?observe=${encodeURIComponent(peer)}&ns=${encodeURIComponent(namespace)}&scope=${encodeURIComponent(resource.join('.'))}`
