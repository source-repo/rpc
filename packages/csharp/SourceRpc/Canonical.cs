using System.Globalization;
using System.Text;

namespace SourceRpc;

/// <summary>
/// One value, in a form two of them can be compared as text.
///
/// **A port rather than an equivalent**, and the difference matters. This is one of the four things
/// the library specifies once and implements twice - with the outcome rules, the freshness state
/// machine and the deadline arithmetic - and none of them is a fact about the network, so each can
/// differ per language only by being wrong. The reference is `Canonical.ts`, and the fixture that
/// holds the two together is the row stamp's pinned input in `DataWrites.test.ts`, asserted here
/// against the same literal.
///
/// **Tagged by kind rather than stringified**, because `1` and `"1"` are different states of a
/// column and an encoding that could not tell them apart would report no change across a type
/// change. **Object keys are sorted**, because a JSON column round-trips through a driver and a
/// document store hands back BSON, neither of which promises key order between two reads - and
/// digesting insertion order reports a change on a value nobody touched. **A key whose value is
/// absent is omitted**, so an unset option and an explicit null-as-absent are the same value.
///
/// What it is for here, today, is the cache key: two callers asking a peer for the same page with
/// the same filter are asking one question however their options objects were built, and a key that
/// said otherwise would ask the plant twice for a page it is already holding.
/// </summary>
public static class RpcCanonical
{
    /// <summary>
    /// A value that is deliberately absent, as distinct from a value that is null.
    ///
    /// JavaScript has both and .NET has one, which is the single place this port cannot simply
    /// mirror its reference. TypeScript omits an object key whose value is `undefined` and encodes a
    /// `null` as a value; here a property is omitted by being <see cref="Absent"/> and encoded as
    /// null otherwise. Passing `null` where TypeScript would pass `undefined` produces a different
    /// canonical form, so a caller building options for a key should use this for "not asked for".
    /// </summary>
    public static readonly object Absent = new AbsentValue();

    private sealed class AbsentValue
    {
        public override string ToString() => "absent";
    }

    /// <summary>The canonical text of one value: what two of them are compared as.</summary>
    public static string Text(object? value)
    {
        var builder = new StringBuilder();
        Write(builder, value, 0);
        return builder.ToString();
    }

    /// <summary>
    /// A bound, because this may be built from something that arrived over a network. A deeply
    /// nested value is a caller holding it wrong rather than a plant, and recursion without a floor
    /// is a stack overflow rather than an error message.
    /// </summary>
    private const int MaxDepth = 64;

    private static void Write(StringBuilder into, object? value, int depth)
    {
        if (depth > MaxDepth)
        {
            Tagged(into, "?", () => Quote(into, "too deep"));
            return;
        }
        switch (value)
        {
            case null:
            case AbsentValue:
                into.Append("[\"n\"]");
                return;
            case bool flag:
                into.Append(flag ? "[\"b\",true]" : "[\"b\",false]");
                return;
            case string text:
                Tagged(into, "s", () => Quote(into, text));
                return;
            case DateTime moment:
                // Universal and to milliseconds, which is what `Date.prototype.toISOString` writes.
                Tagged(into, "t", () => Quote(into, moment.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)));
                return;
            case DateTimeOffset moment:
                Tagged(into, "t", () => Quote(into, moment.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)));
                return;
            case byte[] bytes:
                Tagged(into, "y", () =>
                {
                    into.Append('[');
                    for (var at = 0; at < bytes.Length; at++)
                    {
                        if (at > 0) into.Append(',');
                        into.Append(bytes[at].ToString(CultureInfo.InvariantCulture));
                    }
                    into.Append(']');
                });
                return;
            case System.Numerics.BigInteger big:
                Tagged(into, "i", () => Quote(into, big.ToString(CultureInfo.InvariantCulture)));
                return;
            case sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal:
                Tagged(into, "d", () => Number(into, System.Convert.ToDouble(value, CultureInfo.InvariantCulture)));
                return;
            case System.Collections.IDictionary map:
                Tagged(into, "o", () => Fields(into, map.Keys.Cast<object>().Select(key => new KeyValuePair<string, object?>(System.Convert.ToString(key, CultureInfo.InvariantCulture) ?? "", map[key])), depth));
                return;
            case System.Collections.IEnumerable list:
                // An array's order is part of its value - a page of rows in a different order is a
                // different page - so this is the one place order is kept rather than sorted away.
                Tagged(into, "a", () =>
                {
                    into.Append('[');
                    var first = true;
                    foreach (var item in list)
                    {
                        if (!first) into.Append(',');
                        first = false;
                        Write(into, item, depth + 1);
                    }
                    into.Append(']');
                });
                return;
            default:
                Tagged(into, "o", () => Fields(into, Properties(value), depth));
                return;
        }
    }

    /// <summary>
    /// A plain object's readable properties, which is what an options record is in .NET.
    ///
    /// Public instance properties with a getter and no index, which covers a record, an anonymous
    /// type and a POCO alike - and deliberately not fields, so that a private backing store cannot
    /// reach a key twice under two names.
    /// </summary>
    private static IEnumerable<KeyValuePair<string, object?>> Properties(object value) =>
        value.GetType()
            .GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .Where(property => property.CanRead && property.GetIndexParameters().Length == 0)
            .Select(property => new KeyValuePair<string, object?>(property.Name, property.GetValue(value)));

    private static void Fields(StringBuilder into, IEnumerable<KeyValuePair<string, object?>> fields, int depth)
    {
        into.Append('[');
        var first = true;
        // Ordinal, which is what `Array.prototype.sort` does to strings by default - a culture-aware
        // comparison would order the same two keys differently on two machines, which is the failure
        // sorting exists to prevent rather than a new one.
        foreach (var field in fields.Where(field => field.Value is not AbsentValue).OrderBy(field => field.Key, StringComparer.Ordinal))
        {
            if (!first) into.Append(',');
            first = false;
            into.Append('[');
            Quote(into, field.Key);
            into.Append(',');
            Write(into, field.Value, depth + 1);
            into.Append(']');
        }
        into.Append(']');
    }

    private static void Tagged(StringBuilder into, string tag, Action body)
    {
        into.Append("[\"").Append(tag).Append("\",");
        body();
        into.Append(']');
    }

    /// <summary>
    /// A number as `JSON.stringify` writes it.
    ///
    /// The one place this port has to imitate a runtime rather than a specification, so what it
    /// covers is stated rather than assumed. An integral value below 2^53 is written without a
    /// decimal point, which is what JavaScript does and what .NET does not; everything else uses
    /// the shortest round-trip form, which both runtimes agree on for ordinary decimals. **Very
    /// large and very small magnitudes are where the two could still diverge**, because the
    /// threshold at which each switches to exponent notation is a runtime's choice - a value out
    /// there in a cache key is harmless, and one in a row stamp would be a genuine disagreement.
    /// Non-finite values never reach here; they are strings by then, since a sensor reading
    /// out-of-range and a sensor reading no-value must not become the same state.
    /// </summary>
    private static void Number(StringBuilder into, double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            Quote(into, double.IsNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity");
            return;
        }
        if (value == 0)
        {
            // Negative zero prints as "0" in JavaScript, and two readings of zero are one state.
            into.Append('0');
            return;
        }
        if (Math.Floor(value) == value && Math.Abs(value) < 9007199254740992d)
        {
            into.Append(((long)value).ToString(CultureInfo.InvariantCulture));
            return;
        }
        into.Append(value.ToString("R", CultureInfo.InvariantCulture).Replace("E", "e", StringComparison.Ordinal));
    }

    /// <summary>
    /// A string as `JSON.stringify` writes it: quote and backslash escaped, the five short escapes
    /// used where they exist, every other control character as `\uXXXX`, and everything above them
    /// - including non-ASCII - left exactly as it is.
    ///
    /// Written out rather than delegated, because .NET's JSON writer escapes more than JavaScript
    /// does by default: `&lt;`, `&gt;`, `&amp;` and non-ASCII all come back as `\uXXXX`, which is
    /// valid JSON and a different string. A tag name with an umlaut in it would then hash
    /// differently in the two languages, which is exactly the divergence this file exists to prevent.
    /// </summary>
    private static void Quote(StringBuilder into, string text)
    {
        into.Append('"');
        foreach (var character in text)
        {
            switch (character)
            {
                case '"': into.Append("\\\""); break;
                case '\\': into.Append("\\\\"); break;
                case '\b': into.Append("\\b"); break;
                case '\f': into.Append("\\f"); break;
                case '\n': into.Append("\\n"); break;
                case '\r': into.Append("\\r"); break;
                case '\t': into.Append("\\t"); break;
                default:
                    if (character < 0x20) into.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else into.Append(character);
                    break;
            }
        }
        into.Append('"');
    }
}
