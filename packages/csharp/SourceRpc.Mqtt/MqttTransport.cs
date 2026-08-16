using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Formatter;
using MQTTnet.Protocol;

namespace SourceRpc.Mqtt;

/// <summary>How this peer reaches a broker, and what it calls things once there.</summary>
public sealed class MqttTransportOptions
{
    /// <summary>Where the broker is, e.g. `mqtt://localhost:1883`.</summary>
    public string BrokerUrl { get; set; } = "mqtt://localhost:1883";

    /// <summary>
    /// The topic prefix every frame lives under. `msgrpc/v1` is the `$`-delimited layout's, so v1
    /// and v2 peers share a broker without seeing each other.
    /// </summary>
    public string Prefix { get; set; } = "msgrpc/v2";

    /// <summary>Quality of service for published frames. 1 by default: a call that is silently lost is a call that hangs.</summary>
    public MqttQualityOfServiceLevel QoS { get; set; } = MqttQualityOfServiceLevel.AtLeastOnce;

    /// <summary>Send bodies as JSON rather than MsgPack. A responder answers in whatever it was asked in regardless.</summary>
    public bool Json { get; set; }

    /// <summary>How long the broker holds a request whose caller named no deadline.</summary>
    public uint DefaultExpirySeconds { get; set; } = 30;

    /// <summary>Credentials, when the broker wants them.</summary>
    public string? Username { get; set; }

    /// <summary>Credentials, when the broker wants them.</summary>
    public string? Password { get; set; }
}

/// <summary>
/// A Source RPC peer on an MQTT broker.
///
/// There is no server here and no client, because on this carrier there is no such distinction: a
/// peer subscribes to its own topics and publishes to other peers'. What decides whether it serves
/// or calls is whether a responder was given to the dispatcher, not anything about the transport.
///
/// It speaks the `mr-` property layout of docs/mqtt5-frame-spec.md rather than the flat frame the
/// connection-oriented transports use, and that is the point of the layout rather than an accident
/// of history - see <see cref="Mqtt5Frame"/>.
/// </summary>
public sealed class MqttTransport : ISourceRpcTransport
{
    private readonly MqttTransportOptions _mqtt;
    private readonly SourceRpcOptions _options;
    private readonly ILogger _log;
    private readonly IMqttClient _client;
    private readonly MqttFactory _factory = new();
    private readonly ConcurrentDictionary<string, PendingReply> _replies = new();
    private CancellationTokenSource? _closing;

    /// <summary>Where a caller asked to be answered, and in what.</summary>
    private readonly record struct PendingReply(string Topic, bool Json);

    /// <inheritdoc/>
    public string Name => _options.Name;

    /// <inheritdoc/>
    public bool Connected => _client.IsConnected;

    /// <inheritdoc/>
    public event Func<RpcFrame, Task>? FrameReceived;

    /// <inheritdoc/>
    public event Action<IReadOnlyCollection<string>>? PeersChanged;

    /// <summary>A frame that could not be read, announced rather than dropped.</summary>
    public event Action<string>? Rejected;

    /// <summary>Creates a peer. The link is opened by <see cref="StartAsync"/>.</summary>
    public MqttTransport(MqttTransportOptions mqtt, SourceRpcOptions options, ILogger? log = null)
    {
        _mqtt = mqtt;
        _options = options;
        _log = log ?? NullLogger.Instance;
        _client = _factory.CreateMqttClient();
        _client.ApplicationMessageReceivedAsync += OnMessageAsync;
        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    private readonly HashSet<string> _peers = [];

    /// <inheritdoc/>
    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        _closing = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await ConnectAsync();
    }

    private async Task ConnectAsync(int attempt = 0)
    {
        if (_closing?.IsCancellationRequested != false)
            return;
        try
        {
            var uri = new Uri(_mqtt.BrokerUrl);
            var builder = new MqttClientOptionsBuilder()
                .WithProtocolVersion(MqttProtocolVersion.V500)
                .WithClientId(_options.Name)
                .WithTcpServer(uri.Host, uri.Port > 0 ? uri.Port : 1883)
                // The peer's own gravestone: published by the broker if this connection drops
                // without saying goodbye, so its absence is announced rather than inferred from
                // calls that stop being answered.
                .WithWillTopic(Mqtt5Frame.TopicFor(_mqtt.Prefix, "presence", _options.Name))
                .WithWillPayload(Encoding.UTF8.GetBytes("offline"))
                .WithWillRetain(true);
            if (_mqtt.Username is { Length: > 0 })
                builder = builder.WithCredentials(_mqtt.Username, _mqtt.Password);

            await _client.ConnectAsync(builder.Build(), _closing!.Token);

            // Its own three channels. A pure caller never needs `req` and a pure responder never
            // needs `evt`, but subscribing to all three keeps one class serving both roles - the
            // ACL argument for splitting them is about what a broker *permits*, not what a library
            // must ask for.
            foreach (var channel in new[] { "req", "rsp", "evt" })
                await _client.SubscribeAsync(Mqtt5Frame.TopicFor(_mqtt.Prefix, channel, _options.Name), _mqtt.QoS, _closing.Token);
            // Everyone's presence, which is how a peer is discovered at all here: retained, so a
            // newcomer is handed the ones already online rather than waiting for them to speak.
            await _client.SubscribeAsync($"{_mqtt.Prefix}/presence/+", MqttQualityOfServiceLevel.AtLeastOnce, _closing.Token);

            await _client.PublishAsync(
                new MqttApplicationMessageBuilder()
                    .WithTopic(Mqtt5Frame.TopicFor(_mqtt.Prefix, "presence", _options.Name))
                    .WithPayload(Encoding.UTF8.GetBytes("online"))
                    .WithRetainFlag(true)
                    .Build(),
                _closing.Token);

            _log.LogInformation("SourceRpc peer {Peer} is on the broker at {Broker}", _options.Name, _mqtt.BrokerUrl);
        }
        catch (Exception e) when (_closing?.IsCancellationRequested == false)
        {
            var delay = _options.ReconnectDelaysMs[Math.Min(attempt, _options.ReconnectDelaysMs.Length - 1)];
            _log.LogWarning(e, "SourceRpc could not reach the broker; retrying in {Delay}ms", delay);
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(delay, _closing!.Token);
                    await ConnectAsync(attempt + 1);
                }
                catch (OperationCanceledException)
                {
                    // Closed while waiting, which is how this loop ordinarily ends.
                }
            });
        }
    }

    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs args)
    {
        if (_closing?.IsCancellationRequested != false)
            return Task.CompletedTask;
        _log.LogWarning("SourceRpc lost the broker: {Reason}", args.Reason);
        // Same loop as the first connection, for the same reason the SignalR binding uses one: a
        // peer that came up before its broker and one whose broker went away want the same thing.
        _ = ConnectAsync();
        return Task.CompletedTask;
    }

    private async Task OnMessageAsync(MqttApplicationMessageReceivedEventArgs args)
    {
        var topic = args.ApplicationMessage.Topic;
        if (topic.StartsWith($"{_mqtt.Prefix}/presence/", StringComparison.Ordinal))
        {
            OnPresence(topic, args.ApplicationMessage.ConvertPayloadToString());
            return;
        }

        var addressee = Mqtt5Frame.AddresseeOf(_mqtt.Prefix, topic) ?? _options.Name;
        var frame = Mqtt5Frame.FromPacket(args.ApplicationMessage, addressee, out var refusal);
        if (frame is null)
        {
            // Reported rather than dropped in silence. Anything at all can be published to a topic,
            // and "the calls just time out" is the hardest kind of problem to diagnose.
            _log.LogWarning("SourceRpc refused a frame on {Topic}: {Reason}", topic, refusal);
            Rejected?.Invoke(refusal ?? "unreadable frame");
            return;
        }

        // Remembered before dispatch so a reply can go where the caller asked and in what it asked.
        if (frame.Corr is { Length: > 0 } corr && args.ApplicationMessage.ResponseTopic is { Length: > 0 } responseTopic)
            _replies[corr] = new PendingReply(responseTopic, args.ApplicationMessage.ContentType == "application/json");

        var handler = FrameReceived;
        if (handler is null)
            return;
        try
        {
            await handler(frame);
        }
        catch (Exception e)
        {
            _log.LogError(e, "SourceRpc failed to handle a frame from {Source}", frame.Src);
        }
    }

    private void OnPresence(string topic, string state)
    {
        var peer = topic[(topic.LastIndexOf('/') + 1)..];
        if (peer == _options.Name || peer.Length == 0)
            return;
        lock (_peers)
        {
            if (state == "online")
                _peers.Add(peer);
            else
                _peers.Remove(peer);
            PeersChanged?.Invoke(_peers.ToArray());
        }
    }

    /// <inheritdoc/>
    public async Task SendAsync(RpcFrame frame, CancellationToken cancellationToken = default)
    {
        if (!_client.IsConnected)
            // Thrown rather than queued: a frame discarded in silence leaves its caller waiting out
            // the whole deadline for something that was never going to be sent.
            throw new SourceRpcException(RpcErrorCode.TransportError, "not connected to the broker");

        var channel = Mqtt5Frame.Channel(frame.Kind);
        var isReply = channel == "rsp" && frame.Corr is { Length: > 0 };

        // A reply goes where its request asked and in the encoding it arrived in. Read rather than
        // taken, and released only on the reply that ends the exchange: a deferred method answers
        // twice, and forgetting on the receipt would send the real answer to a derived topic in
        // this peer's own encoding - where the caller is not listening.
        PendingReply? pending = isReply && _replies.TryGetValue(frame.Corr!, out var held) ? held : null;
        if (isReply && frame.Corr is { Length: > 0 } corr && Mqtt5Frame.IsFinalReply(frame))
            _replies.TryRemove(corr, out _);

        var topic = pending?.Topic ?? Mqtt5Frame.TopicFor(_mqtt.Prefix, channel, frame.Tgt);
        var json = pending?.Json ?? _mqtt.Json;
        // Where this peer wants its own answer. Named explicitly rather than left to the far end to
        // derive, which is what MQTT 5 request/response means.
        var responseTopic = Mqtt5Frame.IsRequest(frame.Kind) ? Mqtt5Frame.TopicFor(_mqtt.Prefix, "rsp", frame.Src) : null;
        var expiry = frame.Ttl is { } ttl and > 0 ? (uint)Math.Clamp((ttl + 999) / 1000, 1, uint.MaxValue) : _mqtt.DefaultExpirySeconds;

        var packet = Mqtt5Frame.ToPacket(frame, topic, responseTopic, json, expiry);
        await _client.PublishAsync(packet, cancellationToken);
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        var closing = Interlocked.Exchange(ref _closing, null);
        if (closing is not null)
        {
            await closing.CancelAsync();
            closing.Dispose();
        }
        if (_client.IsConnected)
        {
            // Said rather than left to the will: a deliberate departure should look different from
            // a link that died, and a retained `offline` is what stops this peer being listed for
            // ever by everyone who was watching.
            try
            {
                await _client.PublishAsync(
                    new MqttApplicationMessageBuilder()
                        .WithTopic(Mqtt5Frame.TopicFor(_mqtt.Prefix, "presence", _options.Name))
                        .WithPayload(Encoding.UTF8.GetBytes("offline"))
                        .WithRetainFlag(true)
                        .Build(),
                    CancellationToken.None);
                await _client.DisconnectAsync();
            }
            catch (Exception e)
            {
                _log.LogDebug(e, "SourceRpc could not say goodbye to the broker");
            }
        }
        _client.Dispose();
    }
}
