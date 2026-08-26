using System.Collections.Concurrent;
using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// A transport that goes nowhere, so a client's own bookkeeping can be examined.
///
/// It answers every request immediately and records what was sent. That is enough for the questions
/// these tests ask - how many remote subscribes went out, whether an unsubscribe followed a dispose,
/// what happens when the link comes back - none of which are visible from the far end of a real one.
/// </summary>
public sealed class FakeTransport(string name) : ISourceRpcTransport
{
    public string Name { get; } = name;
    public bool Connected { get; set; } = true;

    public event Func<RpcFrame, Task>? FrameReceived;
    public event Action<IReadOnlyCollection<string>>? PeersChanged;
    public event Func<Task>? LinkEstablished;

    /// <summary>How to answer a request, for a test that needs something other than a bare "ok".</summary>
    public Func<RpcFrame, RpcFrame>? Answer { get; set; }

    /// <summary>Everything this transport was asked to send, in order.</summary>
    public ConcurrentQueue<RpcFrame> Sent { get; } = new();

    public List<RpcFrame> SentOfKind(string kind) => Sent.Where(frame => frame.Kind == kind).ToList();

    public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task SendAsync(RpcFrame frame, CancellationToken cancellationToken = default)
    {
        if (!Connected)
            throw new SourceRpcException(RpcErrorCode.TransportError, "not connected");
        Sent.Enqueue(frame);

        // Answered on another thread, the way a real one does: the client registers its pending
        // exchange before awaiting, and completing inline would hide an ordering mistake there.
        if (frame.Kind is "call" or "subscribe" or "unsubscribe")
            _ = Task.Run(() => Receive(Answer?.Invoke(frame) ?? new RpcFrame
            {
                Src = frame.Tgt,
                Tgt = frame.Src,
                Kind = "result",
                Corr = frame.Corr,
                Body = "ok"
            }));
        return Task.CompletedTask;
    }

    /// <summary>Deliver a frame as though it had arrived from the far end.</summary>
    public Task Receive(RpcFrame frame) => FrameReceived?.Invoke(frame) ?? Task.CompletedTask;

    /// <summary>The link came back, and the far end has forgotten this peer.</summary>
    public Task Reconnect() => LinkEstablished?.Invoke() ?? Task.CompletedTask;

    public void AnnouncePeers(IReadOnlyCollection<string> peers) => PeersChanged?.Invoke(peers);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
