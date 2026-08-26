import { useCallback, useState, useSyncExternalStore } from 'react'
import type { RpcOperation, RpcOperations, RpcOperationStatus } from '@source-repo/rpc'

/**
 * What this page has asked other peers to do, and how each of those turned out.
 *
 * Every other tab in this column is about the *network*: what it carried, what it refused, who came
 * and went. This one is about **this page**, and it exists for one row - the command that was sent
 * and never answered. A program has the promise and does not need a list; a person pressed a button
 * and needs to know whether the plant did something, and if nobody knows, that nobody knows.
 *
 * The registry is the library's own `client.operations`, written at `callWith`, so this draws what
 * the peer already recorded rather than keeping a second account of it.
 */

/** What each status means to somebody looking at a command that has not come back. */
const MEANING: { [status in RpcOperationStatus]: string } = {
    issued: 'not on the wire yet',
    sent: 'sent, waiting for an answer',
    deferred: 'accepted; the work is still running',
    succeeded: 'answered',
    failed: 'refused, and it certainly did not run',
    'unknown-outcome': 'sent, and nothing came back — it may or may not have run'
}

/**
 * Three views, and the default is the one the tray is for.
 *
 * `commands` is `semantics !== 'query'`, which keeps the undeclared ones: a method that says nothing
 * about what it does must be treated as a command, exactly as it is everywhere else here. It is not
 * a filter on danger, it is a filter on *what could not be undone by asking again*.
 */
type View = 'uncertain' | 'commands' | 'all'

const VIEWS: { [view in View]: (one: RpcOperation) => boolean } = {
    uncertain: (one) => one.status === 'unknown-outcome',
    commands: (one) => one.semantics !== 'query',
    all: () => true
}

const NOTHING: { [view in View]: string } = {
    uncertain: 'Nothing was left in the air. This is where a command that was sent and never answered stays until somebody deals with it.',
    commands: 'This page has commanded nothing yet.',
    all: 'This page has asked for nothing yet.'
}

const at = (time: number) => new Date(time).toLocaleTimeString()

/** How long it took, or how long it has been going. */
const took = (one: RpcOperation) => (one.settledAt ? `${one.settledAt - one.issuedAt} ms` : `${Math.round((Date.now() - one.issuedAt) / 1000)}s so far`)

export const Operations = ({ operations }: { operations: RpcOperations }) => {
    const [view, setView] = useState<View>('uncertain')
    const all = useSyncExternalStore(
        useCallback((listener: () => void) => operations.subscribe(listener), [operations]),
        useCallback(() => operations.getSnapshot(), [operations])
    )
    // Newest first here and oldest first in the registry: a list somebody reads top-down wants the
    // thing that just happened at the top, and a log wants the order it happened in.
    const shown = [...all].filter(VIEWS[view]).reverse()
    const uncertain = all.filter(VIEWS.uncertain).length

    return (
        <div className="operations">
            <header>
                <h1>Operations</h1>
                <select className="period" value={view} onChange={(event) => setView(event.target.value as View)} title="which of this page's calls to list">
                    <option value="uncertain">uncertain</option>
                    <option value="commands">commands</option>
                    <option value="all">everything</option>
                </select>
                {/* Deliberately not a "clear all": an uncertain outcome is the one row nobody may
                    remove by pressing a button that says something else, so it is dismissed one at a
                    time and on purpose. */}
                <button className="toggle" onClick={() => operations.clearSettled()} title="forget the ones that are over and certain">
                    clear settled
                </button>
            </header>
            {uncertain > 0 && view !== 'uncertain' && (
                <p className="uncertain">
                    {uncertain} command{uncertain === 1 ? '' : 's'} left in the air.
                    <button className="toggle" onClick={() => setView('uncertain')}>
                        show
                    </button>
                </p>
            )}
            {shown.length === 0 && <p className="muted">{NOTHING[view]}</p>}
            {shown.map((one) => (
                <div key={one.id} className={`operation ${one.status}`}>
                    <div className="operation-head">
                        <time>{at(one.issuedAt)}</time>
                        <span className="kind">{one.status}</span>
                        {/* The claim the caller made, never a decision anything took. It is what
                            makes an uncertain row readable: a non-repeatable command left in the air
                            is a different thing from a read that timed out. */}
                        {one.semantics && <span className="muted">{one.semantics}</span>}
                        <span className="muted">{took(one)}</span>
                    </div>
                    <div className="operation-body">
                        <code className="mono">
                            {one.target ?? 'this link'} · {one.namespace}.{one.method}
                        </code>
                        {/* Two places to fail, and they are different facts: the relay not answering
                            says nothing about the plant, and the relay answering *with* an uncertain
                            outcome says the command reached the plant and nobody knows what it did. */}
                        {one.via && <span className="muted"> via {one.via}</span>}
                        <p>
                            {MEANING[one.status]}
                            {one.code && one.code !== 'UnknownOutcome' ? ` (${one.code})` : ''}
                        </p>
                        {one.message && <p className="muted">{one.message}</p>}
                        <div className="operation-foot">
                            {/* Shown because it is the whole reason a second press is safe to offer:
                                without a key, trying again is another command. */}
                            {one.idempotencyKey && <span className="muted mono">key {one.idempotencyKey}</span>}
                            {one.status === 'unknown-outcome' && (
                                <button className="toggle" onClick={() => operations.forget(one.id)} title="go and look at the plant instead">
                                    dismiss
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}
