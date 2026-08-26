namespace SourceRpc;

/// <summary>
/// How this process tells the network something happened.
///
/// Inject it wherever something happens worth telling anyone about:
///
/// <code>
/// public sealed class BuildWatcher(ISourceRpcEvents events)
/// {
///     private Task OnBuildFinished(bool succeeded) => events.EmitAsync("solution", "built", succeeded);
/// }
/// </code>
///
/// An interface rather than the implementation, so a consumer can substitute it in a test and so
/// that how events are distributed - one hub today, something with more than one process behind it
/// later - can change without touching application code.
/// </summary>
public interface ISourceRpcEvents
{
    /// <summary>
    /// Emit one event from an exposed instance to whoever subscribed.
    ///
    /// Counted whether or not anyone is listening, which is the whole point of the sequence a
    /// subscriber receives: one that joins late wants to know how many went past while it was away,
    /// and a counter that stood still cannot tell it.
    /// </summary>
    Task EmitAsync(string path, string eventName, params object?[] args);

    /// <summary>As <see cref="EmitAsync(string, string, object?[])"/>, with cancellation.</summary>
    Task EmitAsync(string path, string eventName, object?[] args, CancellationToken cancellationToken);

    /// <summary>Where the count for one event has reached, for a caller that wants a cursor.</summary>
    long SequenceOf(string path, string eventName);

    /// <summary>This process's incarnation, which a sequence only orders within.</summary>
    string Epoch { get; }
}
