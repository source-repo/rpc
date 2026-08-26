using System.Security.Claims;

namespace SourceRpc;

/// <summary>
/// What an authenticated peer is allowed to do, which is a different question from who it is.
///
/// Pinning a peer's name to its authenticated identity says the name is not a lie. It does not say
/// the peer may *use* that name for everything it is asking for - and the gap shows most clearly at
/// a bridge, which announces the peers behind it. An authenticated bridge could advertise any names
/// it liked, bounded only by a count, and those names then became addresses only it may originate
/// for. Authentication answers "is this really you"; this answers "and may you".
///
/// Subscriptions are here as well as calls, deliberately. A method can be write-protected while the
/// events from the same instance carry the production data the method would have returned, and a
/// model that authorises only calls leaves that open.
/// </summary>
public interface ISourceRpcAuthorization
{
    /// <summary>May this connection announce itself under this name?</summary>
    ValueTask<bool> CanAnnounceAsync(ClaimsPrincipal? principal, string peer, CancellationToken cancellationToken = default);

    /// <summary>
    /// May this bridge carry frames for this other peer?
    ///
    /// Answered per carried name rather than for the list, because a bridge legitimately carrying
    /// one cell should not thereby be able to speak for another.
    /// </summary>
    ValueTask<bool> CanCarryAsync(ClaimsPrincipal? principal, string bridge, string carried, CancellationToken cancellationToken = default);

    /// <summary>May this caller invoke this method?</summary>
    ValueTask<bool> CanInvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default);

    /// <summary>May this caller watch this event?</summary>
    ValueTask<bool> CanSubscribeAsync(string caller, ClaimsPrincipal? principal, string path, string eventName, CancellationToken cancellationToken = default);
}

/// <summary>
/// Allows everything, which is what a network with no policy configured already did.
///
/// Present so the seam exists and the default is written down rather than implied by the absence of
/// a check. A plant supplies its own.
/// </summary>
public sealed class AllowAllAuthorization : ISourceRpcAuthorization
{
    public ValueTask<bool> CanAnnounceAsync(ClaimsPrincipal? principal, string peer, CancellationToken cancellationToken = default) => new(true);

    public ValueTask<bool> CanCarryAsync(ClaimsPrincipal? principal, string bridge, string carried, CancellationToken cancellationToken = default) => new(true);

    public ValueTask<bool> CanInvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default) => new(true);

    public ValueTask<bool> CanSubscribeAsync(string caller, ClaimsPrincipal? principal, string path, string eventName, CancellationToken cancellationToken = default) => new(true);
}
