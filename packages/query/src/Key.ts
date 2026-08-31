import { canonicalText, type RpcDataMethod, type RpcGetChildrenParams, type RpcGetListParams, type RpcGetManyParams, type RpcGetManyReferenceParams, type RpcGetOneParams } from '@source-repo/rpc'

/**
 * What identifies a question, so that two of them can be the same question.
 *
 * A cache is a key and some machinery, and the machinery is not ours - see the README. The key is,
 * because it is the one part that has to agree with the protocol: two callers asking a peer for
 * page two of the same resource with the same filter are asking one question, however their options
 * objects happened to be built, and a key that said otherwise would ask the plant twice for a page
 * it is already holding. On the link this library was written for that is not an inefficiency, it is
 * a screen that takes twice as long to draw.
 *
 * So the key is built on `canonicalText` from the library itself rather than on `hashKey` from the
 * cache. Not because `hashKey` is wrong - it sorts object keys and drops undefined, which is most of
 * this - but because the same encoder decides whether two *projections* are the same subscription,
 * and a cache that disagreed with the subscription about what "the same" means would be a second
 * definition of identity in a system that already has one.
 */

/** Names the library, so an application's own keys and these cannot collide in one cache. */
export const RPC_QUERY_KEY_ROOT = '@source-repo/rpc'

/** One question: which peer, which component, which resource, which verb, which options. */
export interface RpcQuestion {
    /** The peer, by the name it answers to. Never a socket - that is the whole addressing model. */
    readonly target: string
    /** The component's namespace on that peer. */
    readonly namespace: string
    readonly method: RpcDataMethod
    /** Where the collection lives: `['state','tags']`, or a single segment for a declared resource. */
    readonly resource: readonly string[]
    readonly params?: RpcGetListParams | RpcGetOneParams | RpcGetManyParams | RpcGetManyReferenceParams | RpcGetChildrenParams
}

/**
 * The key, coarsest first, so that a prefix is a scope somebody actually needs.
 *
 * `[root, target]` is everything from one peer, which is what a peer going away invalidates.
 * `[root, target, namespace]` is one component, which is what a revision moving invalidates.
 * `[root, target, namespace, resource]` is one collection, which is what a settled call narrows to.
 *
 * The resource stays an **array of its own segments** rather than being folded into the canonical
 * text beside the params, and that is load-bearing twice over: prefix matching needs it as a key
 * element, and the rule that decides whether a component's revision governs a resource at all has to
 * read the first segment - see `revisionGoverns`. The params are one canonical string because
 * nothing needs to look inside them.
 */
export type RpcQueryKey = readonly [root: string, target: string, namespace: string, resource: readonly string[], method: RpcDataMethod, params: string]

export const rpcQueryKey = (question: RpcQuestion): RpcQueryKey => [
    RPC_QUERY_KEY_ROOT,
    question.target,
    question.namespace,
    [...question.resource],
    question.method,
    // `?? {}` rather than leaving it absent, so a caller that passes nothing and one that passes an
    // empty object ask the same question. The encoder already makes `{ filter: undefined }` the
    // third spelling of it.
    canonicalText(question.params ?? {})
]

/** Everything cached from one peer. */
export const rpcPeerKey = (target: string): readonly unknown[] => [RPC_QUERY_KEY_ROOT, target]

/** Everything cached from one component of one peer. */
export const rpcComponentKey = (target: string, namespace: string): readonly unknown[] => [RPC_QUERY_KEY_ROOT, target, namespace]

/** Everything cached from one resource of one component. */
export const rpcResourceKey = (target: string, namespace: string, resource: readonly string[]): readonly unknown[] => [RPC_QUERY_KEY_ROOT, target, namespace, [...resource]]

/**
 * Whether the component's revision says anything about this resource.
 *
 * **Structural rather than a policy note, and that is the whole point.** A path into the component's
 * own `props` or `state` is *in* the snapshot, so the revision moving means it may have moved. A
 * declared resource is not: it is a table, a document collection, a queue, living behind the
 * component rather than inside it, and `RpcDataResource.path` already says so - "a single segment
 * for a resource of its own, never `props` or `state`".
 *
 * The reason this cannot be left as guidance is that the three shipped store-backed nodes bump their
 * revision **on reads** and on a metrics timer. Wire the invalidation rule to their declared
 * resources and every answer invalidates itself: the cache becomes a poll with no period, against
 * the peers least able to afford one. So a declared resource takes no freshness from the revision at
 * all, and gets `unknown` until something better exists to tell it otherwise.
 */
export const revisionGoverns = (resource: readonly string[]): boolean => resource[0] === 'props' || resource[0] === 'state'

/**
 * Whether two paths name overlapping ground - one inside the other, or the same.
 *
 * What a settled call needs. `sets: 'zones.top.setpoint'` reaches into `['state','zones']`, so a page
 * of that record is worth asking for again; it says nothing whatsoever about `['state','alarms']`.
 * Symmetric, because the claim can be finer than the resource or coarser than it and both are
 * ordinary: an action names the whole resource, and a `sets` names one field of one row in it.
 */
export const pathsOverlap = (a: readonly string[], b: readonly string[]): boolean => {
    const shared = Math.min(a.length, b.length)
    for (let at = 0; at < shared; at++) if (a[at] !== b[at]) return false
    return true
}
