import { rpc, rpcNamespace } from '@source-repo/rpc'
import type { RpcTicket } from '@source-repo/rpc'

export type Spec = { what: string }
export type JobResult = { rows: number }

/**
 * A method that answers later. What the *call* returns is a correlation id and an expiry; the
 * result arrives down the reply channel, and the contract has to describe both or it stops
 * watching the half that matters.
 */
@rpcNamespace('jobs')
export class Jobs {
    @rpc({ semantics: 'non-repeatable-command' })
    async start(spec: Spec): Promise<RpcTicket<JobResult, number>> {
        void spec
        return undefined as never
    }

    /** A ticket that reports nothing on the way, so `progress` should be absent rather than any. */
    @rpc({ semantics: 'non-repeatable-command' })
    async sweep(): Promise<RpcTicket<JobResult>> {
        return undefined as never
    }
}
