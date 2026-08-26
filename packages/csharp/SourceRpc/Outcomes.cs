namespace SourceRpc;

/// <summary>
/// What a method does to the world, which decides what a caller may do about an uncertain answer.
///
/// Most RPC systems make it easy to call a function and leave this to prose. On a plant it is the
/// distinction that matters: retrying a read costs a round trip, and retrying a start costs a
/// second start.
///
/// **This binding does not yet declare or transmit it** - see the README's gap list - so it is the
/// *caller's* statement about a method it is about to call, used to decide whether a failure may be
/// sent again. Which is the same shape the TypeScript client is in: a client holds no schema, and
/// the rule there is that the running class beats the schema for this question anyway. It is spelled
/// here rather than in the adapter because it is the library's vocabulary, and two spellings of it
/// would be two answers to one question.
/// </summary>
public enum RpcMethodSemantics
{
    /// <summary>Changes nothing, so it can be repeated at will.</summary>
    Query,

    /// <summary>
    /// Changes something, but arriving twice leaves the same state as arriving once -
    /// `SetSetpoint(1200)`, `Close()`, anything that assigns rather than accumulates.
    /// </summary>
    IdempotentCommand,

    /// <summary>
    /// Must not be sent again on an uncertain answer, because a second arrival is a second effect -
    /// `Dispense()`, `AdvanceBatch()`, `ResetTotaliser()`.
    /// </summary>
    NonRepeatableCommand
}

/// <summary>
/// What a failure means, and what a caller may do about it.
///
/// **One of the four things this library specifies once and implements twice** - with the canonical
/// key encoder, the freshness state machine and the deadline arithmetic. None of them is a fact
/// about the network, so each can differ per language only by being wrong: a .NET peer that retried
/// where a TypeScript peer would not is not a different implementation, it is a different protocol.
///
/// It is here in the core rather than in the resilience adapter because it is not about Polly. A
/// caller writing a bare `catch` needs the same answer the pipeline does.
/// </summary>
public static class RpcOutcomes
{
    /// <summary>
    /// Whether the call **may have run**, so that nobody may decide anything from the failure alone.
    ///
    /// <see cref="RpcErrorCode.UnknownOutcome"/> says so directly. <see cref="RpcErrorCode.Timeout"/>
    /// says the request went out and nothing came back, which is the same fact about a plant reached
    /// by a different route - and treating it as an ordinary failure is the library telling a caller
    /// a command did not happen when what it knows is that it lost track of it.
    /// </summary>
    public static bool MayHaveRun(RpcErrorCode code) =>
        code is RpcErrorCode.UnknownOutcome or RpcErrorCode.Timeout;

    /// <summary>Whether this failure means the call may have run. Null and non-RPC exceptions are unknown, which is the safe reading.</summary>
    public static bool MayHaveRun(Exception? failure) =>
        failure is not SourceRpcException rpc || MayHaveRun(rpc.Code);

    /// <summary>
    /// Whether the call **certainly did not run**, which is the only condition under which a
    /// non-repeatable command may be sent again.
    ///
    /// Deliberately not the negation of <see cref="MayHaveRun(RpcErrorCode)"/>: an unclassified exception is
    /// neither, and reading "not known to have run" as "known not to have run" is exactly how a
    /// second pump start happens.
    /// </summary>
    public static bool CertainlyDidNotRun(RpcErrorCode code) =>
        code is RpcErrorCode.TransportError
            or RpcErrorCode.Busy
            or RpcErrorCode.Superseded
            or RpcErrorCode.NotInControl
            or RpcErrorCode.OwnershipChanged
            or RpcErrorCode.ClassNotFound
            or RpcErrorCode.MethodNotFound
            or RpcErrorCode.InvalidParams
            or RpcErrorCode.IncompatibleVersion
            or RpcErrorCode.Unauthorized
            or RpcErrorCode.Forbidden;

    /// <summary>
    /// Whether asking again gets the same answer, so asking again is only cost.
    ///
    /// Three groups, and they are refusals rather than failures. **A decision about the caller** -
    /// `Unauthorized`, `Forbidden` - which no amount of waiting changes. **A decision about the
    /// call** - `ClassNotFound`, `MethodNotFound`, `InvalidParams`, `IncompatibleVersion` - where
    /// what was sent is not something this peer answers. And **a decision already taken about this
    /// call in particular**: `Superseded` says a newer call won, `OwnershipChanged` says the fence
    /// moved and the caller must re-read rather than retry, and `NotInControl` says the authority is
    /// held elsewhere, so retrying without acquiring refuses again while telling an operator the
    /// plant is flaky.
    ///
    /// <see cref="RpcErrorCode.Busy"/> is deliberately absent: it means the mailbox was full and the
    /// call certainly did not run, which is the one refusal genuinely worth waiting out.
    /// </summary>
    public static bool IsTerminalRefusal(RpcErrorCode code) =>
        code is RpcErrorCode.Unauthorized
            or RpcErrorCode.Forbidden
            or RpcErrorCode.ClassNotFound
            or RpcErrorCode.MethodNotFound
            or RpcErrorCode.InvalidParams
            or RpcErrorCode.IncompatibleVersion
            or RpcErrorCode.Superseded
            or RpcErrorCode.OwnershipChanged
            or RpcErrorCode.NotInControl;

    /// <summary>
    /// Whether a failed call may be sent again at all, from what the caller declared the method does.
    ///
    /// **Undeclared means undeclared.** Null must read as *does not say*, never as *is a read* -
    /// anything else means the first caller who forgets the annotation gets automatic retries on
    /// `Dispense()`, and finds out how many by counting what came out of the machine.
    /// </summary>
    public static bool IsRepeatable(RpcMethodSemantics? semantics) =>
        semantics is RpcMethodSemantics.Query or RpcMethodSemantics.IdempotentCommand;

    /// <summary>
    /// Whether this particular failure of this particular method may be sent again.
    ///
    /// The whole rule in one place, and the order of the tests is the argument. A terminal refusal
    /// is never retried whatever the method is. An undeclared or non-repeatable method is never
    /// retried on a failure that **may have run** - which is the founding distinction doing its
    /// work - but *is* retried where the call certainly did not run, because a command that never
    /// left has had no effect to repeat.
    /// </summary>
    public static bool MayRetry(Exception? failure, RpcMethodSemantics? semantics)
    {
        if (failure is not SourceRpcException rpc)
            // Not one of ours: something threw on the way to the wire, or a transport surfaced its
            // own type. Nothing here knows whether it reached the far end, so nothing here may
            // decide it did not.
            return false;
        if (IsTerminalRefusal(rpc.Code))
            return false;
        if (IsRepeatable(semantics))
            return true;
        return CertainlyDidNotRun(rpc.Code);
    }
}
