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
