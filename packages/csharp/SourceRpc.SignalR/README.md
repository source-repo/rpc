# SourceRpc.SignalR

Source RPC over ASP.NET Core SignalR — both halves of it.

This is the binding for a .NET process that other peers **dial into**. It hosts the hub, and it also carries a client transport for dialling another hub, so one process can serve and call over the same protocol.

```csharp
builder.Services
    .AddSourceRpc(options => options.Name = "vs-automation")
    .AddResponder<AutomationSurface>();

var app = builder.Build();
app.MapSourceRpc("/rpc");
```

A TypeScript peer reaches it with `@source-repo/signalr`; both speak the same flat frame, so a call means the same thing on either side and only the spelling differs.

Needs [`SourceRpc`](https://www.nuget.org/packages/SourceRpc), which comes with it. Documentation: [github.com/source-repo/rpc](https://github.com/source-repo/rpc/blob/main/packages/csharp/README.md).
