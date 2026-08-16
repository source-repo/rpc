# Source RPC for .NET

A .NET process as a peer on a Source RPC network — serving methods, publishing events, and calling out to other peers. It speaks the flat frame described in [`docs/flat-frame-spec.md`](../../docs/flat-frame-spec.md), which is the same protocol the TypeScript library speaks.

## Two packages, and why

| package | what is in it | depends on |
| --- | --- | --- |
| **`SourceRpc`** | the frame, the dispatcher, the client, routing, the error model, telemetry | nothing but the BCL |
| **`SourceRpc.SignalR`** | a hub for a process others dial into, and a client transport for one that dials out | ASP.NET Core |
| **`SourceRpc.Mqtt`** | a peer on a broker — no server to write, because the broker is the middle | MQTTnet |
| **`SourceRpc.SocketIo`** | a client for a .NET process that dials into a TypeScript socket.io server | SocketIOClient |

The split is the point. A SignalR hub needs ASP.NET Core; an MQTT client on a device does not, and should not carry a web framework to get a protocol. So everything that decides what a frame *means* lives in `SourceRpc`, and a binding is a small class that moves frames.

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

**Bump the version before re-pushing.** A folder feed will not replace an existing `<id>.<version>.nupkg`, and a consumer that has already restored `4.6.0` has it cached in `~/.nuget/packages` regardless — so republishing the same number is the one way to be sure everybody is looking at something different from what you built.

## Building and testing

```
npm run build:csharp     # the solution
npm run pack:csharp      # both NuGet packages, into packages/csharp/nupkg
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

The outcome is written *before* the caller is answered, because a crash between running and recording leaves a command that ran and can be run again — the record is the commit point, not the reply. A store that cannot be reached **refuses the command**: failing open would mean the one condition under which double execution is possible is also the one under which nothing is checking. `InMemoryIdempotencyStore` forgets on restart and says so; a host that dispenses or starts a pump wants something durable.

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

With `Verify` set, an unsigned frame is refused, so signing cannot be bypassed by omitting the signature. What the signature covers is everything a receiver *acts on*: the content type that decides how the payload is read, the error code, the ttl, the owner fence, the idempotency key, the deferred marker and the ticket outcome. `messageExpiryInterval` is deliberately excluded — the broker rewrites it in flight, and it may only narrow the signed ttl.

A signature says who wrote a frame, never how many times they meant to send it, so `ReplayGuard` refuses a frame whose nonce has been seen or whose timestamp is outside `MaxClockSkew` (one minute by default). Without it, a captured command can simply be sent again.

The canonical bytes are byte-identical with the TypeScript library's, and `packages/rpc/src/MqttSigningInterop.test.ts` compares them directly for the cases where JavaScript and System.Text.Json disagree — non-ASCII, `<`, `&`, `+`, control characters, surrogate pairs and lone surrogates. That test is not ceremony: it caught a matched surrogate pair being signed with its low half escaped, which would have produced frames that verify nowhere while looking like a key or clock problem.

## What is not here yet

**Shared subscriptions** (`$share/<group>/…`), which is how MQTT replicas load-balance requests.

Method semantics are not declared, so the idempotency store is consulted whenever a call carries a key rather than only for methods marked non-repeatable — the caller sending a key is taken as the request. Introspection (`describe()`) is not implemented either.
