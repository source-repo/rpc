# Review of the current Source RPC framework

I reviewed the repository at commit `03838ba1d871709670729e94e4a7e91db3b5fa0b`, where `@source-repo/rpc` is `5.0.1` and the CLI manifest is `5.0.0`.

The most important conclusion is that the C# implementation is no longer merely a SignalR reference adapter. It now has the right high-level architecture: a transport-neutral `SourceRpc` core, with SignalR, MQTT and socket.io bindings around it. That is a major improvement and is the correct foundation for a genuine .NET package family. However, I would still mark the C# packages as **preview** for industrial command use until three core correctness defects are fixed: subscription lifecycle, response correlation, and idempotency concurrency. ([GitHub][1])

---

# 1. C# architecture: substantially improved

## The package split is now right

The separation is sensible:

```text
SourceRpc
    frame and serialization model
    dispatcher
    invocation model
    client
    error model
    ownership and idempotency abstractions
    routing and subscriptions
    telemetry

SourceRpc.SignalR
    ASP.NET Core hub
    SignalR client transport
    event publishing

SourceRpc.Mqtt
    MQTT 5 transport
    MQTT frame mapping, signing and replay checks

SourceRpc.SocketIo
    socket.io client transport
```

This prevents each transport from reimplementing deadlines, correlations, deferred results, fences and error mapping. The core package also avoids taking an ASP.NET Core dependency, while only the SignalR binding references the ASP.NET shared framework. That is precisely the right boundary for devices or services that only need MQTT. ([GitHub][2])

One documentation detail should be corrected: the README describes the core as depending on “nothing but the BCL,” but it currently references `MessagePack.Annotations`, `Microsoft.Extensions.Logging.Abstractions` and `System.Diagnostics.DiagnosticSource`. The meaningful and accurate claim is that it has **no web framework or transport dependency**, not that it is BCL-only. ([GitHub][3])

## The package consumption API is much better

This is now an appropriate consumer-facing API:

```csharp
builder.Services
    .AddSourceRpc(options =>
    {
        options.Name = "line-controller";
    })
    .AddResponder<AutomationSurface>();

app.MapSourceRpc("/rpc");
```

The package owns the router, subscription registry, dispatcher, telemetry and SignalR protocol setup. Consumers no longer need to understand or register implementation tables themselves. Startup validation of the peer name and carried-peer limit is also good. ([GitHub][4])

## `RpcInvocation` is a good application boundary

Application responders now receive an invocation rather than being expected to interpret a wire frame. They get the checked source identity, authenticated principal, local deadline, owner fence, idempotency key and cancellation token. That is much more idiomatic .NET and gives the package somewhere to enforce protocol semantics before application code runs. ([GitHub][5])

I would eventually remove or demote the public `RpcInvocation.Frame` property. It provides an escape hatch back into the wire representation and weakens the abstraction. An explicitly named `RawFrame` or a read-only metadata collection would make its advanced nature clearer.

## Error handling and telemetry are strong

Unexpected exception details are hidden from callers by default while deliberate `SourceRpcException` messages travel. The use of `ActivitySource` and `System.Diagnostics.Metrics` rather than a mandatory OpenTelemetry dependency is also the correct library design. Arguments and results are not used as metric dimensions, which is especially important for plant data. ([GitHub][6])

The interop testing strategy remains very good. CI is configured with a real MQTT broker, PostgreSQL and MySQL, prevents integration tests silently skipping, exercises the C# peers from TypeScript, and includes Windows SignalR coverage. This is far more meaningful than tests where two mocks agree with one another. ([GitHub][7])

---

# 2. C# release blocker: subscription state is currently incorrect

There are three related problems.

## Multiple local handlers interfere with each other

Every `SubscribeAsync()` sends a remote `subscribe`, even when this C# client already has a subscription for the same target, path and event. The server deduplicates these by peer name, so that part appears harmless.

However, disposing **any one** local subscription always sends a remote `unsubscribe`:

```csharp
var first = await client.SubscribeAsync(
    "plant", "machine", "alarm", FirstHandler);

var second = await client.SubscribeAsync(
    "plant", "machine", "alarm", SecondHandler);

await first.DisposeAsync();
```

After that disposal, `SecondHandler` remains in the local handler list, but the remote peer has been told to stop sending the event completely. It will therefore never run. ([GitHub][8])

## There is an initial event-loss window

`SubscribeAsync()` waits for the remote acknowledgement and only then adds the local handler. Once the remote peer has acknowledged the subscription, it is entitled to emit an event immediately. Such an event can arrive before the local handler has been inserted and will be discarded. ([GitHub][8])

## Reconnection does not restore subscriptions

The hub removes all of a peer’s subscriptions when its connection disappears. The SignalR transport reannounces presence after reconnect, but `ISourceRpcTransport` has no connected/reconnected event and `SourceRpcClient` has no way to replay its active subscriptions. This contradicts the C# README’s statement that a reconnecting peer keeps receiving events. By contrast, the TypeScript client explicitly replays subscriptions after reconnect. ([GitHub][9])

The C# client needs a subscription registry structured approximately like this:

```csharp
internal sealed record SubscriptionKey(
    string Target,
    string Path,
    string Event);

internal sealed class SubscriptionEntry
{
    public HashSet<Action<object?[]>> Handlers { get; } = [];
    public bool RemoteActive { get; set; }
}
```

The rules should be:

1. Add the first local handler before sending the remote subscription.
2. Send one remote `subscribe` when the first handler is added.
3. Roll the handler back if that request fails.
4. Adding later handlers must not send more remote subscriptions.
5. Removing a handler sends `unsubscribe` only when the final handler is removed.
6. On reconnect, replay exactly one subscription per active key.
7. Ensure replay and concurrent disposal cannot race into leaving a ghost subscription.

`ISourceRpcTransport` therefore needs at least a connection-state event:

```csharp
event Action<RpcConnectionState>? ConnectionStateChanged;
```

or an explicit:

```csharp
event Func<Task>? Reconnected;
```

This should have focused tests for two handlers, disposing either one, reconnect, event arrival during subscription, and reconnect racing with disposal.

---

# 3. C# release blocker: replies are correlated by ID but not by peer

`SourceRpcClient` currently stores pending calls as:

```text
correlation → TaskCompletionSource
```

When a `result` or `error` arrives, any frame with a matching correlation completes the call. It does not check that:

* `frame.Src` is the peer originally called;
* `frame.Tgt` is this client;
* the frame kind is valid for that exchange;
* a ticket receipt belongs to the same target;
* the ticket identifier agrees with the correlation.

The same issue applies to deferred ticket frames. ([GitHub][8])

A UUID correlation is difficult to guess, but **unguessability is not authorization**. A relay, bus operator, traffic tap, compromised bridge or peer that observed the original correlation can answer somebody else’s exchange.

Pending state should be something like:

```csharp
internal sealed record PendingExchange(
    string ExpectedSource,
    string ExpectedTarget,
    IReadOnlySet<string> AllowedKinds,
    TaskCompletionSource<RpcFrame> Completion);
```

Every reply should be rejected unless all of these agree:

```csharp
frame.Corr == correlation
frame.Src == pending.ExpectedSource
frame.Tgt == pending.ExpectedTarget
pending.AllowedKinds.Contains(frame.Kind)
```

For deferred work, ticket state should be keyed by at least:

```text
(expected source, correlation)
```

and the receipt’s ticket ID should equal the call correlation.

Invalid replies should produce a rejection metric/log rather than being silently ignored. This is both security hardening and protection against routing bugs.

---

# 4. C# release blocker: idempotency does not prevent concurrent duplicate execution

This is the most serious issue because it affects the framework’s central promise around non-repeatable commands.

The current interface says:

```csharp
Task<RpcOutcome?> BeginAsync(string key, ...);
```

with these meanings:

```text
null      = this caller owns the key and should execute
non-null  = the command already completed; return recorded result
```

The in-memory store inserts `null` to represent a command currently running. That creates this sequence:

```text
Attempt A:
  TryAdd(key, null) succeeds
  BeginAsync returns null
  A executes

Attempt B arrives before A completes:
  TryAdd(key, null) fails
  dictionary contains null
  BeginAsync returns null
  B also executes
```

The implementation comment says simultaneous attempts must not both run, but the value model causes exactly that. More fundamentally, the interface cannot distinguish **claim acquired** from **another execution is already in progress**. ([GitHub][10])

The abstraction needs at least three states:

```csharp
public abstract record RpcIdempotencyClaim
{
    public sealed record Acquired(
        IAsyncDisposable Lease) : RpcIdempotencyClaim;

    public sealed record InProgress(
        Task<RpcOutcome> Completion) : RpcIdempotencyClaim;

    public sealed record Completed(
        RpcOutcome Outcome) : RpcIdempotencyClaim;
}
```

A simpler result with an enum is also possible, but the states must be explicit. Concurrent duplicates should either wait for the first attempt or receive a defined `InProgress` response. They must never execute concurrently.

## Missing stores should not silently weaken keyed commands

The dispatcher only invokes idempotency handling when a store is registered. Otherwise an incoming idempotency key is carried and ignored. The registration code even describes that as safe, although the framework documentation correctly describes execution as at-least-once without a durable store. ([GitHub][4])

There should be one normative cross-language rule. For industrial commands, my preference is:

> When a caller supplies an idempotency key and the target cannot enforce it, refuse the call with `IdempotencyUnavailable`.

An explicit weak mode may be useful for compatibility, but silently accepting the key tells the caller that a safety mechanism was applied when it was not.

## Failure after execution needs `UnknownOutcome`

If the method executes but `CompleteAsync()` fails, the dispatcher logs the problem and still returns the ordinary successful result. That means the command has run but the durable duplicate guard was not committed. If the result is subsequently lost, a retry can execute it again. ([GitHub][6])

This is precisely where the framework’s `UnknownOutcome` concept belongs. The caller must be told:

```text
the command may have run;
the idempotency record was not safely committed;
do not automatically repeat it
```

The C# error model should therefore gain parity with the TypeScript outcome vocabulary.

The design also needs defined behavior for:

* unexpected exceptions after partial side effects;
* caller disconnection during execution;
* process failure after claim but before completion;
* claims that remain `InProgress` indefinitely;
* deferred commands, whose receipt currently returns before a terminal outcome is recorded;
* expiry and administrative recovery of abandoned claims.

This should be fixed before publishing the idempotency API as stable, because changing the store interface later will be a breaking NuGet change.

---

# 5. MQTT binding: several security invariants need tightening

The MQTT work is thoughtful. It uses MQTT 5 response topics, correlation data, expiry, raw-value canonicalization, signatures, timestamps and nonces instead of hiding a flat frame in the payload. That is a strong design.

There are nevertheless several concrete issues.

## Response topics are checked against the network, not the caller

An incoming request is currently allowed to name any response topic that:

* starts with the Source RPC prefix;
* contains no wildcard;
* does not start with `$`.

That is not “one of this caller’s reply topics.” It is **any topic in the whole Source RPC network**, including another peer’s request, response, event or presence topic. The code comment says the check prevents an address targeting another peer’s presence topic, but the implementation’s prefix test admits exactly such a topic. ([GitHub][11])

For an ordinary request, the valid response topic should normally be exactly:

```csharp
Mqtt5Frame.TopicFor(prefix, "rsp", frame.Src)
```

Any alternative response namespace should require an explicit policy.

## Pending reply routes are keyed only by correlation

`_replies` is:

```text
correlation → response topic and encoding
```

A second request with the same correlation can overwrite the first request’s return address. Correlations should be keyed by at least:

```text
(request source, correlation)
```

and looked up for a reply using:

```text
(reply target, correlation)
```

This is particularly important because MQTT callers choose their own correlation IDs. ([GitHub][11])

## Replay state is mutated before signature verification

The nonce is accepted into the replay guard before the signature is verified. An attacker who can observe a legitimate nonce can submit a bad-signature packet first and poison the replay cache, causing the real frame to be rejected as a replay. Timestamp format and time-window checks can occur before expensive signature work, but the nonce should only be committed after authentication succeeds. ([GitHub][11])

## Presence remains unsigned

Presence messages are handled before the signed-frame path. Even with `Verify` configured, any broker client with sufficient publish permissions can announce another peer online or offline. That may be acceptable when broker ACLs strictly bind each client to its own presence topic, but that dependency needs to be explicit in the security model and accompanied by a tested EMQX ACL example. Otherwise presence should use a signed representation too. ([GitHub][11])

---

# 6. The C# caller cannot yet use the framework’s main safety features

The C# dispatcher can receive `ttl`, `idem`, `fence` and contract version fields, but `SourceRpcClient.CallAsync()` only exposes:

```text
target
path
method
arguments
CancellationToken
```

It always uses the global timeout and does not provide outbound idempotency keys, owner fences, contract versions or per-call deadlines. In practical terms, a C# process can enforce several Source RPC safety semantics but cannot conveniently request them. ([GitHub][8])

I would add:

```csharp
public sealed record RpcCallOptions
{
    public TimeSpan? Timeout { get; init; }
    public string? IdempotencyKey { get; init; }
    public string? OwnerFence { get; init; }
    public string? ContractVersion { get; init; }
}
```

with:

```csharp
Task<T> CallAsync<T>(
    string target,
    string path,
    string method,
    object?[]? arguments = null,
    RpcCallOptions? options = null,
    CancellationToken cancellationToken = default);
```

The deferred-call API needs the same options. For non-repeatable commands, the package could also provide a convenience API that requires an idempotency key rather than making it an optional string buried in generic options.

---

# 7. Argument and result conversion must fail loudly

The current conversion logic behaves differently depending on whether values came through JSON or MessagePack:

* JSON uses `JsonElement.Deserialize<T>()`;
* other values use `Convert.ChangeType()`;
* failed client result conversion can return `default`.

That means a malformed result intended to be an integer may become `0`, and malformed booleans may become `false`. In control-oriented software, silently turning bad wire data into a valid-looking default is considerably worse than throwing. ([GitHub][8])

I would expose three deliberate APIs:

```csharp
T GetRequiredArgument<T>(int index);
T? GetOptionalArgument<T>(int index);
bool TryGetArgument<T>(int index, out T? value);
```

Required conversion failures should produce `InvalidParams`. Client result conversion failures should produce a protocol or `InvalidResult` exception.

The same conversion matrix should be tested under JSON and MessagePack for:

* numeric widening and narrowing;
* nullable values;
* enums;
* records and DTOs;
* arrays and lists;
* dictionaries;
* `Guid`;
* `DateTimeOffset`;
* byte arrays;
* missing versus explicit `null`;
* negative argument indices.

A single codec-neutral converter should own this behavior.

---

# 8. Authentication and authorization need separate concepts

`PinSourceToAuthenticatedIdentity` defaults to true, but the current `Vouches()` implementation accepts the claimed name when:

* the connection is unauthenticated;
* the authenticated principal has no usable identifier;
* the name matches the identifier.

That is reasonable for an explicitly unauthenticated development network, but “pinning enabled” must not be confused with “authentication required.” ([GitHub][9])

Add a separate option:

```csharp
public bool RequireAuthenticatedPeers { get; set; }
```

When enabled, the absence of a stable authenticated identity must fail closed.

More importantly, authentication is not sufficient for a bridge. An authenticated bridge can currently advertise arbitrary `carrying` names, subject only to a count limit. It needs authorization over those secondary identities.

A package-level policy could look like:

```csharp
public interface ISourceRpcAuthorizationPolicy
{
    ValueTask<bool> CanAnnounceAsync(
        ClaimsPrincipal principal,
        string peer,
        CancellationToken cancellationToken);

    ValueTask<bool> CanCarryAsync(
        ClaimsPrincipal principal,
        string bridge,
        string carriedPeer,
        CancellationToken cancellationToken);

    ValueTask<bool> CanInvokeAsync(
        RpcInvocation invocation,
        CancellationToken cancellationToken);

    ValueTask<bool> CanSubscribeAsync(
        RpcSubscriptionRequest request,
        CancellationToken cancellationToken);
}
```

Subscription authorization matters because events may reveal production data even when methods are write-protected. The TypeScript framework presents authorization as applying to calls and subscriptions; the C# implementation should provide corresponding semantics. ([GitHub][3])

---

# 9. There is a reconnect race in `RpcRouter`

The router deliberately lets a reconnecting peer take over its previous name. That is correct.

However, `Remove(connectionId)` first gathers matching names and then removes those names without checking that the route still belongs to the departing connection:

```text
old connection starts Remove()
old connection snapshots name "plc-1"
new connection announces "plc-1"
old connection removes "plc-1" by name
new route is accidentally deleted
```

The same pattern appears while removing stale carried routes. This race is especially plausible precisely during reconnection, which is the scenario the takeover behavior is designed to support. ([GitHub][12])

Removal must be conditional on the exact route value or a connection generation:

```csharp
_routes.TryRemove(
    new KeyValuePair<string, PeerRoute>(name, expectedRoute));
```

The hub should only emit `offline` and drop subscriptions for routes that were actually removed.

---

# 10. Connection lifecycle and dispatch need stronger package semantics

## `StartAsync()` does not mean ready

The SignalR transport’s `StartAsync()` returns after scheduling retries even when no connection exists. A consumer can therefore do this:

```csharp
await client.StartAsync();
await client.CallAsync(...);
```

and immediately receive `TransportError` because the first method did not actually wait for connectivity. TypeScript already provides `ready()` and a separate `peersSettled()` concept. The C# client should make the same distinction explicit. ([GitHub][13])

A better lifecycle would be:

```csharp
await client.StartAsync(hostStoppingToken);
await client.WaitUntilConnectedAsync(startupTimeoutToken);
```

or make `StartAsync()` await the first connection and expose a separate `RunAsync()` for lifetime management.

The token currently passed to `StartAsync()` is linked to the transport’s entire lifetime. That is surprising for callers who intend it only as a startup timeout. Use an internal lifetime `CancellationTokenSource`; a startup token should cancel waiting for initial readiness without permanently disabling future reconnects.

## Dispatch is unbounded and unordered

The transports start frame dispatch without awaiting it to avoid deadlocking their receive loops. The reasoning is sound: a responder may call another peer and must continue receiving the reply.

But unrestricted fire-and-forget dispatch creates another problem:

* unbounded concurrent responder calls;
* loss of call ordering;
* possible reordering of commands;
* no overload signal;
* memory growth during bursts.

Use a bounded `Channel<ReceivedFrame>` with configurable concurrency. Preserve ordering for methods or paths that declare it, while allowing independent reads to execute concurrently. When capacity is exhausted, refuse or shed work explicitly rather than accumulating it invisibly.

## Protocol limits need to be explicit

The C# hub increments `hops` when relaying but does not enforce a maximum. Recursive batch unpacking also needs depth and item-count limits. Add configurable bounds for:

* frame size;
* body size;
* batch depth and count;
* path, method and correlation lengths;
* maximum hops;
* concurrent calls;
* pending exchanges;
* tickets;
* subscriptions;
* carried peers.

These limits protect against both hostile traffic and accidental loops or storms.

---

# 11. Deferred work needs lifecycle completion

The deferred/ticket model is a valuable addition, but the package should define and enforce the entire lifecycle:

* ticket expiry currently appears to be metadata rather than an active timer;
* pending tickets can survive transport disposal indefinitely;
* a failed terminal send can leave the deferred object marked settled even though the caller did not receive it;
* progress handlers should be isolated like ordinary event handlers;
* rejecting with an arbitrary exception must follow the same exception-detail policy as ordinary calls;
* deferred idempotent commands need their final result tied to the original idempotency claim;
* a late SignalR result should not blindly target a stale connection ID after reconnect.

A ticket needs a terminal local state even when the network disappears:

```text
Resolved
Rejected
Expired
TransportLost
UnknownOutcome
```

The distinction between `TransportLost` and `UnknownOutcome` should depend on whether the operation may already have executed.

---

# 12. Make event publishing transport-neutral

`ISourceRpcEvents` currently belongs to `SourceRpc.SignalR`. That works for a process serving a SignalR hub, but a C# peer connected through MQTT or socket.io should be able to inject the same abstraction and publish ordinary Source RPC events.

Move an interface such as this into the core:

```csharp
public interface ISourceRpcEventPublisher
{
    Task EmitAsync(
        string path,
        string eventName,
        object?[] arguments,
        CancellationToken cancellationToken = default);
}
```

A binding-specific implementation can handle fan-out and addressing. Fan-out should isolate per-peer send failures so that one broken route does not prevent later subscribers from receiving the event.

---

# 13. C# package and NuGet readiness

The projects are now genuinely packable: they include package IDs, repository metadata, symbols, XML documentation and explicit versions. However, the repository’s release workflow currently automates npm and container publication, not NuGet publication, while the C# README still documents a local feed. I could not verify a public NuGet release from the repository workflow. ([GitHub][2])

Before making NuGet the supported installation path, I would add:

1. A tagged CI job that packs all four .NET packages.
2. Installation smoke tests against the produced `.nupkg` files in fresh projects.
3. Symbol package publication.
4. NuGet package README files for every package, including the core.
5. API compatibility checks using `ApiCompat` or Public API Analyzers.
6. A C# unit-test project, not only the TypeScript-driven test host.
7. Race tests for routing, subscription reference counting and idempotency.
8. A central version source for the .NET projects.

Two smaller API issues are worth correcting before stabilizing:

* `UseMessagePack` is SignalR-specific but lives in `SourceRpcOptions`; move it to `SourceRpcSignalROptions`.
* `AddSourceRpc()` invokes the configuration delegate twice to decide whether to register MessagePack. Configuration delegates are not guaranteed to be free of side effects, and post-configuration or configuration binding cannot influence that early decision. Either always register both SignalR protocols or separate the core and binding configuration methods. ([GitHub][14])

`AddResponder<T>()` also permits multiple registrations, while the dispatcher resolves a single `ISourceRpcResponder`. Either reject duplicate registration or intentionally introduce path-based responder composition.

---

# 14. Overall framework assessment

## The framework now has a defensible identity

The strongest part of Source RPC is not “typed TypeScript RPC.” Many projects already do that.

Its distinctive combination is:

```text
a peer network rather than one client/server pair
+ multiple interchangeable transports
+ explicit physical-command semantics
+ owner fencing and authority
+ observable component state
+ topology and inherited context
+ runtime contracts and compatibility checking
+ operational tooling
```

The README’s recommendation to use tRPC for an ordinary browser-to-server application is excellent positioning. It makes the intended problem credible rather than claiming Source RPC should replace every other RPC system. ([GitHub][3])

The component package family is also coherent. The MongoDB, relational and Docker packages expose existing systems through a common `DataProvider` shape; the queue adds a lease-based work model; SignalR reaches .NET; and Sparkplug is clearly described as a session substrate rather than pretending the full projection is already complete. ([GitHub][3])

## The CLI is a major product asset

The CLI is not merely a debugging command. It provides:

* contract extraction, checking and live diffs;
* a browser console;
* bus operation;
* peer description and calls;
* event watches;
* fakes and simulators;
* record/replay;
* load benchmarking;
* an MCP server;
* capability discovery;
* combined task-file execution.

That makes Source RPC an operable system rather than just a library API. In particular, contract checking, fake peers and record/replay materially reduce the cost of replacing or testing industrial devices. ([Source Repo][15])

The MCP defaults are also considered: HTTP binds to loopback by default, widening the bind without a token is refused, and token values come from an environment variable or file rather than a process-list-visible command-line value. ([Source Repo][16])

## Release engineering is stronger than most small frameworks

The npm release workflow reruns build, lint, type checking, contract checking and tests, uses npm provenance, and builds the CLI image from the published package. CI is configured to use real supporting services rather than letting integration tests quietly disappear. That substantially improves confidence in the package artifacts. ([GitHub][17])

---

# 15. The framework now needs a real cross-language conformance suite

The existence of both TypeScript and C# implementations changes what counts as the specification.

At present there are:

* descriptive wire-format documents;
* TypeScript tests;
* C# interoperability tests driven from TypeScript;
* an unpublished `@source-repo/conformance` package focused on the `DataProvider` fixture.

That is a good start, but TypeScript behavior must not become the accidental normative specification. ([GitHub][18])

I would create two distinct conformance layers.

## Wire conformance

Publish language-neutral fixtures for:

* flat JSON frames;
* flat MessagePack frames;
* MQTT 5 properties and payloads;
* signing canonicalization;
* binary values;
* malformed frames;
* unsupported versions;
* duplicate properties;
* invalid response topics;
* replay and timestamp cases;
* nested and oversized batches.

Every implementation should consume the same fixture files.

## Semantic conformance

Define executable scenarios for:

* call success and errors;
* deadline before execution;
* deadline while queued;
* owner-fence mismatch;
* concurrent duplicate idempotency keys;
* crash or failure after execution but before idempotency commit;
* deferred receipt, progress and terminal result;
* reconnect and subscription replay;
* multiple local subscribers;
* duplicate and forged replies;
* event epoch and sequence gaps;
* peer takeover;
* carried-peer authorization;
* relay hop limits;
* disconnect during a repeatable versus non-repeatable command.

The CLI could expose this as:

```text
source-rpc conformance --peer <peer>
```

A compatibility matrix should then state which features each language and transport implements:

```text
                        TypeScript   C# SignalR   C# MQTT   C# socket.io
calls                       yes          yes         yes          yes
subscriptions/replay        yes          no          no           no
deferred                    yes          partial     partial      partial
idempotency                 yes          broken      broken       broken
owner fence                 yes          yes         yes          yes
signed presence             n/a          n/a         no           n/a
runtime schema              yes          no          no           no
```

The exact matrix will change as fixes land, but publishing it prevents “ordinary peer” from being interpreted as “every semantic feature is identical.”

---

# 16. Add a strict production profile

The TypeScript defaults are convenient for development:

* schema is optional;
* validation is off when no schema is present;
* unknown contract versions are allowed;
* explicit method exposure is not required;
* result validation is off;
* authenticated peers are required only when authentication is configured.

At the same time, introspection, remote topology mutation and path-based state writes are sensibly opt-in. ([GitHub][19])

For production plant deployment, developers should not need to discover the safe combination one option at a time. Provide a profile such as:

```typescript
const server = new RpcServer({
    profile: 'production',
    name: 'line-controller',
    schema,
    authenticate,
})
```

The production profile should approximately mean:

```text
schema required
runtime validation required
explicit exposure required
unknown versions rejected
authentication required
results optionally validated
introspection off
remote construction off
remote topology mutation off
state path writes off
relay explicitly configured
frame and concurrency limits enabled
```

Individual options can still override the profile, but the default bundle makes security review and deployment documentation much easier.

This also clarifies an important distinction in the README:

> “A class is the contract” provides excellent TypeScript ergonomics, but a TypeScript type is not a runtime wire guarantee unless a schema is generated and enforced.

---

# 17. Cancellation belongs in a future protocol revision

The repository explicitly states that Source RPC has deadlines but no cancellation. That is honest and better than implying a timeout stops physical execution. ([GitHub][18])

Nevertheless, cooperative cancellation will eventually be valuable for long reads, queries, simulations, uploads and queued work. It should not be modelled as “the timeout fired, therefore the command was undone.”

A future design should distinguish:

```text
caller stopped waiting
cancel request sent
cancel accepted before work started
handler observed cancellation while running
handler completed despite cancellation
execution outcome unknown
```

A method should opt into cancellation semantics, and handlers should receive `AbortSignal` in TypeScript and `CancellationToken` in C#. For non-repeatable physical commands, cancellation is generally only a request to stop further work; it is not rollback and must not turn `UnknownOutcome` into `DidNotRun`.

This is appropriate for the next major protocol version rather than a small `5.x` addition.

---

# 18. Package release consistency needs tightening

The repository builds and documents a wider package family than the current release workflow automatically publishes. The workflow publishes the core, CLI, Docker and queue packages; the README also presents document, relational, Sparkplug and SignalR packages as npm packages. Those packages may be published manually, but manual and automated release paths create avoidable version drift. ([GitHub][3])

I would add one release manifest or Changesets-style process that records, for each package:

```text
current version
stability: stable | preview | experimental
protocol compatibility
changed in this release?
publish to npm?
publish to NuGet?
publish container?
```

The current rule requiring the core and CLI to share the tag version is simple, but it forces a CLI version bump for library-only releases. That is acceptable at this stage; once the ecosystem grows, independent package versions with a generated compatibility table will scale better.

Versioned documentation is also becoming important. Package pages should link to documentation matching the installed major/minor rather than always linking to mutable `main`.

---

# 19. Consider splitting the npm transport footprint later

`@source-repo/rpc` has regular dependencies on the MQTT client, socket.io server, socket.io client, MessagePack and the mnemonic/signing-related packages. Conditional browser exports prevent much of that from entering a browser bundle, but every installation still receives the whole dependency and supply-chain footprint. ([GitHub][20])

A future structure could be:

```text
@source-repo/rpc-core
@source-repo/rpc-socketio
@source-repo/rpc-mqtt
@source-repo/rpc             umbrella convenience package
```

The umbrella package should remain because the current simple installation is valuable. I would not make this an immediate refactor; fixing semantic correctness and conformance is more important than optimizing package boundaries.

---

# 20. Treat recordings as sensitive plant artifacts

Record/replay is one of the best CLI features, and payloads need to be present for meaningful replay. The CLI therefore records arguments and results by default and announces this at startup. ([Source Repo][15])

Those files may contain:

* process values;
* recipes;
* identifiers;
* alarm text;
* customer production data;
* credentials accidentally passed as arguments;
* proprietary operating sequences.

I would add:

* restrictive file permissions on creation;
* a prominent full-path warning;
* configurable field redaction;
* optional encryption using a key file or OS secret facility;
* rotation and retention controls;
* a metadata marker saying whether the recording was redacted;
* refusal to replay redacted fields as though they were real inputs.

Keeping payloads on by default for `record` is defensible because replay is its purpose. The surrounding storage protections need to match the sensitivity.

---

# Recommended implementation order

## Immediate `5.0.x` C# correctness work

1. Redesign idempotency claim states and fix concurrent duplicate execution.
2. Add `UnknownOutcome` and fail appropriately when outcome persistence fails.
3. Rebuild C# subscription bookkeeping with reference counting and reconnect replay.
4. Bind replies and tickets to the expected source and target.
5. Fix MQTT response-topic authorization, reply-map keys and replay-check ordering.
6. Make router removal conditional on the exact connection generation.
7. Add regression and race tests for all six.

## Before a supported public NuGet release

1. Add outbound `RpcCallOptions`.
2. Add strict argument/result conversion.
3. Add authentication-required and authorization-policy APIs.
4. Add connection lifecycle and readiness APIs.
5. Add bounded dispatch and protocol resource limits.
6. Complete deferred ticket cleanup and disconnect behavior.
7. Move event publishing into the transport-neutral core.
8. Add C# unit tests, public API checks and automated NuGet publishing.

## Framework-level `5.x` work

1. Publish protocol and semantic conformance fixtures.
2. Publish a language/transport feature matrix.
3. Add a strict production profile.
4. Bring every public component package into the release workflow.
5. Protect recordings as sensitive artifacts.
6. Add fault-injection tests for partitions, reconnect storms, duplicate frames, slow handlers and idempotency commit failures.

## Next major protocol work

1. Cooperative cancellation with explicit outcome semantics.
2. Capability negotiation for batch support and future frame features.
3. Possible npm core/transport package split.
4. A stable cross-language generated-client or contract-consumption story for C#.

# Bottom line

Source RPC now has the architecture and surrounding tooling of a **real framework**, not a transport experiment. Its strongest proposition is the combination of mixed-transport peer networking, explicit command-risk semantics, observable components, topology/context and a genuinely useful operational CLI.

The TypeScript core and CLI look credible for controlled production use, provided high-risk commands use a tested durable idempotency implementation and production deployments enable schema validation, authentication and explicit exposure.

The C# architecture is now good enough to invest in. The current implementation is suitable for interoperability testing and ordinary calls, but I would not yet rely on it for non-repeatable physical commands or durable long-lived subscriptions. The subscription and idempotency defects directly contradict the guarantees users are most likely to choose Source RPC for; fixing those, then making conformance executable across languages, would move the whole framework from promising to genuinely dependable.

This was a source-level review of the identified repository snapshot and published manifests/documentation. I was unable to run the suite independently in the container because its external DNS resolution failed; the runtime findings above come from tracing the current code paths, while the repository’s CI is configured to exercise the cross-language and service-backed scenarios.

[1]: https://github.com/source-repo/rpc/commit/03838ba1d871709670729e94e4a7e91db3b5fa0b "https://github.com/source-repo/rpc/commit/03838ba1d871709670729e94e4a7e91db3b5fa0b"
[2]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/SourceRpc.csproj "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/SourceRpc.csproj"
[3]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/README.md "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/README.md"
[4]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/ServiceCollection.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/ServiceCollection.cs"
[5]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Invocation.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Invocation.cs"
[6]: https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Dispatcher.cs "https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Dispatcher.cs"
[7]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/.github/workflows/ci.yml "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/.github/workflows/ci.yml"
[8]: https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Client.cs "https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Client.cs"
[9]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/RpcHub.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/RpcHub.cs"
[10]: https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Semantics.cs "https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Semantics.cs"
[11]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.Mqtt/MqttTransport.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.Mqtt/MqttTransport.cs"
[12]: https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Routing.cs "https://github.com/source-repo/rpc/raw/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Routing.cs"
[13]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/SignalRClientTransport.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc.SignalR/SignalRClientTransport.cs"
[14]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Options.cs "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/csharp/SourceRpc/Options.cs"
[15]: https://source-repo.github.io/rpc/tools/cli "https://source-repo.github.io/rpc/tools/cli"
[16]: https://source-repo.github.io/rpc/tools/mcp "The MCP server | Source RPC"
[17]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/.github/workflows/release.yml "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/.github/workflows/release.yml"
[18]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/README.md "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/README.md"
[19]: https://github.com/source-repo/rpc/blob/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/src/RpcServer.ts "https://github.com/source-repo/rpc/blob/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/src/RpcServer.ts"
[20]: https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/package.json "https://raw.githubusercontent.com/source-repo/rpc/03838ba1d871709670729e94e4a7e91db3b5fa0b/packages/rpc/package.json"
