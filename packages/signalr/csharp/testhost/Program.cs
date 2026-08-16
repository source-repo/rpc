using System.Text.Json;
using SourceRpc.SignalR;

/*
 * The smallest hub that the TypeScript interop suite can be pointed at.
 *
 * It exists so `Interop.test.ts` has something real to talk to: a specification nobody has run is a
 * specification with unknown errors in it, and the errors that matter here are the ones no
 * TypeScript test can reach - serialization casing, how `body` arrives, whether a reply correlates.
 *
 *   dotnet run --project csharp/testhost -- --urls http://127.0.0.1:5217
 *
 * The surface is fixed by what the interop tests expect: a `meter` with `read(tag)` answering
 * "<tag>=42", a `pulse()` that emits so a subscription has something to receive, and a `blow()`
 * that throws so a failure has a path to travel.
 */

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Services.AddSignalR();
builder.Services.AddSingleton(new RpcPeer(Environment.GetEnvironmentVariable("RPC_PEER_NAME") ?? "vs-automation"));
builder.Services.AddSingleton<PeerTable>();
builder.Services.AddSingleton<SubscriptionTable>();
builder.Services.AddSingleton<RpcEvents>();
builder.Services.AddSingleton<IRpcResponder, Meter>();

var app = builder.Build();
app.MapHub<RpcHub>("/rpc");
// Printed on stdout so whatever started this process can wait for the port rather than sleeping.
app.Lifetime.ApplicationStarted.Register(() => Console.WriteLine("RPC-HUB-READY"));
app.Run();

/// <summary>The whole exposed surface: one instance, three methods, one event.</summary>
internal sealed class Meter : IRpcResponder
{
    private readonly RpcEvents _events;

    public Meter(RpcEvents events) => _events = events;

    public async Task<object?> Invoke(string path, string method, JsonElement? args, RpcFrame frame)
    {
        if (path != "meter")
            throw new InvalidOperationException($"no instance named '{path}' here");

        switch (method)
        {
            case "read":
            {
                var tag = args is { ValueKind: JsonValueKind.Array } list && list.GetArrayLength() > 0 ? list[0].GetString() : null;
                return $"{tag}=42";
            }
            case "pulse":
            {
                // Emitted from a method only because a test needs something to trigger it. In a real
                // host this is a build finishing or a file changing - something that happens on its
                // own, which is the case that made events worth carrying at all.
                var reading = args is { ValueKind: JsonValueKind.Array } list && list.GetArrayLength() > 0 ? list[0].GetInt32() : 0;
                await _events.Emit("meter", "tick", reading, "bar");
                return _events.SequenceOf("meter", "tick");
            }
            case "blow":
                throw new InvalidOperationException("the sensor is on fire");
            default:
                throw new MissingMethodException($"meter has no method '{method}'");
        }
    }
}
