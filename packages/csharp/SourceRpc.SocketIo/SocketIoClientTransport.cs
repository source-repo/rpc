using System.Text;
using System.Text.Json;
using MessagePack;
using MessagePack.Resolvers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SocketIOClient;

namespace SourceRpc.SocketIo;

/// <summary>
/// How a flat frame is encoded before it becomes a socket.io event payload.
///
/// The choice is not socket.io's - socket.io carries whatever it is given and would happily carry
/// the frame as a plain object. It exists because the TypeScript side runs a codec over the event
/// payload either way, so what travels is always bytes and the codec decides what is inside them.
/// Both ends must have made the same choice, and neither can tell from the wire which the other
/// made: an unreadable frame is reported as one, not guessed at.
/// </summary>
public enum SocketIoFrameCodec
{
    /// <summary>MessagePack. The TypeScript library's default, so this is the one to leave alone.</summary>
    MessagePack,

    /// <summary>UTF-8 JSON, for a server configured with a JSON codec, or for reading a capture.</summary>
    Json
}

/// <summary>Where a socket.io peer connects, and what it says on the way in.</summary>
public sealed class SocketIoTransportOptions
{
    /// <summary>The server, e.g. <c>http://localhost:3000</c>.</summary>
    public string Url { get; set; } = "http://localhost:3000";

    /// <summary>
    /// Credentials for the handshake, which is where a socket.io server authenticates.
    ///
    /// This is the whole of identity on this carrier and the reason frames here are not signed: the
    /// connection is authenticated once, and the server pins every frame's `src` to the identity it
    /// authenticated. A per-frame signature would be a weaker claim checked in more places. MQTT
    /// cannot do this - a broker gives a receiver no connection to attribute a message to - which is
    /// why SourceRpc.Mqtt has signing and this does not.
    /// </summary>
    public object? Auth { get; set; }

    /// <inheritdoc cref="SocketIoFrameCodec"/>
    public SocketIoFrameCodec Codec { get; set; } = SocketIoFrameCodec.MessagePack;

    /// <summary>
    /// Announce this peer on connect. Off leaves it unlisted, and so unaddressable by anyone who
    /// looks the network up rather than being told a name.
    /// </summary>
    public bool AnnouncePresence { get; set; } = true;

    /// <summary>The namespace path, for a server that serves more than one.</summary>
    public string? Path { get; set; }

    /// <summary>Applied to the options socket.io itself is built with, for anything not exposed here.</summary>
    public Action<SocketIOOptions>? Configure { get; set; }
}

/// <summary>
/// A link to a socket.io server, for a .NET peer that dials out.
///
/// The third binding, and the one that shows the seam was worth cutting: it shares its frame layout
/// with SignalR, its presence handling with both, and its retry shape with all three, so what is
/// actually written here is an encoder, a decoder and two event names. Correlation, deadlines,
/// tickets, fences and error mapping are <see cref="SourceRpcClient"/>'s and
/// <see cref="RpcDispatcher"/>'s, and stay identical across every carrier.
///
/// **Client only.** socket.io's server is a Node library with no maintained .NET equivalent, so a
/// .NET process that needs to be dialled into should serve SignalR instead - which is the same flat
/// frame under different method names, and is why a TypeScript client can reach either.
///
/// Mirrors the TypeScript <c>SocketIoClientTransport</c>: <c>frame</c> carries codec-encoded bytes,
/// <c>presence</c> carries an ordinary object, and both are announced on every connect rather than
/// only the first - a server forgets a peer when its socket drops, so a reconnected peer that stayed
/// quiet would be unreachable while appearing perfectly healthy.
/// </summary>
public sealed class SocketIoClientTransport : ISourceRpcTransport
{
    private readonly SourceRpcOptions _options;
    private readonly SocketIoTransportOptions _socketIo;
    private readonly ILogger _log;
    private SocketIO? _socket;
    private CancellationTokenSource? _closing;

    /// <inheritdoc/>
    public string Name => _options.Name;

    /// <inheritdoc/>
    public bool Connected => _socket?.Connected == true;

    /// <inheritdoc/>
    public event Func<RpcFrame, Task>? FrameReceived;

    /// <inheritdoc/>
    public event Action<IReadOnlyCollection<string>>? PeersChanged;

    /// <summary>Connect to a socket.io server at a URL.</summary>
    public SocketIoClientTransport(string url, SourceRpcOptions options, ILogger? log = null)
        : this(new SocketIoTransportOptions { Url = url }, options, log)
    {
    }

    /// <summary>Connect with the full option set.</summary>
    public SocketIoClientTransport(SocketIoTransportOptions socketIo, SourceRpcOptions options, ILogger? log = null)
    {
        _socketIo = socketIo;
        _options = options;
        _log = log ?? NullLogger.Instance;
    }

    /// <inheritdoc/>
    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_socket is not null)
            return Task.CompletedTask;
        _closing = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        var options = new SocketIOOptions
        {
            // socket.io's own reconnection, kept rather than replaced: unlike SignalR's it does
            // cover a failed first attempt, so a peer that starts before its server is simply not
            // connected yet. The loop below exists only for what it does not cover - a server that
            // refuses the handshake outright, which stops socket.io retrying for good.
            Reconnection = true,
            ReconnectionDelayMax = _options.ReconnectDelaysMs.Length > 0 ? _options.ReconnectDelaysMs[^1] : 5000,
            ReconnectionAttempts = int.MaxValue,
            Auth = _socketIo.Auth
        };
        if (_socketIo.Path is { Length: > 0 } path)
            options.Path = path;
        _socketIo.Configure?.Invoke(options);

        var socket = new SocketIO(new Uri(_socketIo.Url), options);
        _socket = socket;

        socket.On(TransportContract.FrameName, OnFrameAsync);
        socket.On(TransportContract.PresenceName, OnPresenceAsync);
        // EventHandler, so the announcement cannot be awaited here and is fired instead. Failing to
        // announce is logged rather than thrown: the link is up either way, and a peer that cannot
        // be found is a better state to be in than one that took the process down.
        socket.OnConnected += (_, _) => _ = AnnounceAsync();
        socket.OnDisconnected += (_, reason) =>
        {
            // Nothing is reachable through a link that is down, and the server sends a fresh
            // snapshot when it returns. Reported empty so a console can grey the whole list out
            // rather than showing peers that cannot be called.
            _log.LogWarning("SourceRpc socket.io link closed: {Reason}", reason);
            PeersChanged?.Invoke([]);

            // socket.io deliberately never auto-reconnects after a *server-initiated* close - and
            // that is exactly what a restarting server sends on its way down. Left alone, one plant
            // server reboot orphans every .NET peer it had, permanently and silently: the process
            // is healthy, sends throw "not connected", and nothing ever tries again.
            //
            // Retried on a delay, so a server that closes deliberately - a displacement, a refused
            // handshake - is not hammered. Two peers configured with one name will fight through
            // this; that is the misconfiguration's noise, not a reason to stay dead after every
            // reboot. The TypeScript client transport carries the same workaround, for the reason.
            if (reason == ServerInitiatedClose && _closing?.IsCancellationRequested == false)
                _ = RetryAfterServerCloseAsync();
        };

        // Not awaited: ConnectAsync does not return until it is connected, and a peer that starts
        // before its server would otherwise block its own startup on something that may be minutes
        // away. A send meanwhile throws rather than being discarded, which tells a caller now.
        _ = ConnectAsync();
        return Task.CompletedTask;
    }

    /// <summary>
    /// What socket.io calls a close the server asked for, rather than a link that failed.
    /// </summary>
    private const string ServerInitiatedClose = "io server disconnect";

    /// <summary>Come back after a server closed the link, which socket.io will not do on its own.</summary>
    private async Task RetryAfterServerCloseAsync()
    {
        try
        {
            await Task.Delay(1000, _closing!.Token);
            if (_closing?.IsCancellationRequested == false && _socket?.Connected == false)
                await ConnectAsync();
        }
        catch (OperationCanceledException)
        {
            // Closed while waiting, which is the ordinary way this ends.
        }
    }

    /// <summary>
    /// Connect, and keep trying.
    ///
    /// Never throws. socket.io retries a dropped link on its own, but gives up permanently when a
    /// server refuses the handshake - and a plant server refuses handshakes for the whole of its
    /// reboot. Left alone, that orphans every client it had.
    /// </summary>
    private async Task ConnectAsync(int attempt = 0)
    {
        var socket = _socket;
        if (socket is null || _closing?.IsCancellationRequested != false)
            return;
        try
        {
            await socket.ConnectAsync();
            _log.LogInformation("SourceRpc connected to socket.io as {Peer}", _options.Name);
        }
        catch (Exception e) when (_closing?.IsCancellationRequested == false)
        {
            var delay = _options.ReconnectDelaysMs[Math.Min(attempt, _options.ReconnectDelaysMs.Length - 1)];
            _log.LogWarning(e, "SourceRpc could not reach the socket.io server; retrying in {Delay}ms", delay);
            try
            {
                await Task.Delay(delay, _closing!.Token);
                await ConnectAsync(attempt + 1);
            }
            catch (OperationCanceledException)
            {
                // Closed while waiting, which is the ordinary way this loop ends.
            }
        }
    }

    /// <summary>
    /// Say who this peer is.
    ///
    /// On every connect, not only the first: the server keeps its peer table per socket, so a
    /// reconnected peer that stayed silent is one nobody can address - and the failure looks like a
    /// working link, because frames still leave.
    /// </summary>
    private async Task AnnounceAsync()
    {
        if (!_socketIo.AnnouncePresence)
            return;
        var socket = _socket;
        if (socket is null)
            return;
        try
        {
            // As an object rather than as bytes: presence is the one message the TypeScript side
            // does not run its codec over, on either end.
            await socket.EmitAsync(
                TransportContract.PresenceName,
                [new PresenceAnnouncement { Name = _options.Name, V = TransportContract.FrameVersion }]);
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "SourceRpc could not announce {Peer}", _options.Name);
        }
    }

    /// <summary>
    /// Read one frame off the socket and start handling it - without waiting for that to finish.
    ///
    /// The decode happens here, synchronously, because the context belongs to the read loop and is
    /// not valid once this returns. The **dispatch** deliberately does not: socket.io awaits this
    /// callback before reading the next message, so awaiting a responder here means nothing else
    /// arrives until it returns - and a responder that calls out while handling a call would then
    /// wait for a reply that cannot be read until it stops waiting. That is a deadlock, and it
    /// resolves only when the outer call times out, which reads as a slow peer rather than as this.
    ///
    /// The TypeScript client does the same thing for the same reason: socket.io's JavaScript client
    /// never awaits a listener either, so this is the ordering the protocol was written against
    /// rather than a liberty taken here. Frames are correlated and events carry a cursor, so nothing
    /// above depends on them being *handled* in arrival order.
    /// </summary>
    private Task OnFrameAsync(IEventContext context)
    {
        RpcFrame frame;
        try
        {
            // A frame arrives as a binary attachment, so anything else on this event is not one.
            frame = Decode(context.GetValue<byte[]>(0) ?? throw new FormatException("frame event carried no payload"));
        }
        catch (Exception e)
        {
            // Announced, never dropped. Silence reaches a caller as a timeout, which is
            // indistinguishable from a slow method and sends the search to the wrong place.
            _log.LogError(e, "SourceRpc could not read an inbound socket.io frame");
            return Task.CompletedTask;
        }

        _ = DispatchAsync(frame);
        return Task.CompletedTask;
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
            // One bad frame from the far end must not take this peer down.
            _log.LogError(e, "SourceRpc failed to handle an inbound frame");
        }
    }

    private Task OnPresenceAsync(IEventContext context)
    {
        try
        {
            var update = context.GetValue<PresenceUpdate>(0);
            if (update?.Peers is { Length: > 0 } peers)
                PeersChanged?.Invoke(peers);
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "SourceRpc could not read a presence update");
        }
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public async Task SendAsync(RpcFrame frame, CancellationToken cancellationToken = default)
    {
        var socket = _socket;
        if (socket is null || !socket.Connected)
            // Thrown rather than dropped: a frame discarded in silence leaves its caller waiting out
            // the whole deadline for something that was never going to be sent.
            throw new SourceRpcException(RpcErrorCode.TransportError, "not connected to the socket.io server");
        await socket.EmitAsync(TransportContract.FrameName, [Encode(frame)], cancellationToken);
    }

    /// <summary>
    /// The frame as the bytes a socket.io event carries.
    ///
    /// Bytes rather than an object because the far end decodes the payload with a codec either way,
    /// so an object would arrive as something its decoder cannot read.
    /// </summary>
    private byte[] Encode(RpcFrame frame) =>
        _socketIo.Codec == SocketIoFrameCodec.Json
            ? JsonSerializer.SerializeToUtf8Bytes(frame, JsonOptions)
            // Contractless, so a body that is a record or an anonymous type writes as a map instead
            // of failing in the primitive formatter - the same resolver the MQTT binding uses, for
            // the same reason.
            : MessagePackSerializer.Serialize(frame, ContractlessStandardResolver.Options);

    private RpcFrame Decode(byte[] payload) =>
        _socketIo.Codec == SocketIoFrameCodec.Json
            ? JsonSerializer.Deserialize<RpcFrame>(payload, JsonOptions) ?? throw new FormatException("empty JSON frame")
            : MessagePackSerializer.Deserialize<RpcFrame>(payload, ContractlessStandardResolver.Options);

    /// <summary>
    /// The frame's own names are pinned by attribute, so nothing here renames anything. What this
    /// settles is the <c>body</c>, which is <see cref="object"/> and would otherwise decode to a
    /// <see cref="JsonElement"/> under one reader and something else under another.
    /// </summary>
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        // Idempotent, because a transport is ordinarily disposed twice: SourceRpcClient owns it and
        // disposes it, and a caller's `await using` on the transport does so again.
        var closing = Interlocked.Exchange(ref _closing, null);
        var socket = Interlocked.Exchange(ref _socket, null);
        if (closing is not null)
        {
            await closing.CancelAsync();
            closing.Dispose();
        }
        if (socket is not null)
        {
            try
            {
                await socket.DisconnectAsync();
            }
            catch (Exception e)
            {
                // A link already down cannot be closed again, and that is not a failure to report.
                _log.LogDebug(e, "SourceRpc socket.io disconnect failed on dispose");
            }
            socket.Dispose();
        }
    }
}
