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

// Slim rather than the full builder, and not for weight: the default one watches appsettings for
// changes, and on a machine that has spent its inotify instances - a workstation running a k8s
// cluster and a handful of containers will - that throws at startup before a single line of this
// hub runs. A test host has no configuration to reload.
var builder = WebApplication.CreateSlimBuilder(args);
// Warnings and above, on the console. Deliberately not ClearProviders(): with the log silenced, a
// hub that fails to deserialize a frame answers nothing and looks exactly like a hub that is
// ignoring you, which is how an afternoon goes. SignalR reports a binding failure at Debug and the
// exception behind it at Warning, so this is the level at which a broken frame says so.
builder.Logging.AddSimpleConsole();
builder.Logging.SetMinimumLevel(LogLevel.Warning);
// Both protocols on one hub, which is how SignalR is meant to be used: the client picks at
// negotiation with withHubProtocol, so the same process serves a JSON peer and a MessagePack one
// without knowing which is which. It is also what lets the interop suite exercise both.
builder.Services.AddSignalR().AddMessagePackProtocol();
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

    public async Task<object?> Invoke(string path, string method, RpcFrame frame)
    {
        if (path != "meter")
            throw new InvalidOperationException($"no instance named '{path}' here");

        switch (method)
        {
            case "read":
                return $"{frame.Arg<string>(0)}=42";
            case "pulse":
            {
                // Emitted from a method only because a test needs something to trigger it. In a real
                // host this is a build finishing or a file changing - something that happens on its
                // own, which is the case that made events worth carrying at all.
                var reading = frame.Arg<int>(0);
                await _events.Emit("meter", "tick", reading, "bar");
                return _events.SequenceOf("meter", "tick");
            }
            case "blow":
                throw new InvalidOperationException("the sensor is on fire");
            case "trace":
                // The one thing MessagePack carries that JSON cannot: bytes as bytes. Over the JSON
                // hub protocol this same array comes back base64-encoded in a string, which is the
                // difference the two protocols actually make to a caller.
                return new byte[] { 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x7F };
            case "echo":
                // Round-trips whatever it was given, so a test can assert that an argument survived
                // the journey out as well as the answer coming back.
                return frame.Arg<string>(0);
            default:
                throw new MissingMethodException($"meter has no method '{method}'");
        }
    }
}
