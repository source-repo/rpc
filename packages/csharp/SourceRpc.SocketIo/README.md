# SourceRpc.SocketIo

Source RPC over socket.io — a client.

For a .NET process that joins a network already being served by a TypeScript socket.io server: an engineering tool, an automation host, a console utility.

```csharp
await using var transport = new SocketIoClientTransport("http://plant:3000", options);
```

**Client only, and deliberately.** socket.io's server is a Node library with no maintained .NET equivalent. A .NET process that needs to be *dialled into* serves [`SourceRpc.SignalR`](https://www.nuget.org/packages/SourceRpc.SignalR) instead — the same flat frame under different method names, which is why a TypeScript client reaches either.

A socket.io namespace goes in the URL (`http://plant:3000/cell-3`); `EnginePath` is engine.io's endpoint and is rarely what you want.

Needs [`SourceRpc`](https://www.nuget.org/packages/SourceRpc), which comes with it. Documentation: [github.com/source-repo/rpc](https://github.com/source-repo/rpc/blob/main/packages/csharp/README.md).
