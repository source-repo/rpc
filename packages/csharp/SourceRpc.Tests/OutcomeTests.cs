using SourceRpc.Query;

namespace SourceRpc.Tests;

/// <summary>
/// What a failure means, and what a caller may do about it.
///
/// The rules are the library's rather than this binding's, so what these assert is agreement rather
/// than behaviour: a .NET peer that retried where a TypeScript peer would not is not a different
/// implementation, it is a different protocol.
/// </summary>
public class OutcomeTests
{
    /// <summary>
    /// Every code the TypeScript `RpcErrorCode` union has, spelled as it travels.
    ///
    /// Taken from `packages/rpc/src/RPC/Messages.ts` and kept here rather than derived, because a
    /// derivation would agree with whatever this enum happens to say - which is exactly the failure
    /// being tested for.
    /// </summary>
    private static readonly string[] OnTheWire =
    [
        "ClassNotFound", "MethodNotFound", "Exception", "Timeout", "TransportError", "Unauthorized",
        "Forbidden", "InvalidParams", "IncompatibleVersion", "UnknownOutcome", "Busy", "Superseded",
        "NotInControl", "OwnershipChanged"
    ];

    [Fact]
    public void Every_code_a_peer_can_send_is_read_as_itself()
    {
        // A code arrives as a string and is parsed by name; one this enum does not have falls back
        // to `Exception`, which says *the method ran and threw*. So a peer answering `NotInControl`,
        // `Busy` or `Superseded` - all of which certainly did not run - was telling a .NET caller
        // the opposite of what it meant, and `UnknownOutcome` was arriving as a definite failure.
        foreach (var code in OnTheWire)
            Assert.True(Enum.TryParse<RpcErrorCode>(code, ignoreCase: false, out _), $"a peer can answer '{code}' and this binding would read it as Exception");
    }

    [Fact]
    public void The_founding_distinction_survives_the_language_boundary()
    {
        // "It failed" invites a retry; "I do not know" says to go and look. For a non-repeatable
        // command that is the difference between one pump start and two.
        Assert.True(RpcOutcomes.MayHaveRun(RpcErrorCode.UnknownOutcome));
        Assert.True(RpcOutcomes.MayHaveRun(RpcErrorCode.Timeout));
        Assert.False(RpcOutcomes.MayHaveRun(RpcErrorCode.TransportError));

        Assert.True(RpcOutcomes.CertainlyDidNotRun(RpcErrorCode.TransportError));
        Assert.False(RpcOutcomes.CertainlyDidNotRun(RpcErrorCode.UnknownOutcome));
        // And an unclassified failure is neither: reading "not known to have run" as "known not to
        // have run" is how a second pump start happens.
        Assert.False(RpcOutcomes.CertainlyDidNotRun(RpcErrorCode.Exception));
        Assert.False(RpcOutcomes.MayHaveRun(RpcErrorCode.Exception));
    }

    [Fact]
    public void An_unclassified_exception_is_unknown_which_is_the_safe_reading()
    {
        Assert.True(RpcOutcomes.MayHaveRun(new InvalidOperationException("something threw on the way to the wire")));
        Assert.True(RpcOutcomes.MayHaveRun((Exception?)null));
    }

    [Fact]
    public void A_refusal_is_not_a_failure_and_asking_again_only_gets_it_again()
    {
        foreach (var code in new[]
                 {
                     RpcErrorCode.Unauthorized, RpcErrorCode.Forbidden, RpcErrorCode.ClassNotFound,
                     RpcErrorCode.MethodNotFound, RpcErrorCode.InvalidParams, RpcErrorCode.IncompatibleVersion,
                     RpcErrorCode.Superseded, RpcErrorCode.OwnershipChanged, RpcErrorCode.NotInControl
                 })
            Assert.True(RpcOutcomes.IsTerminalRefusal(code), code.ToString());

        // Busy means the mailbox was full and the call certainly did not run, which is the one
        // refusal genuinely worth waiting out.
        Assert.False(RpcOutcomes.IsTerminalRefusal(RpcErrorCode.Busy));
        Assert.True(RpcOutcomes.CertainlyDidNotRun(RpcErrorCode.Busy));
    }

    [Fact]
    public void Nothing_is_retried_unless_the_caller_said_what_the_method_does()
    {
        // Undeclared means undeclared. The alternative is that the first caller who forgets the
        // annotation gets automatic retries on Dispense(), and finds out how many by counting what
        // came out of the machine.
        Assert.False(RpcOutcomes.IsRepeatable(null));
        Assert.False(RpcOutcomes.IsRepeatable(RpcMethodSemantics.NonRepeatableCommand));
        Assert.True(RpcOutcomes.IsRepeatable(RpcMethodSemantics.Query));
        Assert.True(RpcOutcomes.IsRepeatable(RpcMethodSemantics.IdempotentCommand));
    }

    [Fact]
    public void A_command_that_certainly_did_not_run_may_still_be_sent_again()
    {
        // The rule that is easy to get wrong in the conservative direction: a non-repeatable command
        // the transport refused has had no effect to repeat, so refusing to retry it would make the
        // safest possible failure the one that stops a plant.
        var refused = new SourceRpcException(RpcErrorCode.TransportError, "not connected");
        var lost = new SourceRpcException(RpcErrorCode.UnknownOutcome, "the link went while it was out there");
        var denied = new SourceRpcException(RpcErrorCode.Forbidden, "no");

        Assert.True(RpcOutcomes.MayRetry(refused, RpcMethodSemantics.NonRepeatableCommand));
        Assert.True(RpcOutcomes.MayRetry(refused, null));
        Assert.False(RpcOutcomes.MayRetry(lost, RpcMethodSemantics.NonRepeatableCommand));
        Assert.False(RpcOutcomes.MayRetry(lost, null));
        Assert.True(RpcOutcomes.MayRetry(lost, RpcMethodSemantics.Query));
        Assert.False(RpcOutcomes.MayRetry(denied, RpcMethodSemantics.Query));
        Assert.False(RpcOutcomes.MayRetry(new InvalidOperationException("not ours"), RpcMethodSemantics.Query));
    }
}
