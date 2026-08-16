using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace SourceRpc.Mqtt;

/// <summary>
/// The exact bytes an MQTT 5 frame's signature covers, and the primitives for producing one.
///
/// Signing matters more on this carrier than on any other, and the reason is structural: MQTT peers
/// connect to a broker rather than to each other, so a receiver has no connection to attribute a
/// message to and the `mr-src` field is only a claim. A broker operator, or any peer whose ACLs let
/// it publish to another peer's topic, can otherwise send frames as anybody. On socket.io and
/// SignalR the connection is authenticated once and the source pinned to it; here there is nothing
/// to pin to, and this is what replaces it.
/// </summary>
public static class MqttSigning
{
    /// <summary>
    /// The canonical bytes: a JSON array of the fields that decide what a frame means, then the
    /// payload.
    ///
    /// **Byte-identical with `canonicalSignedBytesV5` in the TypeScript library, and it has to be** -
    /// a signature is only worth anything if both ends agree on what was signed, and a difference of
    /// one escape produces a frame that verifies nowhere. The array is positional rather than named,
    /// so renaming an `mr-` property later cannot silently change what verifies; absent fields are
    /// the empty string; and `v` is included so a later revision cannot be made to verify under
    /// these rules.
    ///
    /// Everything the receiver *acts on* is covered, which is the rule version 2 was cut against and
    /// version 3 finished: the content type decides how the payload is read (`0x31` is the JSON text
    /// "1" and a MsgPack fixint 49 - both parse, both verified, one setpoint), the code decides what
    /// a caller does about a failure, the ttl decides whether a late command still runs, the fence
    /// decides whether it runs under an ownership its caller never observed, and the deferred marker
    /// and outcome decide whether a caller keeps waiting.
    ///
    /// `messageExpiryInterval` is deliberately *not* covered: the broker rewrites it in flight, so a
    /// signature over it would break on the first queued message. Nothing is lost, because it may
    /// only narrow the signed ttl and never extend it.
    /// </summary>
    public static byte[] CanonicalBytes(
        string version,
        string topic,
        string responseTopic,
        string source,
        string kind,
        string path,
        string methodOrEvent,
        string correlation,
        string contentType,
        string code,
        string contractVersion,
        string ttl,
        string idempotencyKey,
        string fence,
        string deferred,
        string outcome,
        string seq,
        string epoch,
        long timestamp,
        string nonce,
        ReadOnlySpan<byte> payload)
    {
        var json = new StringBuilder(256);
        json.Append('[');
        foreach (var field in new[]
                 {
                     version, topic, responseTopic, source, kind, path, methodOrEvent, correlation,
                     contentType, code, contractVersion, ttl, idempotencyKey, fence, deferred, outcome, seq, epoch
                 })
        {
            AppendJsonString(json, field);
            json.Append(',');
        }
        // A number rather than a string, exactly as JSON.stringify writes it. Timestamps here are
        // milliseconds and comfortably inside the range JavaScript writes without an exponent.
        json.Append(timestamp.ToString(CultureInfo.InvariantCulture)).Append(',');
        AppendJsonString(json, nonce);
        json.Append(']');

        var preamble = Encoding.UTF8.GetBytes(json.ToString());
        var result = new byte[preamble.Length + payload.Length];
        preamble.CopyTo(result, 0);
        payload.CopyTo(result.AsSpan(preamble.Length));
        return result;
    }

    /// <summary>
    /// One string, escaped the way `JSON.stringify` escapes it.
    ///
    /// Written out rather than delegated to System.Text.Json, which escapes more than JavaScript
    /// does: by default it turns `&lt;`, `&gt;`, `&amp;`, `+` and every non-ASCII character into
    /// `\uXXXX`, and even the relaxed encoder does not promise to agree character for character.
    /// "More escaping" is not a safe difference here - it is a different byte sequence, and the
    /// signature over it verifies nowhere.
    ///
    /// The rules are ECMA-262's QuoteJSONString: the two structural characters, the five short
    /// forms, anything else below 0x20 as lowercase `\u00xx`, unpaired surrogates escaped, and
    /// every other character literal - including all non-ASCII, which JavaScript emits as itself.
    /// </summary>
    private static void AppendJsonString(StringBuilder json, string? value)
    {
        json.Append('"');
        var text = value ?? "";
        for (var index = 0; index < text.Length; index++)
        {
            var c = text[index];
            switch (c)
            {
                case '"':
                    json.Append("\\\"");
                    break;
                case '\\':
                    json.Append("\\\\");
                    break;
                case '\b':
                    json.Append("\\b");
                    break;
                case '\f':
                    json.Append("\\f");
                    break;
                case '\n':
                    json.Append("\\n");
                    break;
                case '\r':
                    json.Append("\\r");
                    break;
                case '\t':
                    json.Append("\\t");
                    break;
                default:
                    if (c < 0x20)
                        json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
                    {
                        // A matched pair is one character and travels as itself. Both halves are
                        // taken now and the index advanced past the low half, because meeting it
                        // again on the next turn would read it as a lone surrogate and escape it -
                        // which is how an emoji in a peer name once signed as `\udf9b`.
                        json.Append(c).Append(text[index + 1]);
                        index++;
                    }
                    else if (char.IsSurrogate(c))
                        // A lone surrogate is not valid UTF-8 and JavaScript escapes it rather than
                        // emitting it, so the two sides would otherwise disagree on the bytes.
                        json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        json.Append(c);
                    break;
            }
        }
        json.Append('"');
    }

    /// <summary>A nonce with enough entropy that collisions are not a practical concern.</summary>
    public static string CreateNonce() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

    /// <summary>
    /// HMAC-SHA256 with a secret per peer. Universally available, and symmetric - whoever can verify
    /// a peer's frames can also forge them, so a secret must only be held by parties allowed to act
    /// as that peer.
    /// </summary>
    public static Func<byte[], string, string> HmacSigner(byte[] secret) =>
        (canonical, _) => Convert.ToBase64String(HMACSHA256.HashData(secret, canonical));

    /// <summary>
    /// Verify HMAC-SHA256, given a way to find each peer's secret.
    ///
    /// Returns the peer this frame is *proven* to be from, or null to refuse it. Deliberately not a
    /// bool: the transport re-checks the returned name against the frame's own `mr-src`, so a
    /// verifier that resolves keys loosely - `(canonical, sig, _) => AnyKnownKeyVerifies(...)` is an
    /// easy thing to write - cannot silently remove the binding between a signature and a name.
    /// That binding is the entire property signing exists to provide here.
    /// </summary>
    public static Func<byte[], string, string, string?> HmacVerifier(Func<string, byte[]?> secretFor) =>
        (canonical, signature, source) =>
        {
            var secret = secretFor(source);
            if (secret is null)
                return null;
            byte[] provided;
            try
            {
                provided = Convert.FromBase64String(signature);
            }
            catch (FormatException)
            {
                return null;
            }
            // Fixed-time, so a wrong signature does not leak how much of it was right.
            return CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(secret, canonical), provided) ? source : null;
        };
}

/// <summary>
/// Refuses frames that are too old and frames whose nonce has been seen before.
///
/// A signature alone does not stop a captured frame being sent again, which for RPC means replaying
/// a command. The freshness window bounds how long a captured frame stays useful, and bounds how
/// many nonces have to be remembered to cover it.
/// </summary>
public sealed class ReplayGuard(TimeSpan? maxClockSkew = null, int maxTrackedNonces = 5000)
{
    private readonly object _gate = new();
    private readonly Dictionary<string, long> _seen = new(StringComparer.Ordinal);

    /// <summary>Nonces in arrival order, so the oldest can be dropped without searching for it.</summary>
    private readonly Queue<string> _order = new();

    private readonly long _skewMs = (long)(maxClockSkew ?? TimeSpan.FromMinutes(1)).TotalMilliseconds;

    /// <summary>
    /// Whether the frame's clock is close enough to this one's to be worth checking further.
    ///
    /// Separate from remembering the nonce, and the split is the point: this is cheap and can run
    /// before the signature, while <see cref="Remember"/> mutates state and must not.
    /// </summary>
    public bool IsFresh(long timestamp, long? now = null)
    {
        var at = now ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Bounded by comparison rather than by subtracting, and that is not fussiness: `mr-ts` is
        // written by whoever sent the frame, arithmetic here is unchecked, and `Math.Abs` throws
        // outright on long.MinValue - so one crafted timestamp put an OverflowException in the
        // receive path, before any signature had been checked.
        return timestamp >= at - _skewMs && timestamp <= at + _skewMs;
    }

    /// <summary>
    /// Record a nonce, and say whether it had already been seen.
    ///
    /// Called **after** the signature has been checked, which matters more than it looks. A nonce
    /// committed before verification can be burned by anyone who can observe one: send a frame
    /// carrying somebody else's nonce and a wrong signature, and the genuine frame that follows is
    /// refused as a replay. The guard would then be a way to suppress traffic rather than a way to
    /// protect it.
    /// </summary>
    public bool Remember(string nonce, long timestamp, long? now = null)
    {
        if (string.IsNullOrEmpty(nonce))
            return false;
        var at = now ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!IsFresh(timestamp, at))
            return false;

        lock (_gate)
        {
            if (!_seen.TryAdd(nonce, at))
                return false;
            _order.Enqueue(nonce);

            // Oldest first, until both rules are satisfied - and the count rule has to be there.
            // Everything inside the freshness window is by definition too young to expire, so an
            // age-only rule bounds nothing at all: under load the table grows to arrival-rate times
            // the window, and every message walks the whole of it looking for something to drop.
            while (_order.Count > 0)
            {
                var oldest = _order.Peek();
                var expired = _seen.TryGetValue(oldest, out var when) && at - when > _skewMs;
                if (!expired && _seen.Count <= maxTrackedNonces)
                    break;
                _order.Dequeue();
                _seen.Remove(oldest);
            }
            return true;
        }
    }
}
