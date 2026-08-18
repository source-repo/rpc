# Overall assessment

This is a **very strong comparison**. It is specific, technically grounded, and much more useful than a generic feature matrix. Its best insight is the distinction between a demand-driven query cache and a producer-maintained component view:

> “TanStack Query is a cache in front of a pull, and the component channel is a cache behind a push.”

That is an excellent framing and should remain near the beginning. The document also correctly discovers that the real gap is not ordinary component snapshots, but the **pull-shaped half of Source RPC**: `$data` and query-semantic methods currently lack a shared cache, request deduplication, retention, refresh policy, and visibility lifecycle. 

Before making this a canonical framework design note, I would make four substantial corrections:

1. Temper several claims about what TanStack Query “cannot” do.
2. Separate connection coherence from semantic data freshness.
3. Treat **queueability** as independent from idempotency and method semantics.
4. Narrow the claim that revision-based invalidation is “exact.”

The document’s implementation recommendations remain largely valid after those corrections.

---

# 1. The central model is right, but slightly too absolute

TanStack Query is normally used as a cache around demand-driven reads, so the pull-versus-push distinction is useful. But TanStack Query is not inherently unable to consume server push. Applications can feed WebSocket or event updates into its cache with `setQueryData`, or invalidate affected queries when events arrive. It also already models stale cached data, update timestamps, paused fetching, selectors, structural sharing, and retained inactive data. ([TanStack][1])

The stronger and more defensible Source RPC claim is:

> TanStack Query can be connected to a push source, but it does not natively understand peer incarnations, subscription continuity, component revisions, server-side projections, or Source RPC method effects.

That is the real difference. Source RPC’s advantage is not that push is impossible elsewhere; it is that push coherence is part of the protocol rather than application wiring.

I would revise the opening to something like:

> **TanStack Query is normally a cache around demand-driven reads. A Source RPC component channel is a replicated live view maintained by producer snapshots.** TanStack Query can be updated from server events, but Source RPC carries producer identity, epoch, revision, projection, and stream status as native protocol concepts.

That preserves the memorable distinction without making a claim an experienced TanStack user can easily rebut.

---

# 2. Distinguish three different meanings of “fresh”

The document says that `epoch`, `revision`, and `stale` answer the freshness problem better than a timer can.  That is mostly right, but only for two forms of freshness.

Source RPC currently has at least three separate concerns:

| Concern                            | Source RPC mechanism                         | What it tells us                                                                      |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Coherence**                      | `epoch` and `revision`                       | Whether a snapshot is duplicated, reordered, or from a replaced component incarnation |
| **Reachability/stream continuity** | `live`, `stale`, `staleSince`, peer presence | Whether the channel is still known to be connected to its source                      |
| **Domain freshness**               | Not fully represented generically            | Whether this particular value is still valid for its purpose                          |

The third one matters. A configured setpoint may remain valid for months. A vibration reading may become operationally useless after two seconds. A peer can remain online while a driver, sensor, or publishing task has stalled.

Therefore:

> `status: "live"` should mean “the component channel is presently established and coherent,” not “every value is sufficiently recent for every application.”

Where needed, domain freshness should come from one of:

* value quality metadata;
* an observation timestamp supplied by the component;
* a contract-declared maximum age;
* a heartbeat or health field;
* an application-specific rule.

This does not weaken the component channel. It prevents `live` from being overloaded with a guarantee it cannot generally provide.

---

# 3. The peer-restart finding is correct and should be P0

The document’s strongest concrete finding is that resubscription handles a reconnecting **link**, but not a returning **peer**. 

That remains true in current `main`:

* `resubscribe()` is invoked from the transport’s `connected` event;
* `peerGone` and `peerDisplaced` mark matching component channels stale;
* `peerOnline` is forwarded to the application but does not restore those subscriptions;
* a failed resubscription is reported once but has no retry lifecycle. 

I agree that this is closer to a correctness defect than a feature omission.

The fix should be slightly more disciplined than simply resubscribing on every `peerOnline` event. I would implement a per-target recovery state:

```text
peerGone / peerDisplaced
    → mark channels stale
    → mark target as needing recovery

peerOnline transition
    → resubscribe target once
    → await fresh snapshot
    → mark recovered

transient failure
    → retry with bounded exponential backoff and jitter

permanent failure
    → remain stale and expose the failure
```

Important details:

* Serialize link-reconnect and peer-return recovery so they do not issue duplicate resubscriptions.
* Retry transient transport, timeout, or peer-starting failures.
* Do not retry permanent authorization, missing-contract, or missing-event failures indefinitely.
* Cancel recovery when the final local observer closes.
* Prefer an online **transition** or peer-generation change over every repeated presence announcement.

This should be addressed before adding more caching sophistication, because every retained or persisted view depends on reliable recovery.

---

# 4. Queueability is not implied by idempotency

This is the most important conceptual correction.

The document proposes that queries, idempotent commands, and non-repeatable commands with an idempotency key may safely be paused and sent when connectivity returns. 

Idempotency answers:

> What happens if this operation is executed more than once?

It does **not** answer:

> Is it appropriate to execute this operation four minutes later?

For example, `openValve()` may be idempotent in the sense that repeating it leaves the valve open. It can still be dangerous to execute after the operator’s original context has disappeared.

The contract therefore needs two independent axes:

```typescript
type RpcMethodSemantics =
  | "query"
  | "idempotent-command"
  | "non-repeatable-command";

type RpcAvailabilityPolicy =
  | "fail-when-unreachable"
  | "wait-until-deadline";
```

Possibly later:

```typescript
type RpcAvailabilityPolicy =
  | { kind: "immediate-only" }
  | { kind: "wait-until-deadline"; maximumDelayMs?: number }
  | { kind: "durable-queue"; queue: string };
```

The safe rules would then be:

* A query may usually wait and be reissued within its deadline.
* A command defaults to `immediate-only`.
* A command may wait only when its contract explicitly permits delayed dispatch.
* Repeatability or an idempotency key is additionally required where duplicates are possible.
* A non-repeatable command must also have a target capable of durably enforcing the supplied idempotency key.
* Authorization, owner fencing, contract version, and deadline must be rechecked at dispatch.
* The queued operation must be visible to the user.
* A deadline is absolute across time spent waiting; it must not restart when the call is eventually sent.

There should also be a sharp distinction between:

```text
not yet sent
```

and:

```text
possibly sent, but no outcome received
```

Only the first can safely become “paused.” The second is potentially `UnknownOutcome`.

TanStack’s `networkMode` and paused mutation machinery are valuable inspiration, but TanStack itself cannot determine operational queueability from the method contract. ([TanStack][2]) Source RPC can do better, provided it does not equate idempotency with delayed intent.

---

# 5. The command store is an excellent proposal

The proposed `client.commands` store is one of the best additions in the document. 

Source RPC currently has rich per-call outcomes, but they disappear into the promise owner. An observable registry would turn protocol semantics into usable application behavior.

I would call the underlying facility an **operation registry**, with a command-specific filtered view:

```typescript
interface RpcOperation {
  id: string;
  target?: string;
  namespace: string;
  method: string;
  semantics: RpcMethodSemantics;

  status:
    | "waiting"
    | "sending"
    | "acknowledged"
    | "running"
    | "succeeded"
    | "rejected"
    | "expired"
    | "unknown-outcome";

  createdAt: number;
  sentAt?: number;
  settledAt?: number;
  deadline?: number;

  idempotencyKey?: string;
  error?: RpcError;
}
```

The core should expose observable operation state. A React application can then build:

* a pending-command tray;
* per-component command indicators;
* a global unknown-outcome warning;
* retry actions that preserve the original idempotency key;
* audit correlation.

Arguments and results should not be retained by default. They may contain plant data or credentials. The registry should also be bounded by count and retention time.

The mutation-scope comparison is useful, but the Source RPC equivalent should not automatically queue a second click. A local single-flight policy should be explicit:

```text
join existing operation
reject duplicate
replace unsent operation
enqueue
```

For a non-repeatable command, `reject duplicate` or `join existing` is generally safer than silently scheduling a second execution.

---

# 6. Push-informed pull invalidation is the best novel idea, but not fully “exact”

The document is right that Source RPC has unusually good information for coordinating pushed component snapshots with pulled `$data` pages. Both carry epoch and revision information, and method declarations can describe affected state.  Current `$data` results do indeed carry `epoch` and `revision`. 

However, a higher component revision tells the cache:

> Something in this component changed after this page was produced.

It does not necessarily tell it:

> This particular resource, filter, sort, and page changed.

So this is **deterministic conservative invalidation at component scope**, rather than exact page-level invalidation.

I would change:

> “can be invalidated exactly”

to:

> “can be invalidated deterministically, and often narrowed using declared effects.”

There are also four cases to separate.

### Component-state-backed `$data`

For a resource such as `state.tags`, a higher component revision means the cached page may have changed. `sets: "tags.*"` can narrow invalidation after a successful method call.

### External data resources

A database-backed `$data` resource may change without a component snapshot changing. It needs its own resource version or invalidation event.

For example:

```typescript
type RpcDataVersion = {
  epoch: string;
  revision: number;
  resourceRevision?: number;
};
```

or:

```typescript
$dataChanged({
  resource: ["alarms"],
  revision: 42,
  affectedIds: ["A-17"],
});
```

### Arbitrary query-semantic methods

A general query method does not automatically return an epoch and revision. It therefore cannot receive the same invalidation guarantees unless the protocol adds response metadata or the contract declares dependencies.

### Method effects

`sets` describes state paths, but a method may also affect an external table, queue, deployment, file, or derived resource. An eventual generalized declaration may be clearer:

```typescript
affects: [
  { kind: "state", path: "tags.*" },
  { kind: "data", resource: ["alarmHistory"] },
];
```

There is also an important race to define:

```text
snapshot revision 12 arrives
query response produced from revision 11 arrives afterward
```

The query cache must recognize the result as already stale. It should not publish revision 11 as fresh merely because it arrived last.

TanStack Query can be manually updated or invalidated from server events; what Source RPC uniquely offers is the ability to derive that behavior from protocol and contract metadata rather than handwritten query-key conventions. ([TanStack][3])

---

# 7. A pull cache is needed, but it need not be built from scratch

The evidence from `polled.ts` is convincing. It independently implements several query-cache behaviors:

* retain the last successful answer;
* schedule the next request after settlement;
* stop while hidden;
* support immediate refresh;
* avoid overlapping polling cycles. 

The current console implementation confirms those behaviors explicitly. 

The document correctly identifies a framework gap. But it should distinguish:

> Source RPC needs to provide this capability.

from:

> Source RPC must implement its own query-cache engine.

TanStack Query is independent of tRPC. A Source RPC application can use TanStack Query for `$data` and query methods while retaining native Source RPC stores for live components.

A particularly strong architecture would be:

```text
Source RPC component channel
    native store
    epoch/revision/status
    projection
    structural sharing
    selectors

Source RPC query adapter
    TanStack Query for $data and query methods
    Source RPC-generated keys
    peer-aware online state
    revision-aware invalidation
    Source RPC call deadlines and errors

Source RPC operation registry
    command semantics
    UnknownOutcome
    idempotency
    command tray
```

An official package could expose:

```typescript
rpcQueryOptions({
  client,
  target,
  namespace,
  method,
  args,
});

rpcDataQueryOptions({
  client,
  target,
  namespace,
  resource,
  params,
});
```

This would immediately provide mature request deduplication, cache retention, stale windows, retries, persistence adapters, selectors, and devtools while Source RPC contributes the information TanStack does not possess.

A bespoke transport-neutral cache may still be justified later for:

* the CLI outside React;
* Node peers;
* consistency with C#;
* protocol-native caching that must not depend on a web library.

But an official TanStack adapter is the lowest-risk first implementation. The document should present “build or integrate” as an architectural decision rather than assuming promotion of `polled.ts` into core.

Whichever implementation is chosen, the cache key needs more than method and arguments. It should account for:

```text
target peer
namespace
method or resource
normalized arguments
projection
contract version
tenant or authorization scope
```

It also needs defined behavior when two consumers request the same data with different deadlines or cancellation policies.

---

# 8. Structural sharing is worthwhile, but not quite a 30-line change

The diagnosis is correct. Current component acceptance replaces the entire nested snapshot graph, so object-valued selectors receive new references even when their contents did not change.  The current implementation installs the incoming snapshot directly as the new view. 

Structural sharing is likely high value, particularly for large component states at frequent update rates.

However, the implementation needs explicit rules for:

* arrays;
* typed arrays and binary values;
* plain objects versus class instances;
* `Date`, `Map`, or other codec-supported values;
* `undefined` and `null`;
* prototype-sensitive keys;
* large snapshots where deep comparison itself becomes expensive.

I would initially support structural sharing only for the framework’s documented plain-data wire model and make it configurable.

The “changed path set as a byproduct” is useful for:

* UI highlighting;
* development diagnostics;
* local chart sampling;
* render optimization.

It should not be presented as a general alarm evaluator or authoritative change-of-value historian. A browser-side cache can disconnect, be hidden, restart, or receive a projection. Safety-relevant alarms and durable plant history must remain authoritative at the site or backend.

---

# 9. Selectors belong in the React integration, with status preserved

The selector argument is strong:

> A projection narrows the wire and a selector narrows the render. 

Source RPC should support both.

I would be cautious about making every `RpcComponentStore` manufacture arbitrary derived stores. That can introduce derived-store caching and lifecycle problems. A React integration can provide selector-aware subscription behavior while the core store remains minimal.

For example:

```typescript
const pressure = useRpcComponentSelector(
  pump,
  (view) => ({
    value: view.state.pressure,
    status: view.status,
    staleSince: view.staleSince,
  }),
);
```

The status fields matter. Selecting only `view.state.pressure` must not accidentally prevent a rerender when the channel changes from `live` to `stale` while the pressure number remains unchanged.

A path-based convenience API could still be provided, but it should make freshness visible:

```typescript
useRpcValue(pump, ["state", "pressure"]);
```

returning something like:

```typescript
{
  value: number | undefined;
  status: "initializing" | "live" | "stale" | "closed";
  receivedAt: number;
  staleSince?: number;
}
```

---

# 10. “Keep the cache, drop the subscription” is exactly right

This is one of the best design principles in the document. 

It fits Source RPC better than simply copying TanStack’s inactive-query behavior:

```text
final observer leaves
    → remove remote subscription
    → retain last accepted snapshot
    → mark it stale
    → start cache-retention timer

observer returns
    → return stale snapshot immediately
    → re-establish subscription
    → replace with fresh snapshot
```

The current `component()` contract waits for the first live snapshot. Retained stale data therefore creates an API question:

* Should `component()` begin returning immediately with stale cached data?
* Should it retain the existing wait-for-live behavior?
* Should there be separate `component()` and `cachedComponent()` APIs?
* Should the returned component expose a `whenLive()` promise?

That should be decided explicitly rather than changed incidentally.

The retained cache also needs:

* `gcTime`;
* count and byte limits;
* clearing on logout or tenant switch;
* clearing after authorization revocation;
* schema or contract-version compatibility checks;
* observability of retained-but-unsubscribed entries.

---

# 11. Hidden-tab suspension needs finer control than document visibility

The proposed optional unsubscribe-on-hide behavior is sensible, especially for slow links. 

There are actually three different visibility levels:

```text
observer unmounted
pane hidden inside the application
whole document hidden
```

A tab can be visible while a pane is closed. Conversely, a wallboard may be in a browser state that looks inactive to generic heuristics but must remain subscribed.

I would make activity an observer or screen policy:

```typescript
component(name, target, {
  activity: "always" | "while-visible" | "manual",
});
```

The React adapter can combine explicit pane state with document visibility.

Critical alarms and intentional wall displays should default to `always`. Ordinary inspector panes may use `while-visible`.

---

# 12. Persistence is valuable but security-sensitive

Restoring cached snapshots as **stale, never live** is exactly the correct rule.  TanStack’s persistence tooling similarly restores cache state with configurable age and garbage-collection behavior. ([TanStack][4])

The Source RPC implementation should additionally bind persisted state to:

```text
user identity
tenant
site
peer
namespace
projection
contract or schema version
```

It should:

* clear on logout;
* clear when switching customer or tenant;
* avoid persisting credentials, authority, owner leases, or command queues;
* avoid using ordinary unprotected local storage for sensitive plant data;
* impose a deployment-defined maximum age;
* hydrate only after the user identity is established;
* preserve the original `receivedAt`;
* restore `status: "stale"` unconditionally.

One correction: epoch reconciliation is not entirely “free.” A restored snapshot can be labelled stale immediately, but the application normally learns the current component epoch only when a fresh component snapshot arrives. Presence alone may not identify the component’s current epoch.

A new epoch should invalidate revision comparability. It does not necessarily require blanking the screen before replacement. The last-known snapshot can remain visible as stale if product policy allows it.

---

# 13. The “do not copy” section needs narrower wording

## Do not poll a healthy subscription by default

The argument against polling on top of an active subscription is correct. 

But there may still be legitimate uses for:

* a heartbeat;
* a liveness deadline;
* a periodic integrity snapshot;
* recovery after an event gap;
* verification on a transport without sufficiently strong delivery guarantees.

The rule should be:

> Do not use periodic refetching as the normal freshness mechanism for an established component subscription. Use targeted reconciliation only when liveness or delivery guarantees require it.

## Do not optimistically overwrite observed plant state

The critique of optimistic cache writes is excellent for reported physical state. 

The command tray is the correct adaptation:

```text
reported value: 175
commanded value: 180
command state: awaiting acknowledgement
```

However, optimistic behavior should not be prohibited across all Source Assess and Source Edge UI data. It remains reasonable for:

* draft names;
* local layouts;
* comments;
* unsaved form state;
* purely SaaS metadata with easy rollback.

TanStack itself supports displaying pending mutation variables separately without overwriting the authoritative query cache, which is very close to the proposed command-tray model. ([TanStack][5])

The narrower rule is:

> Never present an optimistic value as though it were observed or accepted plant state.

## Do not make cursor pagination the only model

The offset-plus-total argument is good for an operator-facing pager. But neither offset nor cursor pagination is universally correct under live mutation.

I would support provider capabilities:

```text
offset + total
offset + hasMore
cursor + hasNextPage
```

Offset plus total is natural for “page 3 of 47.” Cursor pagination is natural for:

* append-only event logs;
* histories;
* very large stores;
* stable ordered records where counts are expensive.

The current `$data` design already supports an optional `total` and `hasMore`, which is a good foundation. 

---

# 14. Important comparison areas are deliberately absent—but should be named

The document says it is a precise research comparison, but it primarily compares client-side state behavior around components, `$data`, and calls. It does not cover several major TanStack Query concerns:

* SSR and hydration;
* router-driven prefetching;
* dependent and disabled queries;
* cancellation through `AbortSignal`;
* request waterfalls;
* error boundaries;
* retry policy;
* Suspense integration;
* query defaults and metadata;
* server rendering and React Server Components.

TanStack has mature support for server rendering, prefetching, and hydration. ([TanStack][6])

Source Assess may care about those more than a local Source Edge console does.

I would not expand this document to analyse every feature. Instead add a short scope statement:

> This note compares TanStack Query with Source RPC’s browser-side live and pulled state mechanisms. It does not compare React routing, SSR, server-component integration, or tRPC’s application-router ergonomics.

That prevents the document being read as a complete decision between tRPC and Source RPC.

It should also explicitly state:

> TanStack Query is independent of tRPC. Choosing Source RPC as the browser protocol does not imply rejecting TanStack Query as the cache for pull-shaped operations.

That point substantially strengthens the Source RPC option.

---

# 15. Recommended framework shape

The comparison suggests three different state mechanisms rather than one universal cache:

```text
┌──────────────────────────────────────────────┐
│ Source RPC component store                   │
│                                              │
│ Native push snapshots                        │
│ Epoch / revision / status                    │
│ Server-side projection                       │
│ Structural sharing                           │
│ Selector-aware React hooks                   │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Source RPC query layer                       │
│                                              │
│ $data and query-semantic methods             │
│ In-flight deduplication                       │
│ Freshness windows                            │
│ Retention and persistence                    │
│ Version-aware invalidation                   │
│ Initially possibly backed by TanStack Query  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Source RPC operation store                   │
│                                              │
│ Commands in flight                           │
│ Paused only when explicitly queueable        │
│ Idempotency keys                             │
│ UnknownOutcome                               │
│ Owner fencing and deadlines                  │
└──────────────────────────────────────────────┘
```

This preserves the component channel’s stronger live-state semantics without rebuilding every mature query-cache feature prematurely.

It also aligns well with the browser as a first-class Source RPC peer:

* the browser consumes component stores;
* it performs query-shaped reads through the query layer;
* it exposes its own browser-owned services;
* it reports commands through the operation store;
* its supplied capabilities remain separate from the data it consumes.

---

# 16. Recommended priority order

## P0 — correctness

1. Restore component subscriptions when the target peer returns.
2. Retry transient resubscription failures with bounded backoff.
3. Prevent duplicate concurrent recovery paths.

## P1 — high-value client state

1. Add an observable operation/command registry.
2. Add structural sharing for supported plain-data snapshots.
3. Add selector-aware React integration.
4. Introduce a pull-cache abstraction or official TanStack Query adapter.
5. Deduplicate identical in-flight `$data` and query calls.

## P2 — coherence and resource use

1. Add version-aware push-to-pull invalidation.
2. Define resource-level versioning for external `$data`.
3. Retain stale component snapshots after the last observer.
4. Add explicit observer activity and visibility policies.
5. Add cache memory and security boundaries.

## P3 — product tooling

1. Persist selected stale snapshots securely.
2. Add client-state devtools.
3. Investigate cross-tab connection sharing.
4. Add query and operation inspection to the CLI console.

TanStack’s cross-tab broadcasting facility is itself currently experimental, so Source RPC need not rush to treat that as a baseline requirement. ([TanStack][7])

# Bottom line

The comparison is excellent and should be retained. Its most valuable conclusions are:

* peer-return subscription recovery is a real current defect;
* Source RPC needs a first-class state layer for `$data` and query methods;
* command outcomes need an observable client-wide home;
* producer revision information can make cache invalidation much more deterministic;
* stale last-known state is preferable to an unexplained blank;
* reported plant state must not be overwritten optimistically.

The document currently overstates TanStack Query’s limitations and overestimates what idempotency proves. After correcting those points, it becomes a strong architectural argument:

> Source RPC’s component channel is not an incomplete TanStack Query replacement. It is a different and stronger primitive for live peer-owned state. The missing pull-cache features can be added—or supplied through a first-party TanStack integration—without weakening that model.

[1]: https://tanstack.com/query/latest/docs/framework/react/reference/useQuery?utm_source=chatgpt.com "useQuery | TanStack Query React Docs"
[2]: https://tanstack.com/query/latest/docs/framework/react/guides/network-mode?utm_source=chatgpt.com "Network Mode | TanStack Query React Docs"
[3]: https://tanstack.com/query/latest/docs/reference/QueryClient?utm_source=chatgpt.com "QueryClient | TanStack Query Docs"
[4]: https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient?utm_source=chatgpt.com "persistQueryClient | TanStack Query React Docs"
[5]: https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates?utm_source=chatgpt.com "Optimistic Updates | TanStack Query React Docs"
[6]: https://tanstack.com/query/latest/docs/framework/react/guides/ssr?utm_source=chatgpt.com "Server Rendering & Hydration | TanStack Query React Docs"
[7]: https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient?utm_source=chatgpt.com "broadcastQueryClient (Experimental)"
