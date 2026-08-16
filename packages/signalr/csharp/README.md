# A Source RPC hub in C#

Reference implementation of the hub side of [`docs/flat-frame-spec.md`](../../../docs/flat-frame-spec.md), so a .NET process can be an ordinary peer on a Source RPC network.

> **Not compiled here.** These files were written against the specification, in a repository with no .NET SDK. The protocol they implement *is* verified — `packages/rpc/src/FlatFrame.test.ts` drives the same frames from a client with no library code — but the C# itself has not been through a compiler. Treat the first build as part of adopting it.

## Wiring

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();
builder.Services.AddSingleton<PeerTable>();
builder.Services.AddSingleton<IRpcResponder, AutomationSurface>();

var app = builder.Build();
app.MapHub<RpcHub>("/rpc");
app.Run();
```

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

## What this reference does not do

It serves methods, routes between connected peers, and answers errors. It does **not** implement subscribe/unsubscribe (an event registry), tickets (deferred answers), deadlines, idempotency, owner fences, or authorization. Each is described in the frame spec and each is worth adding where it earns its place; none is needed to serve a method.

Two are worth calling out because their absence is silent rather than obvious:

- **`fence`.** If you keep any record of who owns an instance, compare `frame.Fence` and answer `OwnershipChanged` on a difference — including when you hold no record at all, which fails closed. A fence is checked by being present, so ignoring one is not a weaker check but *no* check, and the caller cannot tell the difference from a successful call.
- **`src` is a claim.** `RpcHub.Presence` records whatever name a peer announces. If you authenticate connections, compare that name with `Context.User` and refuse a mismatch — otherwise any connected peer can announce itself as any other and be handed its traffic.
