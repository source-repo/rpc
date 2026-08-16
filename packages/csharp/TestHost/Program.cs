using SourceRpc;
using SourceRpc.SignalR;
using SourceRpc.Mqtt;

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

if (args.Length > 0 && args[0] == "mqtt")
{
    await RunOnBroker(args.Length > 1 ? args[1] : "mqtt://127.0.0.1:1883", args.Length > 2 ? args[2] : "msgrpc/v2");
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
    .AddResponder<Meter>()
    // A fixed owner for the interop suite to fence against, and an in-memory store so a repeated
    // idempotency key is answered from the record rather than run twice.
    .AddOwnership<FixedOwner>()
    .AddIdempotencyStore<InMemoryIdempotencyStore>();

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

    // The race: a deferred method whose answer arrives before the caller has its ticket.
    var instant = await client.CallDeferredAsync<string>(target, "meter", "instant");
    var settled = await Task.WhenAny(instant.Result, Task.Delay(TimeSpan.FromSeconds(5)));
    Console.WriteLine(settled == instant.Result ? $"INSTANT: {await instant.Result}" : "INSTANT: LOST - the answer never arrived");

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

/// <summary>
/// The same surface, served on a broker instead.
///
/// The point of it is how little differs: the responder, the dispatcher and every semantic below
/// them are the ones the hub uses, and what changes is the class that moves frames. That is the
/// transport seam doing its job - and this is the first binding to prove it, because it shares no
/// wire format with the other one at all.
/// </summary>
static async Task RunOnBroker(string brokerUrl, string prefix)
{
    var options = new SourceRpcOptions { Name = Environment.GetEnvironmentVariable("RPC_PEER_NAME") ?? "csharp-mqtt", IncludeExceptionDetail = true };
    var telemetry = new SourceRpcTelemetry();
    var events = new BrokerEvents();
    var dispatcher = new RpcDispatcher(options, new SubscriptionTable(), telemetry, new Meter(events), null, new FixedOwner(), new InMemoryIdempotencyStore());
    await using var transport = new MqttTransport(new MqttTransportOptions { BrokerUrl = brokerUrl, Prefix = prefix }, options);
    await using var client = new SourceRpcClient(transport, options, telemetry, dispatcher);
    // Bound after the dispatcher exists rather than injected into it. The publisher needs to know
    // who is subscribed and the dispatcher needs the responder that publishes - a cycle a container
    // cannot build, and the one that produced a hub whose methods were never invoked.
    events.Bind(transport, options.Name, dispatcher);

    await client.StartAsync();
    for (var waited = 0; !transport.Connected && waited < 100; waited++)
        await Task.Delay(100);
    Console.WriteLine(transport.Connected ? "RPC-MQTT-READY" : "RPC-MQTT-FAILED");

    // Serves until it is stopped, which is what a peer on a broker does.
    await Task.Delay(Timeout.Infinite);
}

/// <summary>
/// Event publishing over a transport rather than a hub.
///
/// Deliberately small and deliberately here rather than in the library: fanning an event out to
/// subscribers needs the subscription table and a way to send, and on a broker "a way to send" is
/// the transport itself. A binding-independent publisher is the obvious next thing to lift into the
/// core, and it is not lifted yet because one implementation is not a pattern.
/// </summary>
internal sealed class BrokerEvents : ISourceRpcEvents
{
    private ISourceRpcTransport? _transport;
    private string _self = "";
    private readonly Dictionary<string, long> _sequences = [];

    public string Epoch { get; } = Guid.NewGuid().ToString("N")[..8];

    private RpcDispatcher? _dispatcher;

    public void Bind(ISourceRpcTransport transport, string self, RpcDispatcher dispatcher)
    {
        _transport = transport;
        _self = self;
        _dispatcher = dispatcher;
    }

    public Task EmitAsync(string path, string eventName, params object?[] args) => EmitAsync(path, eventName, args, CancellationToken.None);

    public async Task EmitAsync(string path, string eventName, object?[] args, CancellationToken cancellationToken)
    {
        long seq;
        lock (_sequences)
        {
            var key = path + "\0" + eventName;
            seq = _sequences.TryGetValue(key, out var at) ? at + 1 : 1;
            _sequences[key] = seq;
        }
        if (_transport is null)
            return;
        // On a broker an event goes to the subscriber's own evt topic, so each subscriber is
        // addressed rather than the event being broadcast to whoever happens to be listening.
        foreach (var peer in _dispatcher?.SubscribersOf(path, eventName) ?? [])
            await _transport.SendAsync(
                new RpcFrame { Src = _self, Tgt = peer, Kind = "event", Path = path, Event = eventName, Seq = seq, Epoch = Epoch, Body = args },
                cancellationToken);
    }

    public long SequenceOf(string path, string eventName)
    {
        lock (_sequences)
            return _sequences.TryGetValue(path + "\0" + eventName, out var seq) ? seq : 0;
    }
}

/// <summary>
/// A fixed owner generation, standing in for a real topology record.
///
/// The interop suite fences against `e-owner` and expects `e-stale` to be refused. A real host reads
/// this from wherever ownership is actually recorded - and answering null for an instance it does
/// not know is correct rather than lazy, because a fence that cannot be checked must fail closed.
/// </summary>
internal sealed class FixedOwner : IRpcOwnership
{
    public string? OwnerEpochOf(string path) => path == "meter" ? "e-owner" : null;
}

/// <summary>The whole exposed surface: one instance, a few methods, one event.</summary>
internal sealed class Meter : ISourceRpcResponder
{
    private readonly ISourceRpcEvents _events;

    // Constructed by the container, so it can take whatever it needs - here the event publisher, in
    // a real host a PLC client and a logger beside it.
    public Meter(ISourceRpcEvents events) => _events = events;

    private int _ran;

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

            case "slow":
            {
                // Answers later. The caller is told so at once and gets the answer when the work
                // finishes, with progress on the way.
                var deferred = invocation.Defer<string>();
                _ = Task.Run(async () =>
                {
                    await Task.Delay(50);
                    await deferred.ProgressAsync(50);
                    await Task.Delay(50);
                    await deferred.ResolveAsync($"finished {invocation.Arg<string>(0)}");
                });
                return deferred.Receipt;
            }

            case "instant":
            {
                // Answers before it has finished saying it will answer later. The progress and the
                // outcome are sent from inside the method, so both ticket frames leave *before* the
                // receipt the dispatcher sends when this returns - the worst ordering a client can
                // be handed, and a legitimate one for work that turns out to be already done.
                var deferred = invocation.Defer<string>();
                await deferred.ProgressAsync(1);
                await deferred.ResolveAsync("instantly");
                return deferred.Receipt;
            }

            case "count":
                // Counts every time it actually runs, so a caller can tell an answer that came from
                // the idempotency record from one that ran the method again.
                return Interlocked.Increment(ref _ran);

            case "whoami":
                // Proves the invocation carries a checked source rather than the frame's own claim.
                return invocation.Source;

            default:
                throw SourceRpcException.NoSuchMethod(invocation.Path, invocation.Method);
        }
    }
}
