using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using MessagePack;

namespace SourceRpc;

/// <summary>
/// One msgrpc frame, as described in docs/flat-frame-spec.md.
///
/// Every field is optional except the three that address it, because a frame carries what its kind
/// needs and nothing else.
///
/// ## Why every property is annotated twice
///
/// The names are lower-case on the wire, fixed by the specification, and **neither serializer will
/// produce them on its own**: System.Text.Json would send `V`/`Src`/`Tgt` without
/// <see cref="JsonPropertyNameAttribute"/>, and MessagePack would do the same without
/// <see cref="KeyAttribute"/> - and the two attribute families do not see each other, so annotating
/// for one silently leaves the other sending PascalCase at a client that will refuse it.
///
/// Pinned rather than left to a naming policy for the same reason in both cases: the wire format is
/// a contract with programs in other languages, and a serializer setting changed three years from
/// now must not be able to rename half a protocol.
/// </summary>
[MessagePackObject]
public sealed record RpcFrame
{
    /// <summary>Frame format version. A frame announcing anything else is refused, not guessed at.</summary>
    [JsonPropertyName("v")]
    [Key("v")]
    public int V { get; init; } = 2;

    /// <summary>The sending peer. Pin this to the connection's authenticated identity - see RpcHub.</summary>
    [JsonPropertyName("src")]
    [Key("src")]
    public string Src { get; init; } = "";

    /// <summary>The addressee.</summary>
    [JsonPropertyName("tgt")]
    [Key("tgt")]
    public string Tgt { get; init; } = "";

    /// <summary>How many relays this frame has passed through. Absent means none.</summary>
    [JsonPropertyName("hops")]
    [Key("hops")]
    public int? Hops { get; init; }

    /// <summary>call | subscribe | unsubscribe | result | error | event | ticket | batch</summary>
    [JsonPropertyName("kind")]
    [Key("kind")]
    public string Kind { get; init; } = "";

    /// <summary>The request id, shared by a call and every later answer to it. Absent on events.</summary>
    [JsonPropertyName("corr")]
    [Key("corr")]
    public string? Corr { get; init; }

    /// <summary>The exposed instance name.</summary>
    [JsonPropertyName("path")]
    [Key("path")]
    public string? Path { get; init; }

    [JsonPropertyName("method")]
    [Key("method")]
    public string? Method { get; init; }

    [JsonPropertyName("event")]
    [Key("event")]
    public string? Event { get; init; }

    /// <summary>On an error: the RpcErrorCode, e.g. MethodNotFound, Forbidden, Timeout.</summary>
    [JsonPropertyName("code")]
    [Key("code")]
    public string? Code { get; init; }

    /// <summary>Contract version the caller declares.</summary>
    [JsonPropertyName("ver")]
    [Key("ver")]
    public string? Ver { get; init; }

    /// <summary>Milliseconds the caller will still wait, counted from when it sent.</summary>
    [JsonPropertyName("ttl")]
    [Key("ttl")]
    public long? Ttl { get; init; }

    /// <summary>Names the command this is an attempt at, when the caller distinguishes the two.</summary>
    [JsonPropertyName("idem")]
    [Key("idem")]
    public string? Idem { get; init; }

    /// <summary>
    /// The owner generation the caller observed for <see cref="Path"/>, when it fences.
    ///
    /// If you keep any record of who owns an instance, compare it and answer code
    /// <c>OwnershipChanged</c> on any difference - including when you hold no record at all, which
    /// fails closed. A fence is checked by being present, so ignoring it is not a weaker check but
    /// no check, and the caller cannot tell the difference from a successful call.
    /// </summary>
    [JsonPropertyName("fence")]
    [Key("fence")]
    public string? Fence { get; init; }

    /// <summary>On a result: true when this is a receipt and the answer follows as a ticket.</summary>
    [JsonPropertyName("deferred")]
    [Key("deferred")]
    public bool? Deferred { get; init; }

    /// <summary>On a ticket: progress | resolved | rejected.</summary>
    [JsonPropertyName("outcome")]
    [Key("outcome")]
    public string? Outcome { get; init; }

    /// <summary>On an event this hub counts: the emission's position, and the incarnation it counts within.</summary>
    [JsonPropertyName("seq")]
    [Key("seq")]
    public long? Seq { get; init; }

    [JsonPropertyName("epoch")]
    [Key("epoch")]
    public string? Epoch { get; init; }

    /// <summary>
    /// Arguments for a request, the value for a result, the emit arguments for an event.
    ///
    /// Typed <see cref="object"/> rather than <see cref="JsonElement"/>, and that is forced rather
    /// than chosen: `JsonElement` is a System.Text.Json type and means nothing to MessagePack, so a
    /// frame declaring one can be carried by exactly one of the two protocols. As `object` each
    /// serializer produces what it produces - a `JsonElement` from one, `object[]` and boxed
    /// primitives from the other - which is why reading it directly is a mistake and
    /// <see cref="Arg{T}"/> exists.
    /// </summary>
    [JsonPropertyName("body")]
    [Key("body")]
    public object? Body { get; init; }

    /// <summary>On kind "batch": the frames this one carries, which are dispatched individually.</summary>
    [JsonPropertyName("batch")]
    [Key("batch")]
    public RpcFrame[]? Batch { get; init; }

    /// <summary>
    /// The argument at <paramref name="index"/>, whichever protocol delivered this frame.
    ///
    /// The whole point of it is that a responder never has to know: under JSON the body arrives as
    /// a <see cref="JsonElement"/> and under MessagePack as an <see cref="object"/> array of boxed
    /// primitives, and a method written against either directly breaks the moment the other is
    /// configured. Missing, out of range, or not convertible all answer <c>default</c> rather than
    /// throwing - a caller that sent the wrong thing should get a domain error from the method, not
    /// a cast exception from the plumbing.
    /// </summary>
    public T? Arg<T>(int index)
    {
        switch (Body)
        {
            case JsonElement element when element.ValueKind == JsonValueKind.Array:
                return index < element.GetArrayLength() ? element[index].Deserialize<T>() : default;
            case System.Collections.IList list:
                return index < list.Count ? Coerce<T>(list[index]) : default;
            default:
                return default;
        }
    }

    /// <summary>
    /// How many arguments this frame carries, for a method that takes a variable number.
    ///
    /// Ignored by both serializers, and it has to be said twice for two different reasons.
    /// MessagePack **refuses to build a formatter at all** when a public member of a
    /// [MessagePackObject] carries neither [Key] nor [IgnoreMember] - the type initializer throws,
    /// at the first frame rather than at build time, and the hub answers nothing. System.Text.Json
    /// is the quieter failure: it serializes a public getter happily, so without [JsonIgnore] every
    /// JSON frame this hub sent carried an `ArgCount` field that is not in the specification and
    /// that no receiver asked for.
    /// </summary>
    [IgnoreMember]
    [JsonIgnore]
    public int ArgCount =>
        Body switch
        {
            JsonElement element when element.ValueKind == JsonValueKind.Array => element.GetArrayLength(),
            System.Collections.IList list => list.Count,
            _ => 0
        };

    /// <summary>
    /// One boxed MessagePack value as the type a method asked for.
    ///
    /// MessagePack chooses the narrowest integer that holds a value, so a JavaScript `7` arrives as
    /// a <see cref="byte"/> and `70000` as an <see cref="int"/> - the same parameter, a different
    /// CLR type, decided by the magnitude of what somebody typed. ChangeType is what makes that
    /// invisible to the method.
    /// </summary>
    private static T? Coerce<T>(object? value)
    {
        if (value is null)
            return default;
        if (value is T already)
            return already;
        var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
        if (target == typeof(string))
            return (T)(object)(value.ToString() ?? "");
        try
        {
            return (T)Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is InvalidCastException or FormatException or OverflowException)
        {
            return default;
        }
    }

    /// <summary>
    /// A reply carrying an error code.
    ///
    /// The enum member's name *is* the string the wire carries and the string a TypeScript caller
    /// turns back into a typed rejection, so the conversion lives here and happens once rather than
    /// at every call site where a `.ToString()` could quietly be forgotten or spelled differently.
    /// </summary>
    public RpcFrame Reply(string kind, object? body, RpcErrorCode code) => Reply(kind, body, code.ToString());

    /// <summary>A reply addressed back to whoever sent this, with the correlation carried over.</summary>
    public RpcFrame Reply(string kind, object? body = null, string? code = null) =>
        new()
        {
            V = V,
            Src = Tgt,
            Tgt = Src,
            Kind = kind,
            Corr = Corr,
            Code = code,
            // Assigned rather than serialized: whichever protocol carries this frame will serialize
            // it on the way out, and pre-encoding to one of them is what made this untransportable
            // by the other.
            Body = body
        };
}

/// <summary>Sent by a connecting peer to say who it is, and repeated whenever any field changes.</summary>
[MessagePackObject]
public sealed record PresenceAnnouncement
{
    [JsonPropertyName("name")]
    [Key("name")]
    public string Name { get; init; } = "";

    /// <summary>The frame layout this peer speaks. 2 is the flat frame; anything else is not this protocol.</summary>
    [JsonPropertyName("v")]
    [Key("v")]
    public int? V { get; init; }

    /// <summary>A short hash of the surface this peer serves, so a cache can tell a restart that changed it.</summary>
    [JsonPropertyName("shape")]
    [Key("shape")]
    public string? Shape { get; init; }

    /// <summary>Peers reachable *through* the announcer, so a network deeper than a star can route.</summary>
    [JsonPropertyName("carrying")]
    [Key("carrying")]
    public string[]? Carrying { get; init; }
}

/// <summary>
/// Sent by the hub: the full list in answer to an announcement, and a single change afterwards.
/// The snapshot is what stands in for the retained presence an MQTT subscriber is handed.
/// </summary>
[MessagePackObject]
public sealed record PresenceUpdate
{
    [JsonPropertyName("peers")]
    [Key("peers")]
    public string[]? Peers { get; init; }

    [JsonPropertyName("peer")]
    [Key("peer")]
    public string? Peer { get; init; }

    /// <summary>online | offline</summary>
    [JsonPropertyName("state")]
    [Key("state")]
    public string? State { get; init; }

    [JsonPropertyName("shape")]
    [Key("shape")]
    public string? Shape { get; init; }

    [JsonPropertyName("shapes")]
    [Key("shapes")]
    public Dictionary<string, string>? Shapes { get; init; }
}
