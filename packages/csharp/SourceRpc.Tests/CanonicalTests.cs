using SourceRpc.Query;

namespace SourceRpc.Tests;

/// <summary>
/// The canonical encoder, against the encoder it is a port of.
///
/// **Every expected string here was produced by the TypeScript implementation**, not written by
/// hand from the specification - which is the only way this file can prove what it claims. The
/// first of them is the tail of a literal that `packages/rpc/src/DataWrites.test.ts` pins for the
/// row stamp, so the two suites hold each other: change either encoder and one of them fails.
///
/// That matters beyond tidiness. The encoder is what a row stamp digests, and a stamp is a
/// precondition - so two languages disagreeing about it is not a formatting difference, it is a
/// compare-and-set that fails at random on a mixed site.
/// </summary>
public class CanonicalTests
{
    [Fact]
    public void Keys_are_sorted_so_two_readings_of_one_value_agree()
    {
        // The exact substring `DataWrites.test.ts` pins inside the row stamp's digest input. A
        // driver round-tripping a JSON column and a document store handing back BSON promise
        // nothing about key order between two reads, so insertion order would report a change on a
        // row nobody touched.
        Assert.Equal(
            """["o",[["city",["s","Berlin"]],["name",["s","Acme Ltd"]]]]""",
            RpcCanonical.Text(new { name = "Acme Ltd", city = "Berlin" }));
    }

    [Fact]
    public void An_absent_value_is_omitted_and_a_null_is_a_value()
    {
        // JavaScript has `undefined` and `null` and .NET has one of them, which is the single place
        // this port cannot simply mirror its reference - so "not asked for" is spelled explicitly.
        Assert.Equal("""["o",[["a",["d",1]]]]""", RpcCanonical.Text(new { a = 1, b = RpcCanonical.Absent }));
        Assert.Equal("""["o",[["a",["d",1]],["b",["n"]]]]""", RpcCanonical.Text(new { a = 1, b = (object?)null }));
    }

    [Fact]
    public void Order_inside_an_array_is_part_of_the_value()
    {
        // A page of rows in a different order is a different page, and a path spelled in a different
        // order names a different place. Sorting here would make both invisible.
        Assert.Equal("""["a",[["s","state"],["s","tags"]]]""", RpcCanonical.Text(new[] { "state", "tags" }));
        Assert.NotEqual(RpcCanonical.Text(new[] { "state", "tags" }), RpcCanonical.Text(new[] { "tags", "state" }));
    }

    [Fact]
    public void A_value_is_tagged_by_kind_so_a_type_change_is_a_change()
    {
        Assert.NotEqual(RpcCanonical.Text(1), RpcCanonical.Text("1"));
        Assert.NotEqual(RpcCanonical.Text(true), RpcCanonical.Text(1));
        Assert.NotEqual(RpcCanonical.Text(null), RpcCanonical.Text(""));
        Assert.NotEqual(RpcCanonical.Text(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)), RpcCanonical.Text("1970-01-01T00:00:00.000Z"));
    }

    [Fact]
    public void Nested_values_and_dates_encode_as_the_reference_does()
    {
        Assert.Equal(
            """["o",[["a",["o",[["d",["t","1970-01-01T00:00:00.000Z"]]]]],["z",["a",[["d",1],["s","x"],["b",true]]]]]]""",
            RpcCanonical.Text(new { z = new object[] { 1, "x", true }, a = new { d = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc) } }));
    }

    [Fact]
    public void Numbers_are_written_the_way_the_reference_writes_them()
    {
        // The one place this port imitates a runtime rather than a specification: JavaScript writes
        // an integral value without a decimal point and .NET does not.
        Assert.Equal(
            """["o",[["big",["d",9007199254740991]],["f",["d",12.5]],["i",["d",3]],["n",["d",0]]]]""",
            RpcCanonical.Text(new { i = 3, f = 12.5, n = -0.0, big = 9007199254740991L }));
    }

    [Fact]
    public void Out_of_range_and_no_value_are_not_the_same_state()
    {
        // JSON turns a non-finite number into null, which would make a sensor reading out-of-range
        // and a sensor reading nothing the same reading.
        Assert.Equal(
            """["a",[["d","NaN"],["d","Infinity"],["d","-Infinity"]]]""",
            RpcCanonical.Text(new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity }));
    }

    [Fact]
    public void Bytes_are_bytes_rather_than_an_object_of_numeric_keys()
    {
        Assert.Equal("""["y",[1,2,255]]""", RpcCanonical.Text(new byte[] { 1, 2, 255 }));
    }

    [Fact]
    public void A_string_is_escaped_the_way_JavaScript_escapes_it_and_no_further()
    {
        // .NET's JSON writer escapes `<`, `>`, `&` and everything non-ASCII by default, which is
        // valid JSON and a different string - so a tag name with an umlaut would hash differently in
        // the two languages. This expectation came out of the TypeScript encoder.
        Assert.Equal(
            "[\"s\",\"a\\\"b\\\\\\nc\\\\ttab unicode-ü\"]",
            RpcCanonical.Text("a\"b\\\nc\\ttab unicode-ü"));
    }

    [Fact]
    public void An_empty_object_is_a_value_of_its_own()
    {
        Assert.Equal("""["o",[]]""", RpcCanonical.Text(new { }));
        Assert.NotEqual(RpcCanonical.Text(new { }), RpcCanonical.Text(Array.Empty<object>()));
    }

    [Fact]
    public void Two_callers_who_built_the_same_question_differently_ask_it_once()
    {
        // What the key is for. On the link this library was written for, asking twice is not an
        // inefficiency - it is a screen that takes twice as long to draw.
        var one = RpcQueryKey.For(new RpcQuestion("oven3", "plant", "readings", new { page = 0, size = 50, filter = RpcCanonical.Absent }));
        var two = RpcQueryKey.For(new RpcQuestion("oven3", "plant", "readings", new { size = 50, page = 0 }));
        Assert.Equal(one, two);
        Assert.NotEqual(one, RpcQueryKey.For(new RpcQuestion("oven3", "plant", "readings", new { page = 1, size = 50 })));
        Assert.NotEqual(one, RpcQueryKey.For(new RpcQuestion("oven4", "plant", "readings", new { page = 0, size = 50 })));
    }
}
