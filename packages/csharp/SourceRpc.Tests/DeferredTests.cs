using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// What happens to a deferred answer when it does not arrive.
///
/// The happy path was covered by the interop suite from the start. These are the ways it ends
/// without one - an expiry that passes, a link that closes - each of which used to leave a caller
/// awaiting `Result` for the life of the process.
/// </summary>
public class DeferredTests
{
    private sealed class Deferring(Func<RpcInvocation, object?> handle) : ISourceRpcResponder
    {
        public ValueTask<object?> InvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(handle(invocation));
    }

    [Fact]
    public async Task A_ticket_whose_expiry_passes_ends_as_unknown_rather_than_waiting_for_ever()
    {
        var options = new SourceRpcOptions { Name = "hmi", CallTimeout = TimeSpan.FromSeconds(5) };
        var transport = new FakeTransport("hmi");
        await using var client = new SourceRpcClient(transport, options, new SourceRpcTelemetry());

        // The far end answers with a receipt that has already expired: the peer died, or the work
        // ran past what it promised. Either way nothing more is coming.
        transport.Answer = frame => new RpcFrame
        {
            Src = frame.Tgt,
            Tgt = frame.Src,
            Kind = "result",
            Corr = frame.Corr,
            Deferred = true,
            Body = new RpcTicketReceipt { Id = frame.Corr!, ExpiresAt = DateTimeOffset.UtcNow.AddMilliseconds(150).ToUnixTimeMilliseconds() }
        };

        var ticket = await client.CallDeferredAsync<string>("plant", "meter", "slow");
        var failed = await Assert.ThrowsAsync<SourceRpcException>(() => ticket.Result);

        // Not Timeout: the command may well have run, and telling a caller "it failed" invites the
        // retry that a non-repeatable command must not get.
        Assert.Equal(RpcErrorCode.UnknownOutcome, failed.Code);
    }

    [Fact]
    public async Task Closing_the_client_ends_a_ticket_that_is_still_waiting()
    {
        var options = new SourceRpcOptions { Name = "hmi", CallTimeout = TimeSpan.FromSeconds(5) };
        var transport = new FakeTransport("hmi");
        var client = new SourceRpcClient(transport, options, new SourceRpcTelemetry());

        transport.Answer = frame => new RpcFrame
        {
            Src = frame.Tgt,
            Tgt = frame.Src,
            Kind = "result",
            Corr = frame.Corr,
            Deferred = true,
            Body = new RpcTicketReceipt { Id = frame.Corr!, ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds() }
        };

        var ticket = await client.CallDeferredAsync<string>("plant", "meter", "slow");
        await client.DisposeAsync();

        var failed = await Assert.ThrowsAsync<SourceRpcException>(() => ticket.Result);
        Assert.Equal(RpcErrorCode.UnknownOutcome, failed.Code);
    }

    /// <summary>
    /// The gap named as still open when the six correctness fixes landed: a deferred command held
    /// its idempotency claim after the ticket settled, so the key never became usable again.
    /// </summary>
    [Fact]
    public async Task A_deferred_command_records_its_outcome_against_the_idempotency_key()
    {
        var store = new InMemoryIdempotencyStore();
        RpcDeferred<string>? deferred = null;
        var dispatcher = new RpcDispatcher(
            new SourceRpcOptions { Name = "plant" },
            new SubscriptionTable(),
            new SourceRpcTelemetry(),
            new Deferring(invocation => (deferred = invocation.Defer<string>()).Receipt),
            null,
            null,
            store);

        var frame = new RpcFrame
        {
            Src = "hmi", Tgt = "plant", Kind = "call", Corr = "c-1",
            Path = "meter", Method = "slow", Idem = "pour-1", Body = Array.Empty<object?>()
        };
        var receipt = await dispatcher.HandleAsync(frame, new RpcCaller("hmi", null, CancellationToken.None, _ => Task.CompletedTask));
        Assert.True(receipt!.Deferred);

        // While it is running, a retry is dropped rather than run a second time.
        Assert.IsType<RpcIdempotencyClaim.InProgress>(await store.BeginAsync("pour-1"));

        await deferred!.ResolveAsync("poured");

        // And once it has answered, the retry is answered from the record - which is the half that
        // was missing: the claim used to be held for ever.
        var completed = Assert.IsType<RpcIdempotencyClaim.Completed>(await store.BeginAsync("pour-1"));
        Assert.Equal("poured", completed.Outcome.Value);
    }
}
