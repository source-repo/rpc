using System.Text;
using System.Text.Json;
using MessagePack;
using MessagePack.Resolvers;
using MQTTnet;
using MQTTnet.Protocol;

namespace SourceRpc.Mqtt;

/// <summary>
/// What a frame is called on MQTT 5, and how it is read back off it. The layout is
/// docs/mqtt5-frame-spec.md, and this is the C# half of what `Transports/Mqtt5Frame.ts` does.
///
/// **This is not the flat frame, and that is deliberate.** The connection-oriented transports carry
/// one self-addressing map because they have one link and nothing else to address with. MQTT has a
/// great deal else: the topic carries the addressee, `responseTopic` says where a reply goes,
/// `correlationData` pairs it, and `messageExpiryInterval` lets the broker drop a request its caller
/// has stopped waiting for. Putting a flat frame in the payload would throw all of that away, along
/// with the property the layout exists for - that a plain MQTT client with no msgrpc code can take
/// part, and that an operator can see why a call failed in MQTT Explorer without decoding anything.
///
/// What *is* shared is the model: both wire formats map to <see cref="RpcFrame"/>, so a call means
/// the same thing on either and only the spelling differs.
/// </summary>
public static class Mqtt5Frame
{
    /// <summary>Control properties are prefixed so a broker injecting its own cannot be mistaken for one.</summary>
    public const string Version = "mr-v";
    public const string Source = "mr-src";
    public const string Kind = "mr-kind";
    public const string Path = "mr-path";
    public const string Method = "mr-method";
    public const string Event = "mr-event";
    public const string Code = "mr-code";
    public const string ContractVersion = "mr-ver";
    public const string Ttl = "mr-ttl";
    public const string IdempotencyKey = "mr-idem";
    public const string Fence = "mr-fence";
    public const string Deferred = "mr-deferred";
    public const string Outcome = "mr-outcome";
    public const string Seq = "mr-seq";
    public const string Epoch = "mr-epoch";
    public const string Nonce = "mr-nonce";
    public const string Timestamp = "mr-ts";
    public const string Signature = "mr-sig";

    /// <summary>
    /// The frame version this speaks. 3 covers the owner fence, the deferred marker, the ticket
    /// outcome and the event cursor - all of them in the signature, for peers that sign.
    /// </summary>
    public const string FrameVersion = "3";

    /// <summary>Which per-peer topic a frame belongs on.</summary>
    public static string Channel(string kind) =>
        kind switch
        {
            "call" or "subscribe" or "unsubscribe" => "req",
            "result" or "error" or "ticket" => "rsp",
            _ => "evt"
        };

    /// <summary>Kinds that expect an answer, and so are the only ones entitled to say where it goes.</summary>
    public static bool IsRequest(string? kind) => kind is "call" or "subscribe" or "unsubscribe";

    /// <summary>
    /// A reply that ends the exchange, so the reply address held for it can be released.
    ///
    /// A result marked deferred is *not* final - it is the receipt, and the answer comes later as a
    /// ticket - and a ticket is final only on the outcome that ends it. Releasing on the receipt
    /// sends every later answer to a derived topic in this peer's own encoding, so a caller that
    /// named its own reply topic gets the receipt where it asked and the answer somewhere else.
    /// </summary>
    public static bool IsFinalReply(RpcFrame frame) =>
        frame.Kind switch
        {
            "ticket" => frame.Outcome != "progress",
            "result" => frame.Deferred != true,
            "error" => true,
            _ => false
        };

    /// <summary>`&lt;prefix&gt;/&lt;channel&gt;/&lt;peer&gt;` - the topic a frame of this kind for this peer belongs on.</summary>
    public static string TopicFor(string prefix, string channel, string peer) => $"{prefix}/{channel}/{peer}";

    /// <summary>The peer a topic addresses, or null when it is not one of ours.</summary>
    public static string? AddresseeOf(string prefix, string topic)
    {
        if (!topic.StartsWith(prefix + "/", StringComparison.Ordinal))
            return null;
        var rest = topic[(prefix.Length + 1)..];
        var slash = rest.IndexOf('/');
        return slash < 0 ? null : rest[(slash + 1)..];
    }

    /// <summary>Build the packet a frame travels in.</summary>
    public static MqttApplicationMessage ToPacket(RpcFrame frame, string topic, string? responseTopic, bool json, uint expirySeconds)
    {
        var builder = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(EncodeBody(frame.Body, json))
            .WithContentType(json ? "application/json" : "application/msgpack")
            .WithPayloadFormatIndicator(json ? MqttPayloadFormatIndicator.CharacterData : MqttPayloadFormatIndicator.Unspecified)
            .WithUserProperty(Version, FrameVersion)
            .WithUserProperty(Source, frame.Src)
            .WithUserProperty(Kind, frame.Kind);

        if (frame.Corr is { Length: > 0 } corr)
            builder = builder.WithCorrelationData(Encoding.UTF8.GetBytes(corr));
        if (responseTopic is { Length: > 0 })
            // Only a request expects an answer, and only a request should expire. The expiry is the
            // caller's own remaining time, so the broker stops holding it the moment the caller
            // stops waiting - the two used to be set independently on the TypeScript side, and a
            // request outlived its caller's patience by twenty seconds by default.
            builder = builder.WithResponseTopic(responseTopic).WithMessageExpiryInterval(expirySeconds);

        builder = Add(builder, Path, frame.Path);
        builder = Add(builder, Method, frame.Method);
        builder = Add(builder, Event, frame.Event);
        builder = Add(builder, Code, frame.Code);
        builder = Add(builder, ContractVersion, frame.Ver);
        builder = Add(builder, Ttl, frame.Ttl?.ToString());
        builder = Add(builder, IdempotencyKey, frame.Idem);
        builder = Add(builder, Fence, frame.Fence);
        builder = Add(builder, Deferred, frame.Deferred == true ? "1" : null);
        builder = Add(builder, Outcome, frame.Outcome);
        builder = Add(builder, Seq, frame.Seq?.ToString());
        builder = Add(builder, Epoch, frame.Epoch);

        return builder.Build();
    }

    private static MqttApplicationMessageBuilder Add(MqttApplicationMessageBuilder builder, string name, string? value) =>
        string.IsNullOrEmpty(value) ? builder : builder.WithUserProperty(name, value);

    /// <summary>
    /// Read a frame's *addressing and control properties* off a packet, with no body.
    ///
    /// Split from the body deliberately, and it is a security boundary rather than tidiness: the
    /// payload is attacker-supplied bytes handed to a deserializer, and it must not be parsed until
    /// the frame carrying it has been shown to be authentic. Anything that can publish to a peer's
    /// request topic can otherwise reach the MessagePack reader with no key and no signature.
    ///
    /// A repeated control property is refused rather than resolved: MQTT permits one, and taking the
    /// first or the last would let a sender show one value to a check and another to the dispatcher.
    /// </summary>
    public static RpcFrame? Headers(MqttApplicationMessage packet, string addressee, out string? refusal)
    {
        refusal = null;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in packet.UserProperties ?? [])
        {
            if (!property.Name.StartsWith("mr-", StringComparison.Ordinal))
                continue;
            if (!values.TryAdd(property.Name, property.Value))
            {
                refusal = $"repeated control property {property.Name}";
                return null;
            }
        }

        if (!values.TryGetValue(Source, out var src) || string.IsNullOrEmpty(src))
        {
            refusal = "frame names no source";
            return null;
        }
        if (!values.TryGetValue(Kind, out var kind) || string.IsNullOrEmpty(kind))
        {
            refusal = "frame names no kind";
            return null;
        }

        var declared = packet.ContentType;
        if (!string.IsNullOrEmpty(declared) && declared != "application/msgpack" && declared != "application/json")
        {
            // An unknown content type used to fall back to msgpack, which is a guess about how to
            // read bytes somebody else chose - and the guess decides what the values mean.
            refusal = $"unknown content type '{declared}'";
            return null;
        }

        return new RpcFrame
        {
            V = 2,
            Src = src,
            Tgt = addressee,
            Kind = kind,
            Corr = packet.CorrelationData is { Length: > 0 } data ? Encoding.UTF8.GetString(data) : null,
            Path = Get(values, Path),
            Method = Get(values, Method),
            Event = Get(values, Event),
            Code = Get(values, Code),
            Ver = Get(values, ContractVersion),
            Ttl = long.TryParse(Get(values, Ttl), out var ttl) ? ttl : null,
            Idem = Get(values, IdempotencyKey),
            Fence = Get(values, Fence),
            // Presence, not value: `mr-deferred` is only ever sent as '1', and reading it as a
            // boolean would hydrate a ticket for a sender that wrote 'false'.
            Deferred = values.ContainsKey(Deferred) ? true : null,
            Outcome = Get(values, Outcome),
            Seq = long.TryParse(Get(values, Seq), out var seq) && seq >= 0 ? seq : null,
            Epoch = Get(values, Epoch)
        };
    }

    /// <summary>
    /// The same frame with its payload read - called only once the frame has been verified.
    /// </summary>
    public static RpcFrame? WithBody(RpcFrame frame, MqttApplicationMessage packet, out string? refusal)
    {
        refusal = null;
        try
        {
            return frame with { Body = DecodeBody(packet.PayloadSegment, packet.ContentType == "application/json") };
        }
        catch (Exception e)
        {
            refusal = $"undecodable payload: {e.Message}";
            return null;
        }
    }

    private static string? Get(Dictionary<string, string> values, string name) =>
        values.TryGetValue(name, out var value) && value.Length > 0 ? value : null;

    /// <summary>
    /// The payload is the body and nothing else - the argument array for a request, the value for a
    /// result - which is what makes a frame readable to a peer with no msgrpc code.
    /// </summary>
    public static byte[] EncodeBody(object? body, bool json)
    {
        if (body is null)
            return [];
        if (json)
            return JsonSerializer.SerializeToUtf8Bytes(body);
        // Serialized against the runtime type rather than `object`, so a result that is a record
        // writes as a map rather than failing in the primitive formatter.
        return MessagePackSerializer.Serialize(body.GetType(), body, ContractlessStandardResolver.Options);
    }

    /// <summary>
    /// Read a payload back, as whatever the encoding produced.
    ///
    /// Read under <see cref="MessagePackSecurity.UntrustedData"/>, because that is what it is. The
    /// standard options are documented as omitting all protections, including any bound on nesting
    /// depth - and `PrimitiveObjectFormatter` recurses once per nesting level, so a few kilobytes of
    /// repeated `0x91` is a StackOverflowException, which .NET cannot catch and which no `try`
    /// around this call can help with. The JSON reader needs no equivalent: its default MaxDepth of
    /// 64 throws cleanly.
    /// </summary>
    public static object? DecodeBody(ArraySegment<byte> payload, bool json)
    {
        if (payload.Count == 0)
            return null;
        if (json)
            return JsonSerializer.Deserialize<JsonElement>(payload.AsSpan());
        // As `object`, which gives primitives, object[] and Dictionary - the same shapes the
        // MessagePack hub protocol produces, so RpcFrame.Arg<T> reads them without knowing which
        // transport delivered them.
        return MessagePackSerializer.Deserialize<object?>(payload.ToArray(), UntrustedContractless);
    }

    /// <summary>Contractless, and with the depth and hash-collision guards that Standard omits.</summary>
    private static readonly MessagePackSerializerOptions UntrustedContractless =
        ContractlessStandardResolver.Options.WithSecurity(MessagePackSecurity.UntrustedData);
}
