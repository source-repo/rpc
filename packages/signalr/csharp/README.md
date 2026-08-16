# A Source RPC hub in C#

Reference implementation of the hub side of [`docs/flat-frame-spec.md`](../../../docs/flat-frame-spec.md), so a .NET process can be an ordinary peer on a Source RPC network.

**Compiled, run, and driven by the TypeScript suite.** `testhost/` is a minimal ASP.NET Core app hosting this hub, and `src/Interop.test.ts` points a real `RpcClient` at it — calls, thrown exceptions, subscriptions, unsubscribe, and the event cursor. Build and start it with `npm run hub --workspace=@source-repo/signalr`, then:

```
SOURCE_RPC_TEST_SIGNALR_HUB=http://127.0.0.1:5217/rpc \
SOURCE_RPC_REQUIRE_SIGNALR=1 npm test --workspace=@source-repo/signalr
```

## Wiring

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();
builder.Services.AddSingleton(new RpcPeer("vs-automation"));   // this process's name on the network
builder.Services.AddSingleton<PeerTable>();
builder.Services.AddSingleton<SubscriptionTable>();
builder.Services.AddSingleton<RpcEvents>();
builder.Services.AddSingleton<IRpcResponder, AutomationSurface>();

var app = builder.Build();
app.MapHub<RpcHub>("/rpc");
app.Run();
```

`RpcPeer` is a singleton of its own rather than a property of the responder, and that is not fussiness: `RpcEvents` needs the name to address the frames it sends, and whatever emits events needs `RpcEvents` — so a name owned by the responder makes the two require each other and the container refuses to build either.

## A responder

`IRpcResponder` is the whole surface. `path` is the instance name a caller addressed, `method` is the method on it, and `args` is the argument array:

```csharp
public sealed class AutomationSurface : IRpcResponder
{
    private readonly DTE2 _dte;
    public AutomationSurface(DTE2 dte) => _dte = dte;

    public string Name => "vs-automation";

    public Task<object?> Invoke(string path, string method, JsonElement? args, RpcFrame frame)
    {
        if (path != "solution")
            throw new InvalidOperationException($"no instance named '{path}' here");

        return Task.FromResult<object?>(method switch
        {
            "fullName"  => _dte.Solution.FullName,
            "isOpen"    => _dte.Solution.IsOpen,
            "open"      => Open(args!.Value[0].GetString()!),
            "build"     => Build(),
            _ => throw new MissingMethodException($"solution has no method '{method}'")
        });
    }
}
```

On the TypeScript side that is:

```ts
const solution = await client.proxy<{ fullName(): Promise<string>; open(path: string): Promise<void> }>('solution')
await solution.open('C:\\src\\Plant.sln')
```

## Serialization

**Start with the JSON hub protocol**, which is what `RpcFrame.cs` is annotated for. The frame's field names are fixed by the specification and pinned with `[JsonPropertyName]` rather than left to a naming policy, so a serializer setting changed later cannot quietly rename half a protocol. On the client, that means `useMsgPack: false`:

```ts
new RpcClient(undefined, {
    name: 'hmi',
    defaultTarget: 'vs-automation',
    useMsgPack: false,
    transport: new SignalRClientTransport('hmi', 'http://localhost:5217/rpc')
})
```

MessagePack works too and is smaller, and it is the only one that carries binary inside `body` as binary rather than base64 — but it needs `AddMessagePackProtocol()` on the hub and a resolver that keys by property name, so it is the second thing to get working rather than the first.

## Events

`RpcEvents.Emit` is how this process tells the network something happened. Inject it and call it:

```csharp
public sealed class BuildWatcher(RpcEvents events)
{
    private void OnBuildFinished(bool succeeded) => _ = events.Emit("solution", "built", succeeded);
}
```

A TypeScript peer receives that as an ordinary subscription:

```ts
const solution = await client.proxy<{ on(e: string, h: (ok: boolean) => void): Promise<unknown> }>('solution')
await solution.on('built', (ok) => console.log('build finished', ok))
```

Three things about it are worth knowing, because each is a decision rather than an accident:

- **The count runs whether or not anyone is subscribed.** That is what `seq` is for — a subscriber that joins late wants to know how many went past while it was away, and a counter that stood still cannot tell it. `epoch` is regenerated per process, so a restart is visibly a restart rather than a suspiciously small number.
- **A repeated subscribe is one subscription**, answered `ok - already exists`. A client replaying its subscriptions after a reconnect is doing the right thing and must not end up served twice.
- **A subscription is keyed by peer name, not connection id**, so a peer that reconnects keeps receiving. Its subscriptions are dropped when it disconnects, since nothing else will ever drop them.

## What this reference does not do

It serves methods, publishes events, routes between connected peers, and answers errors. It does **not** implement tickets (deferred answers), deadlines, idempotency, owner fences, or authorization. Each is described in the frame spec and each is worth adding where it earns its place; none is needed to serve a method or push an event.

Two are worth calling out because their absence is silent rather than obvious:

- **`fence`.** If you keep any record of who owns an instance, compare `frame.Fence` and answer `OwnershipChanged` on a difference — including when you hold no record at all, which fails closed. A fence is checked by being present, so ignoring one is not a weaker check but *no* check, and the caller cannot tell the difference from a successful call.
- **`src` is a claim.** `RpcHub.Presence` records whatever name a peer announces. If you authenticate connections, compare that name with `Context.User` and refuse a mismatch — otherwise any connected peer can announce itself as any other and be handed its traffic.
