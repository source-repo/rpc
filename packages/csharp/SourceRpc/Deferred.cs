using System.Text.Json.Serialization;
using MessagePack;

namespace SourceRpc;

/// <summary>
/// The receipt a deferred method answers with: which call it belongs to, and how long the answer is
/// still expected.
///
/// The id is the *request's* correlation rather than something minted, which is what makes a
/// deferred reply unforgeable without anyone writing a check: a caller accepts one only for a call
/// it actually made, to the peer it made it to, and both are facts it already holds.
/// </summary>
[MessagePackObject]
public sealed record RpcTicketReceipt
{
    [JsonPropertyName("id")]
    [Key("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("expiresAt")]
    [Key("expiresAt")]
    public long ExpiresAt { get; init; }
}

/// <summary>
/// A method's promise to answer later, held by the method.
///
/// Returned from a responder in place of a value: the dispatcher sees it, answers the call at once
/// with a receipt, and sends whatever this produces afterwards down the same link. Progress may be
/// reported any number of times; resolving or rejecting ends it.
/// </summary>
public sealed class RpcDeferred<T>
{
    private readonly Func<string, object?, Task> _send;
    private int _settled;

    internal RpcDeferred(string id, DateTimeOffset expiresAt, Func<string, object?, Task> send)
    {
        _send = send;
        Receipt = new RpcTicketReceipt { Id = id, ExpiresAt = expiresAt.ToUnixTimeMilliseconds() };
    }

    /// <summary>What the caller is answered with now. Return it from the responder.</summary>
    public RpcTicketReceipt Receipt { get; }

    /// <summary>Report progress. May be called any number of times, and is ignored once settled.</summary>
    public Task ProgressAsync(object? value) => Volatile.Read(ref _settled) == 0 ? _send("progress", value) : Task.CompletedTask;

    /// <summary>Answer with the value. The first of resolve or reject wins; later calls do nothing.</summary>
    public Task ResolveAsync(T value) =>
        Interlocked.Exchange(ref _settled, 1) == 0 ? _send("resolved", value) : Task.CompletedTask;

    /// <summary>Answer with a failure. The first of resolve or reject wins.</summary>
    public Task RejectAsync(Exception error) =>
        Interlocked.Exchange(ref _settled, 1) == 0
            ? _send("rejected", new { name = error.GetType().Name, message = error.Message })
            : Task.CompletedTask;
}

/// <summary>
/// A deferred answer, held by the caller.
///
/// Deliberately not a `Task` itself. Awaiting the call gives you this handle - the receipt - and the
/// answer is <see cref="Result"/> on it. Collapsing the two would mean a caller could not see the
/// progress or the expiry, because awaiting would have skipped straight past them.
/// </summary>
public sealed class RpcTicket<T>
{
    private readonly TaskCompletionSource<T> _result = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal RpcTicket(string id, DateTimeOffset expiresAt)
    {
        Id = id;
        ExpiresAt = expiresAt;
    }

    /// <summary>The correlation of the call this answers, which is also the ticket's identity.</summary>
    public string Id { get; }

    /// <summary>When the far end stops expecting to answer.</summary>
    public DateTimeOffset ExpiresAt { get; }

    /// <summary>What the work produced, when it produces it.</summary>
    public Task<T> Result => _result.Task;

    private readonly List<object?> _early = [];
    private Action<object?>? _handlers;
    private bool _subscribed;

    /// <summary>
    /// Reported by the far end while the work runs.
    ///
    /// **Progress that arrived before anyone subscribed is replayed to the first subscriber.** A
    /// caller cannot attach a handler until it holds the ticket, and it cannot hold the ticket until
    /// the call has answered - so on a fast link the first progress is routinely already here by
    /// then. Without the replay it would be delivered to an empty event and silently lost, which is
    /// the same defect the TypeScript ticket registry has and the reason it is worth spelling out.
    /// </summary>
    public event Action<object?>? Progress
    {
        add
        {
            if (value is null)
                return;
            object?[] waiting;
            lock (_early)
            {
                _handlers += value;
                _subscribed = true;
                waiting = _early.ToArray();
                _early.Clear();
            }
            // To the handler that just arrived, and only it: the others were not there.
            foreach (var held in waiting)
                value(held);
        }
        remove
        {
            lock (_early)
                _handlers -= value;
        }
    }

    /// <summary>How much progress is held for a subscriber that has not arrived. Bounded, because one may never.</summary>
    private const int MaximumHeldProgress = 64;

    internal void OnProgress(object? value)
    {
        Action<object?>? handlers;
        lock (_early)
        {
            if (!_subscribed)
            {
                // Oldest first, because a caller arriving late wants where the work has got to
                // rather than where it began - and a job that reports for an hour must not grow
                // this without bound while nobody is listening.
                if (_early.Count >= MaximumHeldProgress)
                    _early.RemoveAt(0);
                _early.Add(value);
                return;
            }
            handlers = _handlers;
        }
        handlers?.Invoke(value);
    }

    internal void Resolve(T value) => _result.TrySetResult(value);

    internal void Reject(Exception error) => _result.TrySetException(error);
}
