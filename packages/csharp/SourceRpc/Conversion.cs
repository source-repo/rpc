using System.Collections;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SourceRpc;

/// <summary>
/// One value off the wire, as the type somebody asked for - or a refusal saying why not.
///
/// This exists because the same frame arrives shaped two different ways. Under the JSON protocols a
/// body is a <see cref="JsonElement"/>; under MessagePack it is boxed primitives, `object[]` and
/// `Dictionary`. Code written against either directly breaks the moment the other is configured, so
/// the conversion has to live in one place and behave identically from both.
///
/// **It fails rather than substituting.** The old behaviour returned `default` when a value could
/// not be converted, which in control software is considerably worse than throwing: a malformed
/// integer became `0` and a malformed boolean became `false`, and both are perfectly plausible
/// values that a method will act on. A setpoint of zero and a valve told to close are not sensible
/// interpretations of "the wire said something I could not read".
/// </summary>
public static class RpcConversion
{
    /// <summary>Convert, or throw <see cref="SourceRpcException"/> naming what could not be read.</summary>
    public static T? Required<T>(object? value, string what)
    {
        if (TryConvert<T>(value, out var converted, out var why))
            return converted;
        throw new SourceRpcException(RpcErrorCode.InvalidParams, $"{what} could not be read as {Describe(typeof(T))}: {why}");
    }

    /// <summary>Convert, or return default where the value is simply absent.</summary>
    public static T? Optional<T>(object? value)
    {
        if (value is null || (value is JsonElement { ValueKind: JsonValueKind.Null or JsonValueKind.Undefined }))
            return default;
        return TryConvert<T>(value, out var converted, out _) ? converted : default;
    }

    /// <summary>Convert, saying whether it worked rather than throwing.</summary>
    public static bool TryConvert<T>(object? value, out T? converted, out string why)
    {
        converted = default;
        why = "";

        if (value is null)
        {
            // Absent is a legitimate value for a reference or a Nullable, and a refusal for anything
            // else - `int` has no reading of "nothing was sent".
            if (default(T) is null)
                return true;
            why = "no value was sent";
            return false;
        }

        if (value is T already)
        {
            converted = already;
            return true;
        }

        var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);

        if (value is JsonElement element)
        {
            if (element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                if (default(T) is null)
                    return true;
                why = "the value was null";
                return false;
            }
            try
            {
                converted = element.Deserialize<T>(JsonShapes);
                return true;
            }
            catch (JsonException e)
            {
                why = e.Message;
                return false;
            }
        }

        if (target.IsEnum)
        {
            // Named on the wire in one protocol and numeric in the other, so both are accepted -
            // but a name that is not a member is refused rather than silently becoming zero, which
            // is a real enum value and usually the safest-looking one.
            try
            {
                converted = value is string name
                    ? (T)Enum.Parse(target, name, ignoreCase: true)
                    : (T)Enum.ToObject(target, System.Convert.ChangeType(value, Enum.GetUnderlyingType(target), CultureInfo.InvariantCulture));
                return true;
            }
            catch (Exception e) when (e is ArgumentException or InvalidCastException or FormatException or OverflowException)
            {
                why = $"'{value}' is not one of {string.Join(", ", Enum.GetNames(target))}";
                return false;
            }
        }

        if (target == typeof(Guid))
        {
            if (value is string text && Guid.TryParse(text, out var guid))
            {
                converted = (T)(object)guid;
                return true;
            }
            why = $"'{value}' is not a GUID";
            return false;
        }

        if (target == typeof(DateTimeOffset))
        {
            if (value is string moment && DateTimeOffset.TryParse(moment, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var when))
            {
                converted = (T)(object)when;
                return true;
            }
            why = $"'{value}' is not a timestamp";
            return false;
        }

        if (target == typeof(string))
        {
            converted = (T)(object)(value.ToString() ?? "");
            return true;
        }

        // A sequence converted element by element, because ChangeType cannot: MessagePack delivers
        // an array as `object[]` of boxed values, and asking for `int[]` has to convert each one.
        // Left until after the single-value cases so a string is not mistaken for a sequence.
        if (value is IEnumerable sequence and not string && ElementTypeOf(target) is { } element_)
        {
            var items = sequence.Cast<object?>().ToArray();
            var built = Array.CreateInstance(element_, items.Length);
            for (var at = 0; at < items.Length; at++)
            {
                if (!TryConvertTo(element_, items[at], out var item, out var itemWhy))
                {
                    why = $"item {at}: {itemWhy}";
                    return false;
                }
                built.SetValue(item, at);
            }
            if (target.IsAssignableFrom(built.GetType()))
            {
                converted = (T)(object)built;
                return true;
            }
            try
            {
                converted = (T)Activator.CreateInstance(target, built)!;
                return true;
            }
            catch (Exception e) when (e is MissingMethodException or InvalidCastException or System.Reflection.TargetInvocationException)
            {
                why = $"a sequence cannot be read as {Describe(target)}";
                return false;
            }
        }

        try
        {
            // MessagePack picks the narrowest integer that holds a value, so a JavaScript `7`
            // arrives as a byte and `70000` as an int - the same parameter, a different CLR type,
            // decided by the magnitude of what somebody typed. This is what makes that invisible.
            converted = (T)System.Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
            return true;
        }
        catch (Exception e) when (e is InvalidCastException or FormatException or OverflowException)
        {
            why = e is OverflowException ? $"{value} does not fit" : $"'{value}' is not a {Describe(target)}";
            return false;
        }
    }

    private static string Describe(Type type) => Nullable.GetUnderlyingType(type)?.Name ?? type.Name;

    /// <summary>
    /// What a JSON body is read with: enum names as well as numbers, because the two protocols do
    /// not agree on which they send and a method should not have to care.
    /// </summary>
    private static readonly JsonSerializerOptions JsonShapes = new()
    {
        Converters = { new JsonStringEnumConverter() },
        NumberHandling = JsonNumberHandling.AllowReadingFromString
    };

    /// <summary>The element type of an array or a generic collection, or null if it is neither.</summary>
    private static Type? ElementTypeOf(Type target)
    {
        if (target.IsArray)
            return target.GetElementType();
        if (target.IsGenericType && target.GetGenericArguments() is [var single] && typeof(IEnumerable).IsAssignableFrom(target))
            return single;
        return null;
    }

    /// <summary>TryConvert with the type known only at runtime, for converting a sequence's items.</summary>
    private static bool TryConvertTo(Type target, object? value, out object? converted, out string why)
    {
        var method = typeof(RpcConversion).GetMethod(nameof(TryConvert))!.MakeGenericMethod(target);
        object?[] call = [value, null, null];
        var ok = (bool)method.Invoke(null, call)!;
        converted = call[1];
        why = (string)call[2]!;
        return ok;
    }
}
