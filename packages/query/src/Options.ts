import type { RpcErrorCode, RpcMethodSemantics } from '@source-repo/rpc'

/**
 * The two defaults a query cache has that are wrong for a control network, and what replaces them.
 *
 * Neither is a flaw in the cache. Both are correct for the thing it was built for - a browser
 * talking to an HTTP API, where a GET is a GET and a failed request cost nothing but a round trip -
 * and both are wrong here for the same reason: **this library refuses to guess what a call does.**
 */

/**
 * A request that was never issued, because the budget the caller declared had already run out.
 *
 * Its own type so `retry` can recognise it and stop rather than counting it as one more failure and
 * waiting to try again. It is not a failure of the plant; it is this cache declining to spend a link
 * on an answer nobody is still waiting for.
 */
export class RpcDeadlinePassed extends Error {
    constructor(message = 'the deadline for this request passed before it could be issued') {
        super(message)
        this.name = 'RpcDeadlinePassed'
    }
}

/**
 * Codes where asking again gets the same answer, so asking again is only cost.
 *
 * Three groups, and they are refusals rather than failures. **A decision about the caller** -
 * `Forbidden`, `Unauthorized` - which no amount of waiting changes. **A decision about the call** -
 * `ClassNotFound`, `MethodNotFound`, `InvalidParams`, `IncompatibleVersion` - where what was sent is
 * not something this peer answers. And **a decision already taken about this call in particular**:
 * `Superseded` says a newer call to a conflatable method won, which is what the method opted into;
 * `OwnershipChanged` says the fence moved and the caller must re-read the topology rather than
 * retry; `NotInControl` says the authority is held elsewhere, and retrying without acquiring refuses
 * again while telling an operator the plant is flaky.
 *
 * `Busy` is deliberately not here - it means the mailbox was full and the call certainly did not
 * run, which is the one refusal that is genuinely worth waiting out.
 *
 * `LimitExceeded` and `IdempotencyUnavailable` are answered by a .NET peer rather than by this
 * implementation, and belong in the second group: a frame that broke a protocol limit breaks it
 * again unchanged, and a peer with no idempotency store still has none a second later.
 */
const TERMINAL: readonly RpcErrorCode[] = ['Forbidden', 'Unauthorized', 'ClassNotFound', 'MethodNotFound', 'InvalidParams', 'IncompatibleVersion', 'LimitExceeded', 'IdempotencyUnavailable', 'Superseded', 'OwnershipChanged', 'NotInControl']

export const isTerminalRefusal = (error: unknown): boolean => {
    const code = (error as { code?: RpcErrorCode } | undefined)?.code
    return code !== undefined && TERMINAL.includes(code)
}

/**
 * Whether a failed call may be sent again at all, from what the method declared it does.
 *
 * **A cache retries three times by default, and that is right only because a `query` is a query.**
 * `semantics` is optional in this library on purpose - undeclared means undeclared - so absent must
 * read as *does not say*, never as *is a read*. Anything else means the first author who forgets the
 * annotation gets automatic retries on `dispense()`, and finds out how many by counting what came
 * out of the machine.
 *
 * `idempotent-command` is repeatable by the author's own claim, which is exactly what the annotation
 * is for: arriving twice leaves the same state as arriving once.
 */
export const repeatable = (semantics: RpcMethodSemantics | undefined): boolean => semantics === 'query' || semantics === 'idempotent-command'

export interface RpcQueryBehaviour {
    /** What the method declares it does. Absent means nothing is retried, which is the safe reading. */
    readonly semantics?: RpcMethodSemantics
    /**
     * How long the whole question may take, **across every attempt**, in milliseconds.
     *
     * A budget the caller declared, not a per-attempt timeout - which is the same arithmetic that
     * killed command parking, arriving through a different door. Three attempts under a
     * "ten second timeout" that each restart the clock is a thirty second wait, and the caller who
     * wrote ten meant ten. Absent, or zero, means no deadline: what the transport enforces is all
     * there is.
     */
    readonly deadlineMs?: number
    /** How many times a repeatable call may be sent again. Attempts beyond the first. */
    readonly attempts?: number
    /** The longest a retry waits, whatever the backoff worked out to. */
    readonly retryCapMs?: number
}

/**
 * What one attempt is told: what remains of the budget, and where the cancellation comes from.
 *
 * `deadlineMs` is what to put on the call - `$with({ ttl })` or whatever the caller's own wrapper
 * spells it as. Absent means the caller declared no budget, which is not the same as zero and must
 * not be passed as one: `ttl: 0` means *no deadline* on this wire, so an exhausted budget arriving
 * as a zero would turn a request nobody is waiting for into one that waits for ever.
 */
export interface RpcAttempt {
    readonly signal: AbortSignal
    readonly deadlineMs?: number
}

/**
 * When the fetch this attempt belongs to began.
 *
 * Keyed on the signal because that is the one thing every attempt of one fetch shares and no two
 * fetches do - the cache makes one abort controller per fetch and hands it to each retry. Weak, so
 * a fetch that ends takes its entry with it.
 */
const startedAt = new WeakMap<AbortSignal, number>()

/**
 * The options a Source RPC call is worth wrapping in, whatever it asks for.
 *
 * Not `$data`-specific: a plain method call is a perfectly good thing to cache, and the two defaults
 * this fixes are wrong for both. What it deliberately does **not** set is `refetchInterval`. The
 * period belongs to whoever is watching - that is the entire reason `$data` is a call rather than a
 * subscription, because a subscription's rate belongs to the publisher and on a 1200 baud link that
 * means the peer decides how much of the operator's bandwidth it spends.
 */
export const rpcQueryOptions = <T>(run: (attempt: RpcAttempt) => Promise<T>, behaviour: RpcQueryBehaviour = {}) => {
    const { semantics, deadlineMs, attempts = 2, retryCapMs = 30_000 } = behaviour
    return {
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T> => {
            if (!deadlineMs) return run({ signal })
            const began = startedAt.get(signal) ?? Date.now()
            startedAt.set(signal, began)
            const left = began + deadlineMs - Date.now()
            // Refused rather than issued with whatever is left of nothing. A retry that waited out
            // the backoff and arrives here with no budget is the case this exists for, and sending
            // it anyway would spend the link on an answer that is already too late to use.
            if (left <= 0) throw new RpcDeadlinePassed()
            return run({ signal, deadlineMs: left })
        },
        // Typed as `Error` rather than `unknown` because that is what the cache's own default
        // error type is, and a looser signature here makes every observer downstream unassignable.
        retry: (failureCount: number, error: Error) => {
            if (error instanceof RpcDeadlinePassed) return false
            if (isTerminalRefusal(error)) return false
            if (!repeatable(semantics)) return false
            return failureCount < attempts
        },
        // Doubling from a second, which on a link with a multi-second round trip is already close to
        // the floor. Capped, because a backoff that grows without bound is a screen that stops
        // updating and never says why.
        retryDelay: (failureCount: number) => Math.min(retryCapMs, 1000 * 2 ** failureCount)
    }
}
