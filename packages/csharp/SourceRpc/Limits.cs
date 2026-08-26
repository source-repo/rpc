namespace SourceRpc;

/// <summary>
/// What this peer will accept, and how much of it at once.
///
/// Every one of these was previously unbounded, which is the same as trusting whoever is on the
/// other end to be reasonable. Two different things go wrong without them: hostile traffic, and the
/// ordinary accident of a relay loop or an event storm - and the second is far more likely. A limit
/// that refuses is visible; memory quietly filling is not.
/// </summary>
public sealed record RpcLimits
{
    /// <summary>
    /// How many relays a frame may pass through before it is refused.
    ///
    /// A hub increments `hops` when it forwards. Without a ceiling, two peers each relaying for the
    /// other pass one frame back and forth for as long as the process lives.
    /// </summary>
    public int MaxHops { get; set; } = 8;

    /// <summary>How many frames one batch may carry.</summary>
    public int MaxBatchItems { get; set; } = 256;

    /// <summary>
    /// How deeply batches may nest. One, meaning a batch may not contain a batch: nesting buys
    /// nothing and unpacking it recursively is an invitation to a frame shaped like a fork bomb.
    /// </summary>
    public int MaxBatchDepth { get; set; } = 1;

    /// <summary>How long a path, method or correlation may be. Longer is a mistake or a probe.</summary>
    public int MaxIdentifierLength { get; set; } = 256;

    /// <summary>
    /// How many calls this peer will run at once before it starts refusing.
    ///
    /// Dispatch is deliberately not awaited by the transports - a responder that calls another peer
    /// must be able to receive the reply - and unbounded fire-and-forget is the cost of that: a
    /// burst becomes as many concurrent responder invocations as arrive, with no signal that
    /// anything is wrong until memory says so. Refusing with <see cref="RpcErrorCode.Busy"/> tells
    /// a caller something it can act on.
    /// </summary>
    public int MaxConcurrentCalls { get; set; } = 64;
}
