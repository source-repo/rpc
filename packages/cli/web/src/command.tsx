import { useCallback, useState } from 'react'

import { mayHaveRun } from '@source-repo/rpc'

/**
 * One press of a button that commands a plant, and what it takes to press it *again* safely.
 *
 * The console did not attach idempotency keys, and the CLI did - which is the wrong way round, since
 * the CLI is driven by somebody typing a command they can see and the console is the thing an
 * operator actually presses. Without a key, a second press after `UnknownOutcome` is a second
 * command, and on a plant that is the difference between one pump start and two.
 *
 * **A key per press, held for the retry, and never reused for anything else.** The library's own
 * rule is that a value generated per *attempt* buys nothing, because that is what the request id
 * already is - so the key has to name the operator's intent and survive being tried again. What it
 * must not do is outlive the intent: committing 180, then 190, then 180 again is three decisions,
 * and a key derived from the value would make the third one answer with the first one's result.
 *
 * So: minted when the operator commits, kept while that same commit can still be retried, and gone
 * the moment they commit anything else.
 *
 * **Offered only where the outcome is genuinely unknown**, using the library's own classification
 * rather than a second copy of it - a screen that disagreed with the tray beside it about whether a
 * command may have run would be disagreeing in front of an operator about the only question that
 * mattered.
 */
export interface Retryable {
    /** What was being commanded, for the button to name. */
    readonly label: string
    readonly again: () => void
}

export interface Commanding {
    /** What is in flight, by whatever label the caller gave it. */
    pending?: string
    /** Present when the last command ended without anybody knowing whether it ran. */
    retry?: Retryable
    /**
     * Run a command. `run` is handed the key to put on the call - through `$with` for a direct call,
     * or as the last argument of the console's relaying `call` verb.
     */
    run(label: string, act: (idempotencyKey: string) => Promise<void>): Promise<void>
    /** Forget an offered retry without taking it - the operator decided to go and look instead. */
    dismiss(): void
}

/** A key per press. `randomUUID` is available in every browser this console runs in. */
const mint = () => globalThis.crypto.randomUUID()

export const useCommanding = (): Commanding => {
    const [pending, setPending] = useState<string | undefined>()
    const [retry, setRetry] = useState<Retryable | undefined>()

    const run = useCallback(async (label: string, act: (idempotencyKey: string) => Promise<void>) => {
        // A new commit clears whatever the last one left offered: the operator has moved on, and a
        // stale "try again" would re-send a command about a value that is no longer on screen.
        setRetry(undefined)
        const attempt = async (key: string): Promise<void> => {
            setPending(label)
            try {
                await act(key)
            } catch (failure) {
                // The same key, so the far end sees one command with two attempts rather than two
                // commands. Offered only where nobody knows what happened - an ordinary refusal is a
                // fact, and pressing it again would simply be refused again.
                if (mayHaveRun(failure)) setRetry({ label, again: () => void attempt(key) })
                throw failure
            } finally {
                setPending(undefined)
            }
        }
        return attempt(mint())
    }, [])

    return { pending, retry, run, dismiss: useCallback(() => setRetry(undefined), []) }
}

/**
 * The one line an operator must not be able to scroll past.
 *
 * Drawn wherever a command can be sent, and deliberately not folded into the ordinary error
 * rendering beside it: a refusal is a fact - the interlock is open, the stamp is stale, the caller
 * may not - and pressing it again gets the same refusal. *Nothing came back* is not a fact about the
 * plant at all, it is the absence of one, and the two need different words and different buttons or
 * an operator learns to treat both as noise.
 *
 * **Try again is safe here precisely because the key is the same.** A peer holding a durable
 * idempotency store answers the second attempt from the first's record instead of running it twice;
 * one without such a store runs it again - which is why the sentence says what it says rather than
 * promising more than the network can keep.
 */
export const Uncertain = ({ commanding }: { commanding: Commanding }) => {
    if (!commanding.retry) return null
    return (
        <p className="uncertain">
            <span className="mono">{commanding.retry.label}</span> was sent and nothing came back — it may or may not have run.
            <button className="toggle" onClick={commanding.retry.again} title="sends the same command under the same key, so a peer that keeps one answers from its record rather than running it twice">
                try again
            </button>
            <button className="toggle" onClick={commanding.dismiss} title="leave it: go and look at the plant instead">
                dismiss
            </button>
        </p>
    )
}
