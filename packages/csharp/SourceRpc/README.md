# SourceRpc

The protocol, with no transport in it.

A .NET process joins a Source RPC network as an ordinary peer: it serves methods, publishes events and calls other peers, over whichever carrier suits it. This package is everything that decides what a frame *means* — the frame, the dispatcher, the client, routing, the error model, telemetry, and the command semantics a plant needs: deadlines, owner fences, idempotency and deferred answers.

**It takes no web framework and no transport.** A SignalR hub needs ASP.NET Core; an MQTT peer on a device does not, and should not carry a web stack to get a protocol. Add the binding that matches how the connection is opened:

| package | for |
| --- | --- |
| **`SourceRpc.SignalR`** | a hub other processes dial into, and a client that dials out |
| **`SourceRpc.Mqtt`** | a peer on a broker, speaking a layout a plain MQTT client can read |
| **`SourceRpc.SocketIo`** | a client dialling a TypeScript socket.io server |

```csharp
builder.Services
    .AddSourceRpc(options => options.Name = "line-controller")
    .AddResponder<AutomationSurface>();
```

Full documentation, including the wire formats and what each safety semantic guarantees: [github.com/source-repo/rpc](https://github.com/source-repo/rpc/blob/main/packages/csharp/README.md).
