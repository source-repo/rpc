using System.Text.Json;
using System.Text.Json.Serialization;

namespace SourceRpc.SignalR;

/// <summary>
/// One msgrpc frame, as described in docs/flat-frame-spec.md.
///
/// Every field is optional except the three that address it, because a frame carries what its kind
/// needs and nothing else. The names are lower-case on the wire and are pinned here with
/// [JsonPropertyName] rather than left to a naming policy: the wire format is fixed by the
/// specification, and a serializer setting changed three years from now must not silently rename
/// half a protocol.
/// </summary>
public sealed record RpcFrame
{
    /// <summary>Frame format version. A frame announcing anything else is refused, not guessed at.</summary>
    [JsonPropertyName("v")]
    public int V { get; init; } = 2;

    /// <summary>The sending peer. Pin this to the connection's authenticated identity - see RpcHub.</summary>
    [JsonPropertyName("src")]
    public string Src { get; init; } = "";

    /// <summary>The addressee.</summary>
    [JsonPropertyName("tgt")]
    public string Tgt { get; init; } = "";

    /// <summary>How many relays this frame has passed through. Absent means none.</summary>
    [JsonPropertyName("hops")]
    public int? Hops { get; init; }

    /// <summary>call | subscribe | unsubscribe | result | error | event | ticket | batch</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    /// <summary>The request id, shared by a call and every later answer to it. Absent on events.</summary>
    [JsonPropertyName("corr")]
    public string? Corr { get; init; }

    /// <summary>The exposed instance name.</summary>
    [JsonPropertyName("path")]
    public string? Path { get; init; }

    [JsonPropertyName("method")]
    public string? Method { get; init; }

    [JsonPropertyName("event")]
    public string? Event { get; init; }

    /// <summary>On an error: the RpcErrorCode, e.g. MethodNotFound, Forbidden, Timeout.</summary>
    [JsonPropertyName("code")]
    public string? Code { get; init; }

    /// <summary>Contract version the caller declares.</summary>
    [JsonPropertyName("ver")]
    public string? Ver { get; init; }

    /// <summary>Milliseconds the caller will still wait, counted from when it sent.</summary>
    [JsonPropertyName("ttl")]
    public long? Ttl { get; init; }

    /// <summary>Names the command this is an attempt at, when the caller distinguishes the two.</summary>
    [JsonPropertyName("idem")]
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
    public string? Fence { get; init; }

    /// <summary>On a result: true when this is a receipt and the answer follows as a ticket.</summary>
    [JsonPropertyName("deferred")]
    public bool? Deferred { get; init; }

    /// <summary>On a ticket: progress | resolved | rejected.</summary>
    [JsonPropertyName("outcome")]
    public string? Outcome { get; init; }

    /// <summary>On an event this hub counts: the emission's position, and the incarnation it counts within.</summary>
    [JsonPropertyName("seq")]
    public long? Seq { get; init; }

    [JsonPropertyName("epoch")]
    public string? Epoch { get; init; }

    /// <summary>
    /// Arguments for a request, the value for a result, the emit arguments for an event.
    ///
    /// Deliberately <see cref="JsonElement"/> rather than a generic parameter: the hub routes
    /// frames it has no types for, and only the handler that owns a method knows what its arguments
    /// are. Deserialize it there, with <c>frame.Body?.Deserialize&lt;T[]&gt;()</c>.
    /// </summary>
    [JsonPropertyName("body")]
    public JsonElement? Body { get; init; }

    /// <summary>On kind "batch": the frames this one carries, each dispatched and answered separately.</summary>
    [JsonPropertyName("batch")]
    public RpcFrame[]? Batch { get; init; }

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
            Body = body is null ? null : JsonSerializer.SerializeToElement(body)
        };
}

/// <summary>Sent by a connecting peer to say who it is, and repeated whenever any field changes.</summary>
public sealed record PresenceAnnouncement
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    /// <summary>The frame layout this peer speaks. 2 is the flat frame; anything else is not this protocol.</summary>
    [JsonPropertyName("v")]
    public int? V { get; init; }

    /// <summary>A short hash of the surface this peer serves, so a cache can tell a restart that changed it.</summary>
    [JsonPropertyName("shape")]
    public string? Shape { get; init; }

    /// <summary>Peers reachable *through* the announcer, so a network deeper than a star can route.</summary>
    [JsonPropertyName("carrying")]
    public string[]? Carrying { get; init; }
}

/// <summary>
/// Sent by the hub: the full list in answer to an announcement, and a single change afterwards.
/// The snapshot is what stands in for the retained presence an MQTT subscriber is handed.
/// </summary>
public sealed record PresenceUpdate
{
    [JsonPropertyName("peers")]
    public string[]? Peers { get; init; }

    [JsonPropertyName("peer")]
    public string? Peer { get; init; }

    /// <summary>online | offline</summary>
    [JsonPropertyName("state")]
    public string? State { get; init; }

    [JsonPropertyName("shape")]
    public string? Shape { get; init; }

    [JsonPropertyName("shapes")]
    public Dictionary<string, string>? Shapes { get; init; }
}
