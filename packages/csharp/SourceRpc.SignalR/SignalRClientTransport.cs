using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SourceRpc;

namespace SourceRpc.SignalR;

/// <summary>
/// A link to a SignalR hub, for a .NET process that dials out rather than being dialled into.
///
/// The whole of a binding, and deliberately small: start a connection, put frames on it, hand back
/// the ones that arrive. Correlation, deadlines, error mapping, subscriptions and dispatch are
/// <see cref="SourceRpcClient"/>'s and <see cref="RpcDispatcher"/>'s, so a socket.io or MQTT client
/// is this class again with a different three methods rather than the protocol written a second
/// time - which is how three transports come to disagree about what a timeout means.
///
/// Mirrors the TypeScript `SignalRClientTransport` frame for frame, because it is the same
/// specification: `frame` and `presence` as hub methods, the flat frame as an object rather than
/// bytes, and the hub protocol chosen rather than the encoding done here.
/// </summary>
public sealed class SignalRClientTransport : ISourceRpcTransport
{
    private readonly SourceRpcOptions _options;
    private readonly Func<HubConnection> _build;
    private readonly ILogger _log;
    private HubConnection? _connection;

    /// <summary>Who the hub says is reachable, kept so a single change can be applied to it.</summary>
    private readonly SortedSet<string> _peers = new(StringComparer.Ordinal);
    private CancellationTokenSource? _closing;

    /// <inheritdoc/>
    public string Name => _options.Name;

    /// <inheritdoc/>
    public bool Connected => _connection?.State == HubConnectionState.Connected;

    /// <inheritdoc/>
    public event Func<RpcFrame, Task>? FrameReceived;

    /// <inheritdoc/>
    public event Action<IReadOnlyCollection<string>>? PeersChanged;

    /// <inheritdoc/>
    public event Func<Task>? LinkEstablished;

    /// <summary>Connect to a hub at a URL.</summary>
    public SignalRClientTransport(string url, SourceRpcOptions options, ILogger? log = null)
        : this(options, () => Build(url, options), log)
    {
    }

    /// <summary>
    /// Connect with a connection built by the caller, for anything the URL form cannot express -
    /// an access token factory, a custom retry policy, a hub protocol of your own.
    ///
    /// Whatever this returns has its handlers registered and is started here, so it should not be
    /// started by the builder.
    /// </summary>
    public SignalRClientTransport(SourceRpcOptions options, Func<HubConnection> build, ILogger? log = null)
    {
        _options = options;
        _build = build;
        _log = log ?? NullLogger.Instance;
    }

    private static HubConnection Build(string url, SourceRpcOptions options)
    {
        var builder = new HubConnectionBuilder().WithUrl(url);
        // The one place the protocol choice is made. MessagePack carries a byte array as bytes
        // where JSON base64s it, and costs a client nothing because the two are negotiated.
        if (options.UseMessagePack)
            builder = builder.AddMessagePackProtocol();
        return builder.Build();
    }

    /// <inheritdoc/>
    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_connection is not null)
            return;
        _closing = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var connection = _build();
        _connection = connection;

        // Started, not awaited, which is the same rule the socket.io and MQTT bindings follow and
        // for the same reason: a receive loop that waits for the responder cannot deliver anything
        // while it runs, so a responder that calls out mid-invocation waits for a reply that cannot
        // arrive until it stops waiting. It resolves as a timeout on the outer call, which reads as
        // a slow method rather than as the transport - the two other bindings each had it, and each
        // was found only by a test that called back the other way.
        connection.On<RpcFrame>(TransportContract.FrameName, frame => _ = DispatchAsync(frame));
        connection.On<PresenceUpdate>(TransportContract.PresenceName, update =>
        {
            // Two shapes, and reading only the first is a peer list that freezes: the hub sends the
            // full set once in answer to an announcement, then a single `{peer, state}` for every
            // change after that (see RpcHub). Handling only the snapshot shows whoever happened to
            // be online at the instant this peer connected - for ever.
            string[] snapshot;
            lock (_peers)
            {
                if (update.Peers is { } peers)
                {
                    _peers.Clear();
                    foreach (var peer in peers)
                        if (peer != _options.Name)
                            _peers.Add(peer);
                }
                else if (update.Peer is { Length: > 0 } peer && peer != _options.Name)
                {
                    // Both states named, so an unrecognised word is ignored rather than read as gone.
                    if (update.State == "online")
                        _peers.Add(peer);
                    else if (update.State == "offline")
                        _peers.Remove(peer);
                    else
                        return;
                }
                else
                {
                    return;
                }
                snapshot = [.. _peers];
            }
            try
            {
                PeersChanged?.Invoke(snapshot);
            }
            catch (Exception e)
            {
                // An application handler that throws must not unwind into SignalR's dispatch.
                _log.LogError(e, "SourceRpc peer-list handler threw");
            }
        });

        connection.Closed += async error =>
        {
            _log.LogWarning(error, "SourceRpc link to the hub closed");
            // SignalR's own automatic reconnect is not configured here, because it does not cover a
            // failed initial start() and this loop has to exist for that anyway. One mechanism that
            // handles both is simpler to describe than two that each handle half.
            await ReconnectAsync();
        };

        await ConnectAsync();
    }

    /// <summary>
    /// Connect, and keep trying.
    ///
    /// Never throws: a failure schedules the next attempt instead, so a peer that came up before its
    /// hub is simply not connected yet rather than permanently broken. A send meanwhile throws
    /// rather than being discarded, which is what tells a caller now instead of at its deadline.
    /// </summary>
    private async Task ConnectAsync(int attempt = 0)
    {
        var connection = _connection;
        if (connection is null || _closing?.IsCancellationRequested != false)
            return;
        try
        {
            await connection.StartAsync(_closing!.Token);
            // Announced on every connection, not only the first: SignalR gives the hub a new
            // connection id, so as far as the hub is concerned this is a peer it has never met.
            await connection.SendAsync(
                TransportContract.PresenceName,
                new PresenceAnnouncement { Name = _options.Name, V = TransportContract.FrameVersion },
                _closing.Token);
            _log.LogInformation("SourceRpc connected to the hub as {Peer}", _options.Name);
            await Established();
        }
        catch (Exception e) when (_closing?.IsCancellationRequested == false)
        {
            var delay = _options.ReconnectDelaysMs[Math.Min(attempt, _options.ReconnectDelaysMs.Length - 1)];
            _log.LogWarning(e, "SourceRpc could not reach the hub; retrying in {Delay}ms", delay);
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(delay, _closing!.Token);
                    await ConnectAsync(attempt + 1);
                }
                catch (OperationCanceledException)
                {
                    // Closed while waiting, which is the ordinary way this loop ends.
                }
            });
        }
    }

    private async Task DispatchAsync(RpcFrame frame)
    {
        var handler = FrameReceived;
        if (handler is null)
            return;
        try
        {
            await handler(frame);
        }
        catch (Exception e)
        {
            // One unreadable frame from the far end must not take this peer down.
            _log.LogError(e, "SourceRpc failed to handle an inbound frame");
        }
    }

    /// <summary>
    /// Tell whoever is above that the link is up, without letting them break it.
    ///
    /// Raised on every connection, not only the first: the hub gives a reconnected peer a new
    /// connection id and has forgotten everything it knew, including that peer's subscriptions.
    /// </summary>
    private async Task Established()
    {
        if (LinkEstablished is not { } handler)
            return;
        try
        {
            await handler();
        }
        catch (Exception e)
        {
            _log.LogError(e, "SourceRpc failed to restore state after the link came up");
        }
    }

    private Task ReconnectAsync() => _closing?.IsCancellationRequested == false ? ConnectAsync() : Task.CompletedTask;

    /// <inheritdoc/>
    public async Task SendAsync(RpcFrame frame, CancellationToken cancellationToken = default)
    {
        var connection = _connection;
        if (connection is null || connection.State != HubConnectionState.Connected)
            // Thrown rather than dropped: a frame discarded in silence leaves its caller waiting out
            // the whole deadline for something that was never going to be sent.
            throw new SourceRpcException(RpcErrorCode.TransportError, "not connected to the hub");
        // As a frame rather than as bytes. SignalR has a serialization layer and typed hub methods,
        // so handing it a blob would mean the hub receives byte[] and decodes it by hand.
        await connection.SendAsync(TransportContract.FrameName, frame, cancellationToken);
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        // Idempotent, because a transport is ordinarily disposed twice: SourceRpcClient owns it and
        // disposes it, and the caller's `await using` on the transport does so again. A second
        // Cancel() on a disposed source throws, which turned a clean shutdown into a crash after
        // everything had already worked.
        var closing = Interlocked.Exchange(ref _closing, null);
        var connection = Interlocked.Exchange(ref _connection, null);
        if (closing is not null)
        {
            await closing.CancelAsync();
            closing.Dispose();
        }
        if (connection is not null)
            await connection.DisposeAsync();
    }
}
