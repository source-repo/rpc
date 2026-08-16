# Source RPC for .NET

A .NET process as a peer on a Source RPC network — serving methods, publishing events, and calling out to other peers. It speaks the same protocol the TypeScript library speaks, in whichever of its two spellings the carrier calls for: the flat frame of [`docs/flat-frame-spec.md`](../../docs/flat-frame-spec.md) on a connection, and the `mr-` property layout of [`docs/mqtt5-frame-spec.md`](../../docs/mqtt5-frame-spec.md) on a broker.

## Four packages, and why

| package | what is in it | depends on |
| --- | --- | --- |
| **`SourceRpc`** | the frame, the dispatcher, the client, routing, the error model, telemetry | no web framework, no transport |
| **`SourceRpc.SignalR`** | a hub for a process others dial into, and a client transport for one that dials out | ASP.NET Core |
| **`SourceRpc.Mqtt`** | a peer on a broker — no server to write, because the broker is the middle | MQTTnet |
| **`SourceRpc.SocketIo`** | a client for a .NET process that dials into a TypeScript socket.io server | SocketIOClient |

The split is the point. A SignalR hub needs ASP.NET Core; an MQTT client on a device does not, and should not carry a web framework to get a protocol. The core takes `MessagePack.Annotations`, `Microsoft.Extensions.Logging.Abstractions` and `System.Diagnostics.DiagnosticSource` and nothing else - it is transport-free rather than dependency-free, which is the claim that matters for a device. So everything that decides what a frame *means* lives in `SourceRpc`, and a binding is a small class that moves frames.

```
Application
   │  ISourceRpcResponder            what this process serves
   │  ISourceRpcEvents               what it announces
   │  SourceRpcClient                what it calls
   ▼
SourceRpc                            frame · dispatcher · client · routing · errors · telemetry
   ▼
ISourceRpcTransport                  ← the seam
   ▼
SourceRpc.SignalR                    hub (server) + client transport
SourceRpc.Mqtt                       peer on a broker
SourceRpc.SocketIo                   client only
```

**The bindings.** SignalR gives both halves, because ASP.NET Core can host a hub. MQTT has no server to write at all, since the broker is the middle — a peer subscribes to its own topics and publishes to others'. socket.io gives a **client only**: socket.io's server is a Node library with no maintained .NET equivalent, and none is needed, since the TypeScript side already serves socket.io. A .NET process that needs to be *dialled into* serves SignalR instead — the same flat frame under different method names, which is why a TypeScript client reaches either.

**MQTT does not use the flat frame, and that is the point of it.** It speaks the `mr-` property layout of [`docs/mqtt5-frame-spec.md`](../../docs/mqtt5-frame-spec.md): the topic carries the addressee, `responseTopic` says where a reply goes, `correlationData` pairs it, and `messageExpiryInterval` lets the broker drop a request whose caller has stopped waiting. A flat frame in the payload would throw all of that away — along with the property the layout exists for, that a plain MQTT client with no msgrpc code can take part and an operator can see why a call failed in MQTT Explorer without decoding anything. What the two share is the *model*: both map to `RpcFrame`, so a call means the same thing on either and only the spelling differs. That claim is what `packages/rpc/src/MqttInterop.test.ts` tests, by putting a TypeScript peer and a C# peer on one broker.

Adding one is a class implementing [`ISourceRpcTransport`](SourceRpc/Transport.cs): start a link, send a frame, raise an event when one arrives. Correlation, deadlines, subscriptions, error mapping and dispatch are already written, once, in the core — which is what stops three transports quietly disagreeing about what a timeout means. `TransportContract` in the same file records what a binding must get right.

That is not a claim about tidiness. Every binding written since has arrived carrying the same three mistakes, and each was found by a test rather than by review: a receive loop that waits for the responder (so a responder that calls out mid-invocation deadlocks, and reports as a slow method); a peer list built from the first presence message only (so it freezes at whatever was online when the process started); and a payload handed to a deserializer before anything has authenticated it. Read `TransportContract` before writing a fourth.

## Serving

```csharp
builder.Services
    .AddSourceRpc(options => options.Name = "vs-automation")
    .AddResponder<AutomationSurface>();

var app = builder.Build();
app.MapSourceRpc("/rpc");
```

That is the whole registration. There is no peer table, subscription table, hub type or frame in it: those are the library's, they have changed three times already, and an application that had registered them by hand would have been broken by all three.

```csharp
public sealed class AutomationSurface(DTE2 dte) : ISourceRpcResponder
{
    public ValueTask<object?> InvokeAsync(RpcInvocation call, CancellationToken cancellationToken = default)
    {
        if (call.Path != "solution")
            throw SourceRpcException.NotFound(call.Path);

        return ValueTask.FromResult<object?>(call.Method switch
        {
            "fullName" => dte.Solution.FullName,
            "open"     => Open(call.Arg<string>(0)!),
            _ => throw SourceRpcException.NoSuchMethod(call.Path, call.Method)
        });
    }
}
```

`RpcInvocation` is what the application sees, and it is deliberately not the frame: arguments come off `call.Arg<T>(0)` and read the same under either hub protocol, `call.Deadline` is a moment rather than the duration the wire carries, and `call.Source` has been checked rather than merely asserted.

## Events

```csharp
public sealed class BuildWatcher(ISourceRpcEvents events)
{
    private Task OnBuildFinished(bool ok) => events.EmitAsync("solution", "built", ok);
}
```

A TypeScript peer receives that as an ordinary subscription. Three things about it are decisions rather than accidents: the count runs whether or not anyone is subscribed, so a subscriber that joins late can tell how many it missed; a repeated subscribe is one subscription, because a client replaying after a reconnect must not be served twice; and a subscription is keyed by peer name rather than connection, so a reconnecting peer keeps receiving.

## Calling out

```csharp
var options = new SourceRpcOptions { Name = "line-controller" };
await using var transport = new SignalRClientTransport("http://plant:5217/rpc", options);
await using var client = new SourceRpcClient(transport, options, new SourceRpcTelemetry());
await client.StartAsync();

var reading = await client.CallAsync<string>("vs-automation", "meter", "read", ["flow"]);
await using var watch = await client.SubscribeAsync("vs-automation", "meter", "tick", args => Console.WriteLine(args[0]));
```

A client is a peer, so it can also be called: give it a dispatcher and frames addressed to it are served down the same link. That is the ordinary shape for a device that both reports and takes instructions.

The carrier is one constructor. The same three lines over socket.io, dialling a TypeScript server:

```csharp
await using var transport = new SocketIoClientTransport("http://plant:3000", options);
```

or over a broker:

```csharp
await using var transport = new MqttTransport(new MqttTransportOptions { BrokerUrl = "mqtt://plant:1883" }, options);
```

Everything above the transport — correlation, deadlines, tickets, fences, idempotency, error mapping — is the same code in all three cases, which is what stops three bindings quietly disagreeing about what a timeout means.

**A socket.io namespace goes in the URL**, as `http://plant:3000/cell-3`. `EnginePath` is engine.io's endpoint path (default `/socket.io`) and is only for a server mounted somewhere unusual — putting a namespace there produces a peer that never connects while the server logs nothing at all, which is a long way to travel from the symptom.

**A reply has to come back from the peer you asked.** A pending call is held with the peer it went to, and a `result`, `error` or `ticket` naming a different source is refused and counted rather than accepted. A correlation is hard to guess and that is not the same as permission to answer — on a broker it travels in `correlationData`, where the broker and anything subscribed to the topic can read it.

**A refused frame is announced, not dropped.** The MQTT and socket.io transports raise `Rejected` with a reason — an unreadable frame, a bad signature, a reply address outside the network — because silence reaches a caller as a timeout, which is indistinguishable from a slow method and sends the search to the wrong place. Subscribe to it, or pass an `ILogger`; the default logger discards everything.

## Identity

**A frame's `src` is a claim until something checks it.** The hub records which peers a connection holds a route for — the name it announced, plus whatever it advertised as `carrying` — and refuses a frame naming anything else. Without that, any connected client could send `src: "plc-production-1"` and be treated as that peer; and since subscriptions are keyed by the same field, it could cancel that peer's subscriptions too.

Where the hub authenticates, `PinSourceToAuthenticatedIdentity` additionally requires the announced name to match the authenticated principal. Where it does not, a name was never evidence of anything — but it is still recorded, which is what makes the frame check mean something even unauthenticated.

`carrying` is part of the same answer rather than a separate feature: a bridge advertises the peers behind it, they become addressable before they have spoken — reachability comes from presence, not from waiting for the destination to talk first — and they become names that bridge, and only that bridge, may originate frames for.

## Errors

`SourceRpcException` carries the code a caller acts on, and its message always travels because somebody wrote it to be read. Anything else that escapes a method becomes `Exception` with a generic message, and the real one goes to the log — a vendor exception can contain a file path, a connection string or the innards of a COM error, and a plant network is not the place to publish it. `IncludeExceptionDetail` opts in, for development.

## Telemetry

Counters, a duration histogram and spans, through `System.Diagnostics.Metrics` and `ActivitySource` — the BCL's own instruments, so there is no OpenTelemetry dependency here and a host that wants traces adds the meter and source to its own exporter:

```csharp
.AddMeter("SourceRpc").AddSource("SourceRpc")
```

`rpc.calls`, `rpc.call.duration`, `rpc.errors`, `rpc.frames.sent`, `rpc.frames.received`, `rpc.frames.rejected`, `rpc.routing.failures`, `rpc.connections`, `rpc.subscriptions`. Tagged with path and method, never with arguments or results: a dimension is a label on a time series, and plant data does not belong in one.

## Publishing to a local feed

A NuGet feed is a folder. Registering one on the machine takes a line, and then `dotnet add package` finds these the same way it finds anything from nuget.org:

```
mkdir -p ~/nuget-local
dotnet nuget add source ~/nuget-local -n source-local     # writes ~/.nuget/NuGet/NuGet.Config

npm run pack:csharp
dotnet nuget push packages/csharp/nupkg/*.nupkg -s source-local
```

A consumer anywhere on the machine then does `dotnet add package SourceRpc.SignalR`, and `SourceRpc` comes with it as a transitive dependency. That is worth doing before a real registry exists, because it removes the failure a cross-repository `ProjectReference` invites: a relative path out of one working tree and into another, which resolves on the machine that wrote it and ships broken from anywhere else.

**Bump the version before re-pushing.** A folder feed will not replace an existing `<id>.<version>.nupkg`, and a consumer that has already restored `5.0.0` has it cached in `~/.nuget/packages` regardless — so republishing the same number is the one way to be sure everybody is looking at something different from what you built.

## Building and testing

```
npm run build:csharp     # the solution
npm run pack:csharp      # all four NuGet packages, into packages/csharp/nupkg
npm run hub              # the test host, for the interop suite to point at
```

`packages/signalr/src/Interop.test.ts` drives a real TypeScript `RpcClient` against the real hub over both hub protocols. `TestHost` doubles as the C# client smoke test:

```
dotnet run --project packages/csharp/TestHost -c Release -- client http://127.0.0.1:5217/rpc vs-automation
```

And the MQTT pairing, which needs a broker and both peers:

```
dotnet run --project packages/csharp/TestHost -c Release -- mqtt mqtt://127.0.0.1:1883 msgrpc/v2

SOURCE_RPC_TEST_CSHARP_MQTT=csharp-mqtt SOURCE_RPC_REQUIRE_CSHARP_MQTT=1 \
    npm test --workspace=@source-repo/rpc
```

A second peer with `RPC_MQTT_SECRET` set signs every frame and refuses anything unsigned, which is what `MqttSignedInterop.test.ts` needs:

```
RPC_PEER_NAME=csharp-signed RPC_MQTT_SECRET=interop-secret \
    dotnet run --project packages/csharp/TestHost -c Release -- mqtt mqtt://127.0.0.1:1883 msgrpc/v2
```

And socket.io, where the roles are the other way round — the C# peer dials a server the test suite starts, so start the peer *first* and let its retry loop close the gap:

```
RPC_PEER_NAME=csharp-socketio \
    dotnet run --project packages/csharp/TestHost -c Release -- socketio http://127.0.0.1:3970

SOURCE_RPC_TEST_CSHARP_SOCKETIO=csharp-socketio npm test --workspace=@source-repo/rpc
```

`MqttHostileFrames.test.ts` is the one to run after touching a receive path. It sends what an attacker sends — a nesting bomb, a crafted timestamp, thousands of unsigned nonces — and asserts from *outside* the peer that it still answers, because a process killed by a stack overflow returns no error to assert on. The socket.io suite carries one case of the same shape.

**Turn on container validation in your host.** A dependency cycle among these registrations produced a hub whose methods were silently never invoked — SignalR accepted the connection, the caller's `invoke` never returned, and nothing was logged. With validation on, the same mistake is a startup exception naming the cycle:

```csharp
builder.Host.UseDefaultServiceProvider(o => { o.ValidateOnBuild = true; o.ValidateScopes = true; });
```

## Deadlines, fences, idempotency and deferred answers

Checked in front of the responder, in the order that matters. A fence asks whether this command still belongs to the world its caller observed; the deadline asks whether anyone is still waiting; the store asks whether it has already been done. Running first and checking after would answer all three too late.

**The owner fence** is enforced when an `IRpcOwnership` is registered, and **refused when one is not**:

```csharp
.AddOwnership<TopologyOwnership>()
```

Both directions fail closed — a fence with no ownership recorded anywhere, and a fence against an instance this process holds no record of. A peer that accepted a fence it could not check would be telling the caller its command had been guarded when nothing had guarded it, which is worse than refusing.

**Idempotency** answers a repeat from the record rather than running it again:

```csharp
.AddIdempotencyStore<InMemoryIdempotencyStore>()   // or something durable
```

A store answers one of three things, and the middle one is why it is not a nullable outcome:

```csharp
RpcIdempotencyClaim.Acquired     // nobody else has this key; run it, then record the outcome
RpcIdempotencyClaim.InProgress   // another attempt is running it now; do not run a second
RpcIdempotencyClaim.Completed    // it already ran, and this is what it answered
```

A store that can only say *here is the record* or *there is none* cannot tell **nobody has run this** from **somebody is running it right now** — so two attempts arriving together both read the absence of a record and both execute, which is the exact failure the store exists to prevent. A duplicate that finds the key in progress is **dropped rather than answered**: its caller is already waiting on the attempt that holds the key, and two answers to one request would be worse than one. That is the same rule the TypeScript store follows, deliberately.

The outcome is written *before* the caller is answered, because a crash between running and recording leaves a command that ran and can be run again — the record is the commit point, not the reply. Three failures around that now have their own answers:

- **The store cannot be reached** → `UnknownOutcome`, not `TransportError`. Failing open would mean the one condition under which double execution is possible is also the one under which nothing is checking.
- **The command ran but the outcome could not be written** → `UnknownOutcome`. Answering success here is the one case where the ordinary answer is a lie: the guard against a retry is not in place, and if the answer is lost the retry runs the command again.
- **A key arrives and no store is registered** → `IdempotencyUnavailable`. Carrying the key and enforcing nothing tells the caller a guard was applied when none was. `AllowUnenforcedIdempotencyKeys` opts back in for a network mid-migration.

`InMemoryIdempotencyStore` forgets on restart and says so; a host that dispenses or starts a pump wants something durable.

**Not yet done:** a deferred command holds its claim after the ticket settles, because nothing records an outcome for it. A retry is dropped as in-progress rather than run twice — the safe half — but the key stays unusable until the store expires it.

**A method can answer later:**

```csharp
case "build":
{
    var deferred = call.Defer<BuildResult>();
    _ = Task.Run(async () =>
    {
        await deferred.ProgressAsync(50);
        await deferred.ResolveAsync(await BuildAsync());
    });
    return deferred.Receipt;          // the caller is told at once that an answer is coming
}
```

The ticket's id is the call's own correlation, so nothing is minted and nothing extra travels — and a caller accepts the later answer only for a call it actually made, to the peer it made it to, which is what leaves a forged result nothing to attach itself to. From C#, `client.CallDeferredAsync<T>(…)` returns an `RpcTicket<T>` with a `Result` task and a `Progress` event.

## Signing on MQTT

MQTT is the one carrier where a frame's `mr-src` is only a claim. Peers connect to a broker rather than to each other, so a receiver has no connection to attribute a message to; a broker operator, or any peer whose ACLs let it publish to another peer's topic, can otherwise issue commands as anybody. On socket.io and SignalR the connection is authenticated once at the handshake and the source pinned to it, which is a stronger claim checked in one place — and is why those two bindings have no per-frame signature and do not need one.

```csharp
var secret = Encoding.UTF8.GetBytes(configuration["Rpc:Secret"]!);
var mqtt = new MqttTransportOptions
{
    BrokerUrl = "mqtt://plant-broker:1883",
    Sign = MqttSigning.HmacSigner(secret),
    // Given the sender's name, so a real deployment holds one secret per peer rather than one
    // secret shared by all of them — HMAC is symmetric, and whoever can verify can also forge.
    Verify = MqttSigning.HmacVerifier(peer => SecretFor(peer)),
};
```

`Verify` returns the peer it has *proven* the frame is from, and the transport re-checks that name against the frame's own `mr-src`. It is deliberately not a bool: a verifier that resolves keys loosely — `(canonical, sig, _) => AnyKnownKeyVerifies(...)` is an easy thing to write — would otherwise remove the binding between a signature and a name, which is the entire property signing provides here, with nothing in the library noticing.

With `Verify` set, an unsigned frame is refused, so signing cannot be bypassed by omitting the signature. What the signature covers is everything a receiver *acts on*: the topic and the source, the reply address, the path and method, the content type that decides how the payload is read, the error code, the contract version, the ttl, the owner fence, the idempotency key, the deferred marker, the ticket outcome and the event cursor — and the payload itself. `messageExpiryInterval` is deliberately excluded: the broker rewrites it in flight, so a signature over it would break on the first queued message, and it may only narrow the signed ttl.

Verification runs over the properties **as they arrived**, not over a parsed copy of them. That distinction has teeth: rebuilding the canonical bytes from `frame.Ttl?.ToString()` re-spells what somebody else wrote, so a plain MQTT peer sending `mr-ttl: "05000"` — a perfectly valid frame — had its perfectly valid signature refused as "bad signature". Being reachable by a peer with no msgrpc code in it is the whole reason this layout exists.

**The payload is not read until the frame is verified.** A broker gives anyone who can publish to a peer's request topic a direct line to a deserializer, and MessagePack's standard options are documented as omitting all protections, including any bound on nesting depth — so a few kilobytes of nested one-element arrays was a `StackOverflowException`, which .NET cannot catch and no `try` can contain. It is read after verification now, and read as untrusted data.

A signature says who wrote a frame, never how many times they meant to send it, so `ReplayGuard` refuses a frame whose nonce has been seen or whose timestamp is outside `MaxClockSkew` (one minute by default). It runs *before* the signature check, which is the right order — the reverse lets anyone force an HMAC per packet — and the cost of that ordering is that anyone can put entries in it. So it is bounded by count (`MaxTrackedNonces`, 5000) as well as by age: everything inside the freshness window is by definition too young to expire, so an age-only rule bounds nothing at all and makes every later message walk the whole table.

**Only a request may name a reply address, and it must be inside this network's own prefix.** Neither guard is about forgery — `responseTopic` is inside the signature and a signed frame attests it faithfully — they are about authorisation. Without the first, any peer holding a key for its own name can publish a signed `event` carrying another exchange's correlation and a reply address of its choosing, and this peer will send that exchange's answer there. Without the second, the named address can be another peer's presence topic, where an answer body reads as a presence update and evicts them.

The canonical bytes are byte-identical with the TypeScript library's, and `packages/rpc/src/MqttSigningInterop.test.ts` compares them directly for the cases where JavaScript and System.Text.Json disagree — non-ASCII, `<`, `&`, `+`, control characters, surrogate pairs and lone surrogates. That test is not ceremony: it caught a matched surrogate pair being signed with its low half escaped, which would have produced frames that verify nowhere while looking like a key or clock problem.

## Subscriptions

`SubscribeAsync` returns a handle; disposing it stops that handler. Three properties are worth knowing because each was wrong once:

- **The handler is registered before the request goes out.** The far end may emit the instant it acknowledges, and an event that arrives while the client is still awaiting the acknowledgement would otherwise find nothing to deliver to.
- **Handlers are counted.** Two subscriptions to one event take one remote subscription, and only the last handler leaving tells the far end to stop. Telling it on every dispose meant two subscribers destroyed each other: dropping either one silenced the other, with nothing reported anywhere.
- **They are taken out again when the link comes back.** A peer's subscriptions live on its connection at the far end, so after a reconnect that end has never met this peer. A binding signals this through `ISourceRpcTransport.LinkEstablished`, which is raised on every connection rather than only the first.

## Upgrading to 5.0.0

The version is a major because the wire changed, not only the API: MQTT peers moved to frame version 3 under the `msgrpc/v2` topic prefix, and connection transports moved to the flat frame. Neither breaks a running network — a socket.io server serves both layouts from one listener, and the prefix change keeps the two MQTT populations apart by construction — but a peer on the old numbers does not talk to a peer on the new ones, and that is what a major is for.

Breaking changes in this package, in transport options and in the idempotency store rather than in anything an application calls:

- **`IRpcIdempotencyStore.BeginAsync`** returns `RpcIdempotencyClaim` — `Acquired`, `InProgress` or `Completed` — where it returned `RpcOutcome?`. A custom store must now distinguish a key it has claimed from one it has finished; that distinction is the fix. `AbandonAsync` is new and defaulted, so an existing store compiles without it.
- **`ISourceRpcTransport`** gains `LinkEstablished`. A custom transport must raise it on every connection, or a client over it will not restore its subscriptions after a reconnect.
- A call carrying an idempotency key is now refused with `IdempotencyUnavailable` where no store is registered. `SourceRpcOptions.AllowUnenforcedIdempotencyKeys` restores the old behaviour.
- **`MqttTransportOptions.Verify`** returns `string?` — the peer it proved the frame is from — where it returned `bool`. `MqttSigning.HmacVerifier` already does this; a hand-written verifier returns the source on success and `null` to refuse.
- A request's MQTT reply address must now be its own `rsp` topic. `MqttTransportOptions.AllowResponseTopic` permits another arrangement where one is genuinely needed.
- **`SocketIoTransportOptions.Path`** is now **`EnginePath`**, because it is engine.io's endpoint and never was the namespace.

Anything still on a `ProjectReference` into `packages/signalr/csharp/` is pointing at a directory that no longer exists — take the packages from the feed instead, as *Publishing to a local feed* above describes. `IRpcResponder.Invoke(path, method, frame)` became `ISourceRpcResponder.InvokeAsync(RpcInvocation, CancellationToken)` in the same move.

## What is not here yet

**Shared subscriptions** (`$share/<group>/…`), which is how MQTT replicas load-balance requests.

**A C# peer cannot be a bridge.** There is no `carrying`/`shape` advertisement here, so a .NET process joins a network as a leaf. Nothing depends on it today; it is the reason a C# node cannot sit between two segments.

**socket.io reads only the current frame layout.** The TypeScript client also listens for the older `$`-delimited `message` event, so a server that has not yet learned a peer's dialect can still reach it. A C# peer with `AnnouncePresence = false` that is pushed a frame before it has sent one gets nothing.

**`messageExpiryInterval` is not read on receive.** The TypeScript transport uses it to narrow a signed ttl, which is what makes "the broker may shorten a deadline, never extend it" true in both directions. Here a request that sat twenty-five seconds in the broker still runs with its full signed budget.

**`mr-method` and `mr-event` share one slot in the signed canonical form.** Both implementations collapse them, so relabelling a signed event as a method keeps the signature valid and the frame is then dropped for want of a handler. The effect is suppression, which a hostile broker can achieve by discarding the frame anyway — but it is a genuine slot collision, and fixing it is a change to both languages rather than to this package.

Method semantics are not declared, so the idempotency store is consulted whenever a call carries a key rather than only for methods marked non-repeatable — the caller sending a key is taken as the request. Introspection (`describe()`) is not implemented either.
