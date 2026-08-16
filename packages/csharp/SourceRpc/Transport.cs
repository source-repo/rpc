namespace SourceRpc;

/// <summary>
/// One link to a Source RPC network, whatever is carrying it.
///
/// This is the seam the whole package is arranged around. A frame carries its own `src` and `tgt`,
/// so nothing above this interface needs to know how a message is addressed - and everything a
/// binding has to do is put a frame somewhere and hand back the ones that arrive. SignalR names a
/// message with a hub method, socket.io with an event, MQTT with a topic; none of that reaches the
/// dispatcher, the client or an application's own code.
///
/// A binding therefore implements two methods and an event. What it must **not** do is interpret a
/// frame: kinds, correlation, subscriptions and errors belong to <see cref="RpcDispatcher"/> and
/// <see cref="SourceRpcClient"/>, so that they behave identically over every carrier rather than
/// three times approximately.
/// </summary>
public interface ISourceRpcTransport : IAsyncDisposable
{
    /// <summary>The peer name this link announces itself under.</summary>
    string Name { get; }

    /// <summary>Whether the link is currently usable. A send on a dead link throws rather than being discarded.</summary>
    bool Connected { get; }

    /// <summary>Bring the link up, and keep it up. Implementations retry rather than failing once.</summary>
    Task StartAsync(CancellationToken cancellationToken = default);

    /// <summary>Put one frame on the link.</summary>
    Task SendAsync(RpcFrame frame, CancellationToken cancellationToken = default);

    /// <summary>
    /// A frame arrived.
    ///
    /// An event rather than a callback in the constructor, so a transport can be built before
    /// whatever will consume it exists - which is the ordinary case when a container assembles both.
    /// </summary>
    event Func<RpcFrame, Task>? FrameReceived;

    /// <summary>Who else is on the network, as the far end reports it. Absent on carriers with no presence.</summary>
    event Action<IReadOnlyCollection<string>>? PeersChanged;

    /// <summary>
    /// The link came up - the first time, and after every drop.
    ///
    /// A binding cannot keep this to itself, because what is lost when a link drops is not only the
    /// link: a peer's subscriptions live on its connection at the far end, and a reconnect is a
    /// peer that end has never met. Without this signal a reconnected client looks healthy and
    /// silently never receives another event, which is the hardest failure to notice in a running
    /// plant. <see cref="SourceRpcClient"/> uses it to take its subscriptions out again.
    /// </summary>
    event Func<Task>? LinkEstablished;
}

/// <summary>
/// What a binding needs in order to be one, gathered so that a new transport is a small class
/// rather than an archaeology exercise.
///
/// Written down because three more bindings are expected - a C# socket.io client, an MQTT one, and
/// whatever a device needs - and the failure mode for each is the same: reimplementing correlation
/// or subscription handling slightly differently, so that a call behaves one way over SignalR and
/// another over MQTT. That is what this package exists to prevent, having already prevented it once
/// on the TypeScript side.
///
/// A binding must:
///
/// - **Carry a frame whole.** Every field in <see cref="RpcFrame"/> travels or the protocol is not
///   being spoken. The fields that are easy to lose are the ones a receiver acts on rather than
///   merely forwards: `fence`, `deferred`, `outcome`, `seq` and `epoch`. Losing a fence does not
///   weaken the check, it removes it.
/// - **Not invent addressing.** `src` and `tgt` are in the frame. A carrier with its own addressing
///   - an MQTT topic, say - may use it as well, and must not use it *instead*.
/// - **Report a refusal.** A frame that cannot be read is announced, never dropped: silence reaches
///   a caller as a timeout, which is indistinguishable from a slow method.
/// - **Fail a send loudly.** A send on a link that is down throws, so the call it belongs to fails
///   now rather than waiting out its deadline for a frame that was never going to leave.
/// - **Keep trying.** A link that drops comes back without anyone restarting anything, and so does
///   one that was never up - a peer may start before the thing it connects to.
/// </summary>
public static class TransportContract
{
    /// <summary>The frame version this package speaks. A frame announcing anything else is refused.</summary>
    public const int FrameVersion = 2;

    /// <summary>What a frame is called on a carrier that names its messages: an event, a hub method, a topic segment.</summary>
    public const string FrameName = "frame";

    /// <summary>What a presence announcement is called, on carriers that have one.</summary>
    public const string PresenceName = "presence";
}
