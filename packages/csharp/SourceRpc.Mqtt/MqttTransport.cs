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

    /// <summary>
    /// Sign every outgoing frame: (canonical bytes, this peer's name) -> base64 signature.
    ///
    /// Set it and this peer's frames can be checked by anyone holding its key. Leave it and its
    /// `mr-src` is an unchecked claim, which on a broker is all it can ever be.
    /// </summary>
    public Func<byte[], string, string>? Sign { get; set; }

    /// <summary>
    /// Check every incoming frame: (canonical bytes, signature, claimed source) -> whether it holds.
    ///
    /// Set it and an unsigned frame is refused too - otherwise signing would be bypassed by simply
    /// omitting the signature, which is not a check but a suggestion.
    /// </summary>
    public Func<byte[], string, string, string?>? Verify { get; set; }

    /// <summary>How far a frame's timestamp may differ from now, for the replay window.</summary>
    public TimeSpan MaxClockSkew { get; set; } = TimeSpan.FromMinutes(1);

    /// <summary>How many recent nonces to remember for replay detection.</summary>
    public int MaxTrackedNonces { get; set; } = 5000;

    /// <summary>
    /// How many reply addresses to hold at once.
    ///
    /// Bounded because a request whose exchange never ends - a peer with no handler for it, a
    /// method that never returns - would otherwise leave its entry behind for ever.
    /// </summary>
    public int MaxTrackedReplies { get; set; } = 1000;
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
    private readonly ReplayGuard _replays;
    private readonly Queue<string> _replyOrder = new();

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
        _replays = new ReplayGuard(mqtt.MaxClockSkew, mqtt.MaxTrackedNonces);
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

    private Task OnMessageAsync(MqttApplicationMessageReceivedEventArgs args)
    {
        var topic = args.ApplicationMessage.Topic;
        if (topic.StartsWith($"{_mqtt.Prefix}/presence/", StringComparison.Ordinal))
        {
            OnPresence(topic, args.ApplicationMessage.ConvertPayloadToString());
            return Task.CompletedTask;
        }

        var addressee = Mqtt5Frame.AddresseeOf(_mqtt.Prefix, topic) ?? _options.Name;

        // Properties first and the payload later, which is the order rather than a detail: the
        // payload is somebody else's bytes going into a deserializer, and it must not be read until
        // the frame carrying it has been shown to be authentic.
        var frame = Mqtt5Frame.Headers(args.ApplicationMessage, addressee, out var refusal);
        if (frame is null)
        {
            // Reported rather than dropped in silence. Anything at all can be published to a topic,
            // and "the calls just time out" is the hardest kind of problem to diagnose.
            _log.LogWarning("SourceRpc refused a frame on {Topic}: {Reason}", topic, refusal);
            Rejected?.Invoke(refusal ?? "unreadable frame");
            return Task.CompletedTask;
        }

        if (_mqtt.Verify is not null && Refuse(args.ApplicationMessage, frame, topic) is { } denial)
        {
            _log.LogWarning("SourceRpc refused a frame from {Source}: {Reason}", frame.Src, denial);
            Rejected?.Invoke(denial);
            return Task.CompletedTask;
        }

        frame = Mqtt5Frame.WithBody(frame, args.ApplicationMessage, out var undecodable);
        if (frame is null)
        {
            _log.LogWarning("SourceRpc refused a frame on {Topic}: {Reason}", topic, undecodable);
            Rejected?.Invoke(undecodable ?? "undecodable payload");
            return Task.CompletedTask;
        }

        // Remembered before dispatch so a reply can go where the caller asked and in what it asked.
        //
        // Only a *request* may name one, and the address must be one of ours. Neither guard is
        // about forgery - `responseTopic` is inside the signature and a signed frame attests it
        // faithfully - they are about authorisation. Without the kind check, any peer holding a key
        // for its own name can publish a signed `event` carrying somebody else's correlation and a
        // reply address of its choosing, and this peer will then send that exchange's answer there.
        // Without the prefix check, the named address can be another peer's presence topic, where
        // an answer body reads as a presence update and evicts them.
        if (Mqtt5Frame.IsRequest(frame.Kind)
            && frame.Corr is { Length: > 0 } corr
            && args.ApplicationMessage.ResponseTopic is { Length: > 0 } responseTopic)
        {
            if (!IsOurs(responseTopic))
            {
                _log.LogWarning("SourceRpc refused a reply address outside {Prefix}: {Topic}", _mqtt.Prefix, responseTopic);
                Rejected?.Invoke($"reply address '{responseTopic}' is outside this network");
                return Task.CompletedTask;
            }
            Remember(corr, new PendingReply(responseTopic, args.ApplicationMessage.ContentType == "application/json"));
        }

        // Started, not awaited. MQTTnet waits for this callback before delivering the next message,
        // so awaiting a responder here means nothing else arrives until it returns - and a responder
        // that calls out while handling a call would then wait for a reply that cannot be read until
        // it stops waiting. That is a deadlock, and it resolves as a timeout on the outer call,
        // which reads as a slow method rather than as this. Everything the reply path needs -
        // the reply topic and its content type - was recorded above, synchronously, before this.
        _ = DispatchAsync(frame);
        return Task.CompletedTask;
    }

    /// <summary>A reply address this peer is willing to send to: inside its own prefix, and no wildcard.</summary>
    private bool IsOurs(string topic) =>
        topic.StartsWith(_mqtt.Prefix + "/", StringComparison.Ordinal)
        && !topic.Contains('+', StringComparison.Ordinal)
        && !topic.Contains('#', StringComparison.Ordinal)
        && !topic.StartsWith("$", StringComparison.Ordinal);

    /// <summary>
    /// Hold where one exchange's answer goes, bounded.
    ///
    /// Entries leave on the reply that ends the exchange - but an exchange that never gets one, and
    /// a peer that is sent requests it has no handler for, would otherwise leave an entry behind
    /// for ever. Oldest first, because the oldest correlation is the one least likely still to be
    /// waited on.
    /// </summary>
    private void Remember(string correlation, PendingReply reply)
    {
        lock (_replyOrder)
        {
            _replies[correlation] = reply;
            _replyOrder.Enqueue(correlation);
            while (_replyOrder.Count > _mqtt.MaxTrackedReplies)
                // Dropped from the queue whether or not it is still in the map - a reply that
                // already ended its exchange removed itself, and dequeuing it again is a no-op.
                _replies.TryRemove(_replyOrder.Dequeue(), out _);
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
            _log.LogError(e, "SourceRpc failed to handle a frame from {Source}", frame.Src);
        }
    }

    /// <summary>Why this frame must not be acted on, or null when it is authentic.</summary>
    private string? Refuse(MqttApplicationMessage packet, RpcFrame frame, string topic)
    {
        string? Property(string name) =>
            packet.UserProperties?.FirstOrDefault(p => p.Name == name)?.Value;

        var signature = Property(Mqtt5Frame.Signature);
        var nonce = Property(Mqtt5Frame.Nonce);
        if (string.IsNullOrEmpty(signature) || string.IsNullOrEmpty(nonce))
            // An unsigned frame is not a valid frame once verification is on, or signing would be
            // bypassed by omitting the signature.
            return "unsigned";
        if (!long.TryParse(Property(Mqtt5Frame.Timestamp), out var timestamp))
            return "no timestamp";

        // The version gate applies to signed frames only, and the distinction is deliberate: an
        // unsigned peer's version says nothing about security and refusing it would break plain-MQTT
        // interop, which is the point of the layout. A *signed* frame announcing an older version is
        // different - version 2 left the fence outside the signature, so accepting one would let a
        // sender choose the form in which deleting one property disarms the owner check.
        var announced = Property(Mqtt5Frame.Version) ?? Mqtt5Frame.FrameVersion;
        if (announced != Mqtt5Frame.FrameVersion)
            return $"signed frame version '{announced}', which this build does not accept";

        if (!_replays.Accept(nonce, timestamp))
            return "stale or replayed";

        // Rebuilt from the properties **as they arrived**, not from the parsed frame - so tampering
        // with any of them fails the signature rather than changing how the payload is read, where
        // the answer is sent, what the caller does about a failure, whether a command that is
        // already too late still runs, or whether it runs under an ownership its caller never
        // observed.
        //
        // Raw text rather than round-tripped values, and that is the whole of the difference: this
        // used to sign `frame.Ttl?.ToString()`, which re-spells what arrived. Anything this library
        // sends is unaffected, because String(5000) is "5000" either way - but a plain MQTT peer
        // writing `mr-ttl: "05000"` is sending a valid frame, and its perfectly good signature was
        // refused as "bad signature". Being reachable by a peer with no msgrpc code in it is the
        // entire reason this layout exists, so signing a normalised copy of somebody else's frame
        // is not a small liberty. The TypeScript verifier reads the raw values; now so does this.
        var canonical = MqttSigning.CanonicalBytes(
            announced,
            topic,
            // Request-only, as the sender canonicalised it: a reply or an event has no answer to
            // direct, so a Response Topic on one is not part of what it said.
            Mqtt5Frame.IsRequest(frame.Kind) ? packet.ResponseTopic ?? "" : "",
            frame.Src,
            frame.Kind,
            Property(Mqtt5Frame.Path) ?? "",
            Property(Mqtt5Frame.Method) ?? Property(Mqtt5Frame.Event) ?? "",
            frame.Corr ?? "",
            packet.ContentType ?? "",
            Property(Mqtt5Frame.Code) ?? "",
            Property(Mqtt5Frame.ContractVersion) ?? "",
            Property(Mqtt5Frame.Ttl) ?? "",
            Property(Mqtt5Frame.IdempotencyKey) ?? "",
            Property(Mqtt5Frame.Fence) ?? "",
            Property(Mqtt5Frame.Deferred) ?? "",
            Property(Mqtt5Frame.Outcome) ?? "",
            Property(Mqtt5Frame.Seq) ?? "",
            Property(Mqtt5Frame.Epoch) ?? "",
            timestamp,
            nonce,
            packet.PayloadSegment);

        string? identity;
        try
        {
            identity = _mqtt.Verify!(canonical, signature, frame.Src);
        }
        catch (Exception e)
        {
            // A verifier that throws refuses, for the same reason an authorizer that throws denies.
            // Looking a key up is I/O in any real deployment, and an unknown source is exactly the
            // input an attacker chooses - letting that escape would skip this whole refusal path.
            _log.LogWarning(e, "SourceRpc verifier threw on a frame from {Source}", frame.Src);
            return "verifier error";
        }
        if (identity is null)
            return "bad signature";
        // Re-checked here rather than trusted: whoever the signature proves this is from must be
        // who the frame says it is from, or one peer's key admits frames in another peer's name.
        return identity == frame.Src ? null : "identity does not match source";
    }

    private void OnPresence(string topic, string state)
    {
        var peer = topic[(topic.LastIndexOf('/') + 1)..];
        if (peer == _options.Name || peer.Length == 0)
            return;
        // Both states named, and anything else ignored. An `else` branch here means *any* payload
        // that is not the word "online" evicts a peer - and a peer's presence topic is a place a
        // stray retained message, or an answer misdirected by a forged reply address, can land.
        // The TypeScript transport reads it the same way, for the same reason.
        if (state != "online" && state != "offline")
        {
            _log.LogWarning("SourceRpc ignored a presence payload for {Peer} that is neither online nor offline", peer);
            return;
        }
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
        if (_mqtt.Sign is { } sign)
        {
            var nonce = MqttSigning.CreateNonce();
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var canonical = MqttSigning.CanonicalBytes(
                Mqtt5Frame.FrameVersion,
                topic,
                responseTopic ?? "",
                frame.Src,
                frame.Kind,
                frame.Path ?? "",
                frame.Method ?? frame.Event ?? "",
                frame.Corr ?? "",
                packet.ContentType ?? "",
                frame.Code ?? "",
                frame.Ver ?? "",
                frame.Ttl?.ToString() ?? "",
                frame.Idem ?? "",
                frame.Fence ?? "",
                frame.Deferred == true ? "1" : "",
                frame.Outcome ?? "",
                frame.Seq?.ToString() ?? "",
                frame.Epoch ?? "",
                timestamp,
                nonce,
                packet.PayloadSegment);
            packet.UserProperties.Add(new MQTTnet.Packets.MqttUserProperty(Mqtt5Frame.Nonce, nonce));
            packet.UserProperties.Add(new MQTTnet.Packets.MqttUserProperty(Mqtt5Frame.Timestamp, timestamp.ToString()));
            packet.UserProperties.Add(new MQTTnet.Packets.MqttUserProperty(Mqtt5Frame.Signature, sign(canonical, frame.Src)));
        }
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
