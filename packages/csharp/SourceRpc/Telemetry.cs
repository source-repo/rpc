using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace SourceRpc;

/// <summary>
/// Counters, durations and spans, published through the BCL's own instruments.
///
/// Deliberately **not** an OpenTelemetry dependency. `System.Diagnostics.Metrics` and
/// `ActivitySource` are what OpenTelemetry itself listens to, so a host that wants traces adds
/// `.AddMeter("SourceRpc")` and `.AddSource("SourceRpc")` to its own exporter and
/// gets everything here - and a host that wants none pays for none, because an instrument nobody
/// records is a branch that is not taken. Inventing a metrics abstraction of our own would have
/// obliged every consumer to adapt it to whatever they already run.
///
/// What is measured is deliberately about frames and calls, never about their contents: a duration
/// and a method name are operational, an argument is plant data.
/// </summary>
public sealed class SourceRpcTelemetry : IDisposable
{
    /// <summary>The meter name to hand an exporter.</summary>
    public const string MeterName = "SourceRpc";

    /// <summary>The activity source name to hand an exporter.</summary>
    public const string ActivitySourceName = "SourceRpc";

    private readonly Meter _meter;

    /// <summary>Spans for one call, so an RPC can be followed into whatever it went on to do.</summary>
    public static readonly ActivitySource Source = new(ActivitySourceName);

    private readonly Counter<long> _calls;
    private readonly Counter<long> _errors;
    private readonly Counter<long> _framesReceived;
    private readonly Counter<long> _framesSent;
    private readonly Counter<long> _routingFailures;
    private readonly Counter<long> _rejected;
    private readonly Histogram<double> _duration;
    private int _connections;

    /// <summary>How many subscriptions are held. Set by the dispatcher, which is what knows.</summary>
    public Func<int> Subscriptions { get; set; } = () => 0;

    /// <summary>Creates the instruments. One per process; the DI registration makes it a singleton.</summary>
    public SourceRpcTelemetry()
    {
        _meter = new Meter(MeterName);
        _calls = _meter.CreateCounter<long>("rpc.calls", "{call}", "Calls dispatched to a responder.");
        _errors = _meter.CreateCounter<long>("rpc.errors", "{error}", "Calls answered with an error frame.");
        _framesReceived = _meter.CreateCounter<long>("rpc.frames.received", "{frame}", "Frames accepted from a connection.");
        _framesSent = _meter.CreateCounter<long>("rpc.frames.sent", "{frame}", "Frames put on a connection.");
        _routingFailures = _meter.CreateCounter<long>("rpc.routing.failures", "{frame}", "Frames that named a peer this hub cannot reach.");
        _rejected = _meter.CreateCounter<long>("rpc.frames.rejected", "{frame}", "Frames refused before dispatch.");
        _duration = _meter.CreateHistogram<double>("rpc.call.duration", "ms", "Wall time from dispatch to answer.");
        // Observable, because a count of live things is a level rather than an event: a gauge read
        // when somebody looks cannot drift the way an incremented counter can.
        _meter.CreateObservableGauge("rpc.connections", () => Volatile.Read(ref _connections), "{connection}", "Connections currently held.");
        // Set by whatever holds the subscriptions, so this stays free of what it is counting.
        _meter.CreateObservableGauge("rpc.subscriptions", () => Subscriptions(), "{subscription}", "Event subscriptions currently held.");
    }

    public void ConnectionOpened() => Interlocked.Increment(ref _connections);

    public void ConnectionClosed() => Interlocked.Decrement(ref _connections);

    public void FrameReceived(string kind) => _framesReceived.Add(1, new KeyValuePair<string, object?>("rpc.kind", kind));

    public void FrameSent(string kind) => _framesSent.Add(1, new KeyValuePair<string, object?>("rpc.kind", kind));

    public void FrameRejected(string reason) => _rejected.Add(1, new KeyValuePair<string, object?>("rpc.reason", reason));

    public void RoutingFailed() => _routingFailures.Add(1);

    /// <summary>
    /// One dispatched call, timed and tagged.
    ///
    /// Tagged with path and method but never with the caller's arguments or the answer - a
    /// dimension is a label on a time series, and plant data does not belong in one.
    /// </summary>
    public void CallCompleted(string path, string method, double milliseconds, RpcErrorCode? failure)
    {
        var tags = new TagList { { "rpc.path", path }, { "rpc.method", method } };
        _calls.Add(1, tags);
        _duration.Record(milliseconds, tags);
        if (failure is { } code)
        {
            tags.Add("rpc.code", code.ToString());
            _errors.Add(1, tags);
        }
    }

    public void Dispose() => _meter.Dispose();
}
