namespace SourceRpc;

/// <summary>
/// How this process appears on a Source RPC network, and what it will and will not say.
///
/// In the core rather than in a binding, because every one of these means the same thing over every
/// carrier: a peer's name is its name whether it arrived over SignalR or a broker, and a decision
/// about disclosing exception detail should not be one a deployment makes three times.
/// </summary>
public sealed class SourceRpcOptions
{
    /// <summary>The peer name this process answers to. Required.</summary>
    public string Name { get; set; } = "";

    /// <summary>
    /// How long a call this process *makes* waits before giving up.
    ///
    /// Travels with the call as its `ttl`, so the far end knows what it is working against and can
    /// refuse work that is already too late rather than doing it for nobody.
    /// </summary>
    public TimeSpan CallTimeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Register the MessagePack hub protocol alongside JSON, where the carrier has protocols.
    ///
    /// On by default because it costs a client nothing - the two are negotiated - and it is the only
    /// one that carries binary in a payload as binary rather than base64 text.
    /// </summary>
    public bool UseMessagePack { get; set; } = true;

    /// <summary>
    /// How many peers one link may claim to carry, so a neighbour cannot flood this process's
    /// routing table by advertising a large number of names.
    /// </summary>
    public int MaximumCarriedPeers { get; set; } = 1000;

    /// <summary>
    /// Send the message of an *unhandled* exception to the caller.
    ///
    /// Off by default, and that default is a security decision rather than tidiness. A
    /// <see cref="SourceRpcException"/> carries a message somebody wrote for whoever reads it and
    /// always travels; an exception that merely escaped carries whatever the CLR or a vendor library
    /// put in it - a file path, a connection string, the innards of a COM error - and a plant
    /// network is not the place to publish it. The real exception is logged either way.
    /// </summary>
    public bool IncludeExceptionDetail { get; set; }

    /// <summary>
    /// Require that a frame's `src` matches the link's authenticated identity, where the carrier
    /// authenticates.
    ///
    /// Separate from authentication itself because a link may be authenticated for reasons of its
    /// own - a shared gateway credential, say - and still carry several peer names, which is what a
    /// bridge is.
    /// </summary>
    public bool PinSourceToAuthenticatedIdentity { get; set; } = true;

    /// <summary>Delays before each attempt to (re)connect, in milliseconds. The last is repeated for ever.</summary>
    public int[] ReconnectDelaysMs { get; set; } = [0, 2000, 5000, 10000, 30000];
}

/// <summary>
/// What a caller can say about one call, beyond which method it is.
///
/// Three fields the frame has always carried and no caller here could set, which is why they arrive
/// together: a .NET peer could not name a command, could not fence one, and could not declare a
/// deadline other than the process-wide one. The first two are what make a *retry* safe rather than
/// a second command, so a resilience policy built without them would be a policy for doing a thing
/// twice.
/// </summary>
public sealed record RpcCallOptions
{
    /// <summary>
    /// Names the command, so a second attempt at it is recognised as the same one.
    ///
    /// The case this exists for: an operator presses "start pump", the answer is
    /// <see cref="RpcErrorCode.UnknownOutcome"/>, and they press it again. Without a key those are
    /// two commands and a peer with a durable idempotency store will run both; with one they are two
    /// attempts at a command that runs once, and the second is answered from the record.
    ///
    /// It has to come from whatever identifies the intent - a work order, a batch step, a button
    /// press. A value generated per *attempt* defeats the purpose, since that is what the
    /// correlation id already is.
    /// </summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>
    /// How long this call waits, overriding <see cref="SourceRpcOptions.CallTimeout"/>. The same
    /// number becomes the transmitted ttl, so what the far end is told is exactly what this caller
    /// is going to do.
    ///
    /// **What a retry policy recomputes.** A deadline is a budget across every attempt, not a fresh
    /// clock for each: three attempts under a "ten second timeout" that each restart it is a caller
    /// waiting thirty seconds having asked for ten. See `SourceRpc.Query`.
    /// </summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>
    /// Fence this call on the target's owner generation, as this caller last observed it.
    ///
    /// Reassign the owner and the call is refused <see cref="RpcErrorCode.OwnershipChanged"/> - the
    /// in-flight half of what a lease check on the far end cannot see, since that asks *who holds it
    /// now* and never *is this the generation the caller decided under*.
    /// </summary>
    public string? OwnerEpoch { get; init; }
}
