using System.Security.Claims;

namespace SourceRpc;

/// <summary>
/// What a caller asked for, with the wire format already dealt with.
///
/// This is the type application code sees. It exists because the alternative - handing a responder
/// the <see cref="RpcFrame"/> - couples every method in an application to the transport's own
/// representation: a frame's `Body` is a `JsonElement` under one hub protocol and boxed primitives
/// under the other, its `Ttl` is a duration measured from a moment the receiver never saw, and its
/// `Src` is a claim until something checks it. Those are the library's problems, and a method that
/// has to know about them is a method that breaks when any of them changes.
/// </summary>
public sealed class RpcInvocation
{
    /// <summary>The exposed instance the caller addressed.</summary>
    public required string Path { get; init; }

    /// <summary>The method on it.</summary>
    public required string Method { get; init; }

    /// <summary>
    /// The peer that called, already checked against what its connection is entitled to claim.
    ///
    /// Unlike the frame field it comes from, this is not merely asserted: a connection may only
    /// originate frames for identities it announced or advertised as carried, so by the time an
    /// invocation exists this name has been vouched for as far as the hub's configuration allows.
    /// With authentication configured that is as far as the authenticated principal; without it, as
    /// far as "the connection that first claimed this name".
    /// </summary>
    public required string Source { get; init; }

    /// <summary>This process's own peer name - the target the caller addressed.</summary>
    public required string Target { get; init; }

    /// <summary>The authenticated principal behind the calling connection, when the hub authenticates.</summary>
    public ClaimsPrincipal? User { get; init; }

    /// <summary>
    /// When the caller stops waiting, or null if it named no deadline.
    ///
    /// A moment rather than the duration the wire carries, because the conversion needs the arrival
    /// time and the library is what has it. A duration travels - clocks between two machines cannot
    /// be compared - and is turned into a local deadline here, so a method can simply ask whether it
    /// still has time.
    /// </summary>
    public DateTimeOffset? Deadline { get; init; }

    /// <summary>
    /// The owner generation the caller observed, when it fenced the call.
    ///
    /// If this process keeps any record of who owns <see cref="Path"/>, compare it and throw
    /// <see cref="SourceRpcException"/> with <see cref="RpcErrorCode.OwnershipChanged"/> on any
    /// difference - including when no record is held, which fails closed. A fence is checked by
    /// being present, so ignoring one is not a weaker check but no check at all, and the caller
    /// cannot tell that from a successful call.
    /// </summary>
    public string? Fence { get; init; }

    /// <summary>Names the command this is an attempt at, when the caller distinguishes the two.</summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>The frame this came from, for anything the shape above does not cover.</summary>
    public required RpcFrame Frame { get; init; }

    /// <summary>How a later answer reaches this caller. Set by the dispatcher; null when the binding offers none.</summary>
    internal Func<RpcFrame, Task>? Reply { get; init; }

    /// <summary>
    /// Answer this call later, down the same link.
    ///
    /// Return the deferred's <see cref="RpcDeferred{T}.Receipt"/> from the responder and the caller
    /// is told at once that an answer is coming; resolve, reject or report progress on the deferred
    /// afterwards, from whatever is doing the work.
    ///
    /// The ticket's id is this call's own correlation, so nothing is minted and nothing extra
    /// travels - and a caller accepts the later answer only for a call it actually made, to the
    /// peer it made it to, which is what makes a forged result have nothing to attach itself to.
    /// </summary>
    public RpcDeferred<T> Defer<T>(TimeSpan? expiresIn = null)
    {
        if (Reply is null)
            throw new SourceRpcException(
                RpcErrorCode.Exception,
                "this call arrived over a link that cannot deliver a later answer, so it cannot be deferred");

        var correlation = Frame.Corr ?? "";
        var expiresAt = DateTimeOffset.UtcNow + (expiresIn ?? TimeSpan.FromMinutes(5));
        var reply = Reply;
        var frame = Frame;
        return new RpcDeferred<T>(correlation, expiresAt, (outcome, value) =>
            reply(new RpcFrame
            {
                Src = frame.Tgt,
                Tgt = frame.Src,
                Kind = "ticket",
                Corr = correlation,
                Outcome = outcome,
                Body = value
            }));
    }

    /// <summary>
    /// The argument at <paramref name="index"/>, converted, whichever hub protocol delivered it.
    ///
    /// Missing, out of range or not convertible all answer <c>default</c> rather than throwing: a
    /// caller that sent the wrong thing should get a domain error from the method it called, not a
    /// cast exception from the plumbing.
    /// </summary>
    public T? Arg<T>(int index) => Frame.Arg<T>(index);

    /// <summary>How many arguments the call carried, for a method that takes a variable number.</summary>
    public int ArgCount => Frame.ArgCount;

    /// <summary>Whether the caller's deadline has already passed, for a method about to do slow work.</summary>
    public bool Expired => Deadline is { } deadline && DateTimeOffset.UtcNow > deadline;
}

/// <summary>
/// What this process exposes to a Source RPC network.
///
/// One method, because the wire format has one shape: a call names an instance and a method and
/// carries an argument array. Register an implementation with
/// <c>services.AddSourceRpc(…).AddResponder&lt;T&gt;()</c> and it is constructed by the container
/// like any other service, so it may take a logger, a PLC client or anything else it needs.
/// </summary>
public interface ISourceRpcResponder
{
    /// <summary>
    /// Run a method and answer with its result.
    ///
    /// Throw <see cref="SourceRpcException"/> to choose the error code a caller sees. Any other
    /// exception becomes <see cref="RpcErrorCode.Exception"/>, and its message does **not** travel
    /// unless the host opts in - see <c>SourceRpcOptions.IncludeExceptionDetail</c>.
    ///
    /// The token is cancelled when the calling connection goes away or the host shuts down, so a
    /// method doing slow work has something to observe rather than finishing into a void.
    /// </summary>
    ValueTask<object?> InvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default);
}

/// <summary>
/// The error codes a caller understands, which are the library's rather than this binding's: they
/// are what a TypeScript peer turns back into a typed rejection, so the strings matter.
/// </summary>
public enum RpcErrorCode
{
    /// <summary>No instance of that name is served here.</summary>
    ClassNotFound,

    /// <summary>The instance is here and has no such method.</summary>
    MethodNotFound,

    /// <summary>The method ran and threw. The default for anything not otherwise classified.</summary>
    Exception,

    /// <summary>The caller's deadline had passed before the method could run.</summary>
    Timeout,

    /// <summary>The frame could not be delivered - no route, or nothing listening.</summary>
    TransportError,

    /// <summary>The caller is not authenticated.</summary>
    Unauthorized,

    /// <summary>The caller is authenticated and not permitted this.</summary>
    Forbidden,

    /// <summary>The arguments were not what the method needs.</summary>
    InvalidParams,

    /// <summary>
    /// The call carried an owner fence and this process's record of the owner is a different
    /// generation. It certainly did not run, and it must not be blindly retried.
    /// </summary>
    OwnershipChanged
}

/// <summary>
/// An error a caller is meant to see, with the code it should act on.
///
/// The distinction this draws is the point of it: an exception a method throws deliberately carries
/// a message written for whoever reads it, and an exception that escaped carries whatever the CLR
/// or a vendor library put in it - a file path, a connection string, the innards of a COM error.
/// The first travels; the second does not, unless the host says otherwise.
/// </summary>
public sealed class SourceRpcException : Exception
{
    /// <summary>The code the caller receives.</summary>
    public RpcErrorCode Code { get; }

    /// <summary>Creates an error a caller is meant to see, with the code it should act on.</summary>
    public SourceRpcException(RpcErrorCode code, string message, Exception? inner = null)
        : base(message, inner) => Code = code;

    /// <summary>No instance of that name is served here.</summary>
    public static SourceRpcException NotFound(string path) =>
        new(RpcErrorCode.ClassNotFound, $"no instance named '{path}' is served here");

    /// <summary>The instance is here and has no such method.</summary>
    public static SourceRpcException NoSuchMethod(string path, string method) =>
        new(RpcErrorCode.MethodNotFound, $"'{path}' has no method '{method}'");

    /// <summary>The arguments were not what the method needs.</summary>
    public static SourceRpcException InvalidParams(string message) =>
        new(RpcErrorCode.InvalidParams, message);

    /// <summary>The caller is authenticated and not permitted this.</summary>
    public static SourceRpcException Forbidden(string message) =>
        new(RpcErrorCode.Forbidden, message);
}
