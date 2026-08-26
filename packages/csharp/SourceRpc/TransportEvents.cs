using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace SourceRpc;

/// <summary>
/// Event publishing over any transport, for a peer that is not a hub.
///
/// This used to live in the SignalR package, which meant a peer on a broker or a socket.io client
/// could serve methods but not announce anything - it had to write its own fan-out, and the test
/// host duly did. Nothing in it is SignalR's: it counts emissions, asks the dispatcher who is
/// subscribed, and addresses one frame per subscriber.
///
/// **A send that fails is isolated.** One unreachable subscriber must not stop the ones after it
/// receiving the event - and the loop that stopped at the first failure would deliver an alarm to
/// whoever happened to be earliest in the table and nobody else.
/// </summary>
public sealed class TransportEvents(ISourceRpcTransport transport, SourceRpcOptions options, ILogger? log = null) : ISourceRpcEvents
{
    private readonly ILogger _log = log ?? NullLogger.Instance;
    private readonly Dictionary<string, long> _sequences = [];
    private RpcDispatcher? _dispatcher;

    /// <inheritdoc/>
    public string Epoch { get; } = Guid.NewGuid().ToString("N")[..8];

    /// <summary>
    /// Tell this publisher which dispatcher holds the subscriptions.
    ///
    /// Bound afterwards rather than injected, and not by preference: the dispatcher needs the
    /// responder, the responder needs this, and this needs the dispatcher. A container asked to
    /// build that cycle produces a peer whose methods are silently never invoked, which is a whole
    /// afternoon to diagnose from the symptom.
    /// </summary>
    public void Bind(RpcDispatcher dispatcher) => _dispatcher = dispatcher;

    /// <inheritdoc/>
    public Task EmitAsync(string path, string eventName, params object?[] args) =>
        EmitAsync(path, eventName, args, CancellationToken.None);

    /// <inheritdoc/>
    public async Task EmitAsync(string path, string eventName, object?[] args, CancellationToken cancellationToken)
    {
        long seq;
        lock (_sequences)
        {
            // Counted whether or not anyone is listening. A subscriber that joins late wants to
            // know how many emissions went past while it was away, and a counter that only moved
            // when somebody was watching cannot tell it.
            var key = path + "\0" + eventName;
            seq = _sequences.TryGetValue(key, out var at) ? at + 1 : 1;
            _sequences[key] = seq;
        }

        foreach (var peer in _dispatcher?.SubscribersOf(path, eventName) ?? [])
        {
            try
            {
                await transport.SendAsync(
                    new RpcFrame
                    {
                        Src = options.Name,
                        Tgt = peer,
                        Kind = "event",
                        Path = path,
                        Event = eventName,
                        Seq = seq,
                        Epoch = Epoch,
                        Body = args
                    },
                    cancellationToken);
            }
            catch (Exception e)
            {
                // Isolated on purpose: one route that has gone must not stop the rest of the
                // subscribers hearing about it.
                _log.LogWarning(e, "SourceRpc could not deliver {Path}.{Event} to {Peer}", path, eventName, peer);
            }
        }
    }

    /// <inheritdoc/>
    public long SequenceOf(string path, string eventName)
    {
        lock (_sequences)
            return _sequences.TryGetValue(path + "\0" + eventName, out var at) ? at : 0;
    }
}
