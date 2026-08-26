# @source-repo/query

The pull half of a [Source RPC](https://github.com/source-repo/rpc) network: a [TanStack Query](https://tanstack.com/query) cache over `$data`, whose freshness comes from the publisher rather than from a clock.

Its own package with its own version, deliberately *not* bound to the rpc/rpc-cli versions-together rule, built against the library's public API only — the same footing as `@source-repo/queue`, and for the same reason.

**Documentation: [source-repo.github.io/rpc](https://source-repo.github.io/rpc/)**

## The one paragraph to read first

A query cache reports `isStale`, and `staleTime: 5000` does not mean the data changed after five seconds — it means somebody decided to stop believing it then. On a plant, where a value is either the one the machine holds or it is not, a boolean computed from a clock is an opinion presented as a measurement. What a Source RPC network has instead is a publisher that says when it changed, so a page drawn at the revision the channel currently holds is not *probably still good* — it is **confirmed current**. This package is that fact, wired into a cache that already knows how to do everything else.

## What is theirs and what is ours

**Theirs.** Dedup, storage, eviction, backoff timers, stale-while-revalidate, persistence adapters, devtools. None of it interesting, all of it fiddly, and rebuilding it would be rebuilding it twice. `@tanstack/query-core` is framework-agnostic and dependency-free — it is what the React, Vue and Svelte bindings all sit on — so **this works between services and not only in browsers**.

**Ours, and unobtainable from any cache library.** That a page drawn at the revision the channel holds is confirmed current. That `semantics` decides whether a retry is safe at all. That a deadline is a budget the caller declared rather than a per-attempt timeout. And the key that makes two questions the same question.

## Three states, never two

| | what it means | where it comes from |
| --- | --- | --- |
| `current` | the publisher has said nothing since this was drawn | the component's revision, compared |
| `possibly-changed` | it has said *something* since; whether it touched this is a further question | the same comparison |
| `unknown` | nothing is watching, or what is watching cannot speak for this | no channel open, or a declared resource |

`unknown` is first-class, and collapsing it into `possibly-changed` would look like caution while being the same fake one level down: a screen saying *this may have changed* when what is true is *nobody here knows*. A `current` that is sometimes a guess is worth nothing.

## Using it

```typescript
import { RpcDataCache } from '@source-repo/query'

const cache = new RpcDataCache({
    // How a question is asked. This package opens nothing and knows nothing about proxies.
    ask: async ({ target, namespace, method, resource, params }, { deadlineMs }) => {
        const proxy = await client.proxy(namespace, target)
        return proxy.$with({ ttl: deadlineMs ?? 0 }).$data(method, resource, params)
    },
    // So that "offline" means this link rather than `navigator.onLine`.
    lifecycle: client
})

// The freshness signal, taken from a channel somebody else opened. The cache never opens one.
const oven = await client.component('oven', 'oven3', { paths: [['state', 'mode']] })
cache.observe('oven3', 'oven', oven[rpcComponent])

const watch = cache.watch(
    { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['state', 'tags'], params: { pagination: { page: 0, pageSize: 50 } } },
    { periodMs: 5000 }
)
watch.subscribe(() => draw(watch.getSnapshot()))
```

`getSnapshot()` answers `{ data, error, fetching, since, freshness }` — the same shape a polled pane already drew, with the fact it could not have.

In React, `watch` is a `useSyncExternalStore` source as it stands: `useSyncExternalStore(watch.subscribe, watch.getSnapshot)`. In Node, subscribe to it directly.

## What the period does now

`periodMs` is a period for *considering*, not for asking. **A tick over a `current` entry costs nothing at all**, because the publisher has said nothing since the page was drawn and there is nothing on the far side to fetch. A five second period against a quiet plant becomes free; the same five seconds against a moving one behaves exactly as it did.

What is deliberately not turned on is `refetchInterval`. The period belongs to whoever is watching — that is the whole reason `$data` is a call rather than a subscription, because a subscription's rate belongs to the publisher, and on a 1200 baud link that means the peer decides how much of the operator's bandwidth it spends.

## The two defaults that are wrong here

**Queries are retried three times by default.** That is right only because a `query` is a query — and `semantics` is optional in this library on purpose, so absent means *does not say*, never *is a read*. `rpcQueryOptions` derives `retry` from the declared semantics and retries nothing when nothing is declared. The alternative is that the first author who forgets the annotation gets automatic retries on `dispense()`, and finds out how many by counting what came out of the machine.

**A retry will happily re-issue a call whose deadline has passed.** A deadline here is a budget the caller declared, so every attempt is given what *remains* of it rather than a fresh copy, and an attempt that arrives with none left is refused rather than sent.

## Two caveats for a plant box rather than a tab

`gcTime` bounds by **time and not by count or bytes**, so a process that runs for months over a wide key space — one entry per resource per filter per page — needs a bound of its own. And an observer that is never closed keeps its entry for ever, so watches minted per request leak; close them.

## Declared resources are excluded, structurally

A path into `props` or `state` is *in* the snapshot, so the revision moving means it may have moved. A declared resource — a table, a document collection, a queue — is not, and Source Relational, Source Document and Source Queue all bump their revision **on reads** and on a metrics timer. Wiring the invalidation rule to those would make every answer invalidate itself: a poll with no period, against the peers least able to afford one. So a declared resource takes no freshness from the revision at all, and reads `unknown`.

A **restart** is the exception, and it is the right way round: a new epoch drops the declared resources too, because a component that came back may have reconnected to a different database.

## License

MIT
