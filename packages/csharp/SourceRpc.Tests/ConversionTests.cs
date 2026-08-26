using System.Text.Json;
using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// The same value, arriving both ways, read as the type a method asked for.
///
/// Every case runs twice: once shaped as MessagePack leaves it - boxed primitives, `object[]`,
/// `Dictionary` - and once as a <see cref="JsonElement"/>. A method written against one shape and
/// deployed on the other is the failure this converter exists to prevent, and testing only the
/// shape you happen to be running proves nothing about the other.
/// </summary>
public class ConversionTests
{
    /// <summary>The same frame twice: as MessagePack delivers it, and as JSON does.</summary>
    public static TheoryData<string, Func<object?[], RpcFrame>> Shapes => new()
    {
        { "msgpack", args => new RpcFrame { Body = args } },
        { "json", args => new RpcFrame { Body = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(args)) } }
    };

    private enum Valve { Shut, Open }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void Numbers_widen_and_narrow_without_the_method_knowing_which_protocol_delivered_them(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        // MessagePack picks the narrowest integer that holds a value, so the same parameter arrives
        // as a byte or an int depending on the magnitude of what somebody typed.
        var frame = build([(byte)7, 70000, 3.5]);
        Assert.Equal(7, frame.RequiredArg<int>(0));
        Assert.Equal(7L, frame.RequiredArg<long>(0));
        Assert.Equal(70000, frame.RequiredArg<int>(1));
        Assert.Equal(3.5, frame.RequiredArg<double>(2));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void A_value_that_does_not_fit_is_refused_rather_than_wrapped(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build([70000]);
        // Silently truncating to a short is how a setpoint becomes a different setpoint.
        Assert.Throws<SourceRpcException>(() => frame.RequiredArg<short>(0));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void Text_that_is_not_a_number_is_refused_rather_than_becoming_zero(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build(["not-a-number"]);

        // The defect this file exists for: `Arg` answers default, so the method sees 0 and acts on
        // it. A machine told to move to zero is not a sensible reading of unreadable input.
        Assert.Equal(0, frame.Arg<int>(0));

        var refused = Assert.Throws<SourceRpcException>(() => frame.RequiredArg<int>(0));
        Assert.Equal(RpcErrorCode.InvalidParams, refused.Code);
        Assert.False(frame.TryGetArg<int>(0, out _));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void A_missing_argument_is_refused_rather_than_defaulted(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build([1]);
        Assert.Throws<SourceRpcException>(() => frame.RequiredArg<int>(1));
        Assert.Throws<SourceRpcException>(() => frame.RequiredArg<int>(-1));
        Assert.False(frame.TryGetArg<int>(1, out _));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void Booleans_strings_and_enums_survive_both_protocols(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build([true, "flow", "Open"]);
        Assert.True(frame.RequiredArg<bool>(0));
        Assert.Equal("flow", frame.RequiredArg<string>(1));
        Assert.Equal(Valve.Open, frame.RequiredArg<Valve>(2));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void An_enum_name_nobody_defined_is_refused_rather_than_becoming_the_first_member(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build(["Ajar"]);
        // Zero is a real member, and usually the one that reads as safe - which is exactly why
        // falling back to it is dangerous.
        Assert.Throws<SourceRpcException>(() => frame.RequiredArg<Valve>(0));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void Guids_and_timestamps_are_read_from_their_wire_form(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var id = Guid.NewGuid();
        var when = new DateTimeOffset(2026, 8, 18, 9, 30, 0, TimeSpan.Zero);
        var frame = build([id.ToString(), when.ToString("O")]);
        Assert.Equal(id, frame.RequiredArg<Guid>(0));
        Assert.Equal(when, frame.RequiredArg<DateTimeOffset>(1));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void An_explicit_null_is_allowed_for_a_nullable_and_refused_for_a_value_type(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build([null]);
        Assert.Null(frame.RequiredArg<int?>(0));
        Assert.Null(frame.RequiredArg<string>(0));
        // `int` has no reading of "nothing was sent", and 0 is not one.
        Assert.Throws<SourceRpcException>(() => frame.RequiredArg<int>(0));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void Arrays_are_read_as_arrays(string shape, Func<object?[], RpcFrame> build)
    {
        _ = shape;
        var frame = build([new object?[] { 1, 2, 3 }]);
        Assert.Equal([1, 2, 3], frame.RequiredArg<int[]>(0));
    }
}
