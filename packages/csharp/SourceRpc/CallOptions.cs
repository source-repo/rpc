namespace SourceRpc;

/// <summary>
/// What a caller asks for beyond the arguments: how long it will wait, and which of the framework's
/// safety semantics this particular call is claiming.
///
/// These fields already travelled - the dispatcher on the other side reads `ttl`, `idem`, `fence`
/// and `ver` and acts on every one - but a C# caller had no way to *set* them. So a .NET peer could
/// enforce the semantics and not request them, which is half a framework: the process that most
/// wants an owner fence is the one issuing the command, not the one receiving it.
///
/// Every field is optional and absent means "no claim". A key on a call this peer cannot repeat
/// safely is worth more than all the rest put together.
/// </summary>
public sealed record RpcCallOptions
{
    /// <summary>
    /// How long this caller will wait. Travels as `ttl` and arms the local timer with the same
    /// number, so what the far end is told is exactly what the caller is going to do.
    /// </summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>
    /// Names the command this is an attempt at, so a retry is answered from the record rather than
    /// run a second time.
    ///
    /// Send one whenever repeating the command would do something twice. The target refuses the
    /// call with <see cref="RpcErrorCode.IdempotencyUnavailable"/> if it has no store to honour it
    /// with, which is the answer that tells a caller the guard is not there - rather than silently
    /// proceeding without it.
    /// </summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>
    /// The owner generation this caller observed for the instance it is addressing.
    ///
    /// The target compares it with its own record and refuses <see cref="RpcErrorCode.OwnershipChanged"/>
    /// on any difference, including when it holds no record at all. That is the point: a command
    /// issued under an ownership that has since moved must not run, and the caller cannot detect
    /// the move on its own.
    /// </summary>
    public string? OwnerFence { get; init; }

    /// <summary>The contract version this caller was written against.</summary>
    public string? ContractVersion { get; init; }
}
