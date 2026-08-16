using SourceRpc;
using SourceRpc.SignalR;

/*
 * The smallest hub the TypeScript interop suite can be pointed at - and, incidentally, the whole of
 * what an application has to write.
 *
 * Everything below the two registrations is this test's own surface. There is no peer table, no
 * subscription table, no hub type and no frame: those are the library's, they have changed three
 * times already, and an application that had registered them by hand would have been broken by all
 * three.
 *
 *   npm run hub --workspace=@source-repo/signalr
 *
 * Pass `client <hubUrl> <peer>` instead and it runs as a *client* of another hub, which is the
 * smoke test for the C# client half.
 */

if (args.Length > 0 && args[0] == "client")
{
    await RunAsClient(args.Length > 1 ? args[1] : "http://127.0.0.1:5217/rpc", args.Length > 2 ? args[2] : "vs-automation");
    return;
}

var builder = WebApplication.CreateSlimBuilder(args);

// Validated at build rather than discovered in use, and this is not belt-and-braces: a dependency
// cycle among the registrations below produced a hub whose methods were silently never invoked -
// SignalR accepted the connection, the caller's invoke never returned, and nothing was logged. With
// this on, the same mistake is a startup exception naming the cycle.
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateOnBuild = true;
    options.ValidateScopes = true;
});

// Warnings and above, on the console. Deliberately not ClearProviders(): with the log silenced, a
// hub that fails to deserialize a frame answers nothing and looks exactly like a hub that is
// ignoring you, which is how an afternoon goes.
builder.Logging.AddSimpleConsole();
// Turn it up with RPC_LOG_LEVEL=Debug when a frame goes missing: SignalR reports an argument
// binding failure there, and a hub that cannot bind a frame answers nothing and looks exactly like
// one that is ignoring you.
builder.Logging.SetMinimumLevel(
    Enum.TryParse<LogLevel>(Environment.GetEnvironmentVariable("RPC_LOG_LEVEL"), out var level) ? level : LogLevel.Warning);

builder.Services
    .AddSourceRpc(options =>
    {
        options.Name = Environment.GetEnvironmentVariable("RPC_PEER_NAME") ?? "vs-automation";
        // The interop suite asserts that an unhandled exception's message reaches the caller, so
        // this host opts in. A plant service should not: see the option's own documentation.
        options.IncludeExceptionDetail = true;
    })
    .AddResponder<Meter>();

var app = builder.Build();
app.MapSourceRpc("/rpc");
// Printed on stdout so whatever started this process can wait for the port rather than sleeping.
app.Lifetime.ApplicationStarted.Register(() => Console.WriteLine("RPC-HUB-READY"));
app.Run();

/// <summary>
/// The C# client half, against a hub started separately.
///
/// Here because it is the only thing that proves the transport seam: the same dispatcher, client and
/// frame that serve the hub above are driven from the other end of a link, over a binding that is
/// three methods long. A socket.io or MQTT client is that binding again, and nothing else.
/// </summary>
static async Task RunAsClient(string url, string target)
{
    var options = new SourceRpcOptions { Name = $"csharp-client-{Environment.ProcessId}", CallTimeout = TimeSpan.FromSeconds(10) };
    var telemetry = new SourceRpcTelemetry();
    await using var transport = new SignalRClientTransport(url, options);
    await using var client = new SourceRpcClient(transport, options, telemetry);

    await client.StartAsync();
    // The link comes up asynchronously and keeps trying, so a client that has just started may not
    // be connected yet - which is the ordinary case rather than an error.
    for (var waited = 0; !transport.Connected && waited < 100; waited++)
        await Task.Delay(100);

    var read = await client.CallAsync<string>(target, "meter", "read", ["flow"]);
    Console.WriteLine($"CALL: {read}");

    var ticks = new List<string>();
    await using (await client.SubscribeAsync(target, "meter", "tick", args => ticks.Add(string.Join(",", args))))
    {
        await client.CallAsync<long>(target, "meter", "pulse", [7]);
        for (var waited = 0; ticks.Count == 0 && waited < 50; waited++)
            await Task.Delay(100);
        Console.WriteLine($"EVENT: {(ticks.Count > 0 ? ticks[0] : "<none>")}");
    }

    try
    {
        await client.CallAsync<string>(target, "meter", "refuse");
        Console.WriteLine("REFUSAL: none, which is wrong");
    }
    catch (SourceRpcException e)
    {
        // The code survives the round trip, which is what lets a caller tell a refusal from a crash.
        Console.WriteLine($"REFUSAL: {e.Code} {e.Message}");
    }

    Console.WriteLine("CLIENT-OK");
}

/// <summary>The whole exposed surface: one instance, a few methods, one event.</summary>
internal sealed class Meter : ISourceRpcResponder
{
    private readonly ISourceRpcEvents _events;

    // Constructed by the container, so it can take whatever it needs - here the event publisher, in
    // a real host a PLC client and a logger beside it.
    public Meter(ISourceRpcEvents events) => _events = events;

    public async ValueTask<object?> InvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default)
    {
        if (invocation.Path != "meter")
            throw SourceRpcException.NotFound(invocation.Path);

        switch (invocation.Method)
        {
            case "read":
                return $"{invocation.Arg<string>(0)}=42";

            case "pulse":
                // Emitted from a method only because a test needs something to trigger it. In a real
                // host this is a build finishing or a file changing - something that happens on its
                // own, which is the case that made events worth carrying at all.
                await _events.EmitAsync("meter", "tick", invocation.Arg<int>(0), "bar");
                return _events.SequenceOf("meter", "tick");

            case "blow":
                // An exception nobody planned for. Its message reaches the caller here only because
                // this host set IncludeExceptionDetail.
                throw new InvalidOperationException("the sensor is on fire");

            case "refuse":
                // An error somebody meant, with the code a caller should act on. This message always
                // travels, because it was written to be read.
                throw SourceRpcException.Forbidden("this meter does not take orders from you");

            case "trace":
                // The one thing MessagePack carries that JSON cannot: bytes as bytes. Over JSON the
                // same array comes back base64-encoded in a string.
                return new byte[] { 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x7F };

            case "echo":
                return invocation.Arg<string>(0);

            case "whoami":
                // Proves the invocation carries a checked source rather than the frame's own claim.
                return invocation.Source;

            default:
                throw SourceRpcException.NoSuchMethod(invocation.Path, invocation.Method);
        }
    }
}
