using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

using SourceRpc;

namespace SourceRpc.SignalR;


internal sealed class SourceRpcEvents : ISourceRpcEvents
{
    private readonly IHubContext<RpcHub> _hub;
    private readonly SubscriptionTable _subscriptions;
    private readonly RpcRouter _peers;
    private readonly SourceRpcOptions _options;
    private readonly SourceRpcTelemetry _telemetry;
    private readonly ILogger<SourceRpcEvents> _log;
    private readonly ConcurrentDictionary<string, long> _sequences = new();

    /// <summary>
    /// Regenerated per process, which is the point. Persisting it would be worse than useless: it
    /// would claim continuity across a restart that reset the counters.
    /// </summary>
    public string Epoch { get; } = Guid.NewGuid().ToString("N").Substring(0, 8);

    public SourceRpcEvents(
        IHubContext<RpcHub> hub,
        SubscriptionTable subscriptions,
        RpcRouter peers,
        IOptions<SourceRpcOptions> options,
        SourceRpcTelemetry telemetry,
        ILogger<SourceRpcEvents> log)
    {
        _hub = hub;
        _subscriptions = subscriptions;
        _peers = peers;
        _options = options.Value;
        _telemetry = telemetry;
        _log = log;
    }

    public Task EmitAsync(string path, string eventName, params object?[] args) => EmitAsync(path, eventName, args, CancellationToken.None);

    public async Task EmitAsync(string path, string eventName, object?[] args, CancellationToken cancellationToken)
    {
        // NUL joins the two halves of the key because it cannot occur in an instance name or an
        // event name, so no choice of one can be made to collide with a different pair. Written as
        // the escape and never as the byte: a literal NUL makes this file binary to everything that
        // sniffs content, and the first thing that costs is grep, which matches and prints nothing.
        var seq = _sequences.AddOrUpdate(path + "\0" + eventName, 1, (_, previous) => previous + 1);

        foreach (var peer in _subscriptions.SubscribersOf(path, eventName))
        {
            var connection = _peers.ConnectionFor(peer);
            // Subscribed but not currently reachable. Dropped rather than queued: this hub is not a
            // broker, and an event held for a peer that may never return is a leak wearing a
            // delivery guarantee nobody promised. The sequence is how the peer learns what it
            // missed when it comes back.
            if (connection is null)
                continue;

            var frame = new RpcFrame
            {
                Src = _options.Name,
                Tgt = peer,
                Kind = "event",
                Path = path,
                Event = eventName,
                Seq = seq,
                Epoch = Epoch,
                Body = args
            };
            await _hub.Clients.Client(connection).SendAsync("frame", frame, cancellationToken);
            _telemetry.FrameSent("event");
        }

        // The event and where it went, never what it carried: an emission's arguments are plant
        // data and a log is not the place for them.
        _log.LogDebug("SourceRpc event {Path}.{Event} seq {Seq}", path, eventName, seq);
    }

    public long SequenceOf(string path, string eventName) => _sequences.TryGetValue(path + "\0" + eventName, out var seq) ? seq : 0;
}
