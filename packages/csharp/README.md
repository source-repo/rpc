# Source RPC for .NET

A .NET process as a peer on a Source RPC network — serving methods, publishing events, and calling out to other peers. It speaks the flat frame described in [`docs/flat-frame-spec.md`](../../docs/flat-frame-spec.md), which is the same protocol the TypeScript library speaks.

## Two packages, and why

| package | what is in it | depends on |
| --- | --- | --- |
| **`SourceRpc`** | the frame, the dispatcher, the client, routing, the error model, telemetry | nothing but the BCL |
| **`SourceRpc.SignalR`** | a hub for a process others dial into, and a client transport for one that dials out | ASP.NET Core |

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
SourceRpc.SocketIo                   client only — see below
SourceRpc.Mqtt                       client
```

**Planned bindings.** SignalR gives both halves, because ASP.NET Core can host a hub. socket.io gives a **client only**: there is no reasonable C# socket.io *server*, and none is needed — the TypeScript side already serves socket.io, and a C# process joins it as a client. MQTT has no server to write at all, since the broker is the middle.

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

**Turn on container validation in your host.** A dependency cycle among these registrations produced a hub whose methods were silently never invoked — SignalR accepted the connection, the caller's `invoke` never returned, and nothing was logged. With validation on, the same mistake is a startup exception naming the cycle:

```csharp
builder.Host.UseDefaultServiceProvider(o => { o.ValidateOnBuild = true; o.ValidateScopes = true; });
```

## What is not here yet

Tickets (deferred answers), idempotency for non-repeatable commands, and enforcement of the owner fence — the fence *arrives*, as `call.Fence`, and comparing it against a record of who owns the instance is the responder's to do. Each is described in the frame spec, and each is worth adding where it earns its place.
