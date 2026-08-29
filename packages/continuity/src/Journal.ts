import { canonicalText, digestText } from '@source-repo/rpc'
import { RpcSnapshotRefused, type RpcSnapshotEnvelope } from './Envelope.js'
import type { RpcHandoffRecord } from './Coordinator.js'

/**
 * What a component did, in the order it did it, so that a question about the past has an answer.
 *
 * The obligations manifest says what a component was doing at the instant of its snapshot. That is
 * one instant. **To answer "what was it doing at 03:14?" the system needs an append-only record of
 * what happened between the instants**, which is this - and the design is explicit that a handoff
 * snapshot alone must never be treated as one.
 *
 * The reason it exists is sharper than history, though. Phase 3's coordinator ends a failed handoff
 * past the commit point with `failed-after-commit` and the words *recover forward*, and leaves what
 * that means to the deployment. A journal is what makes those words a procedure: the successor has
 * begun authoritative work, restoring the incumbent's snapshot would discard it, and the only honest
 * route back is a snapshot plus every input applied since - replayed, in order, into a revision that
 * can take them.
 *
 * ## The two things that make a journal trustworthy
 *
 * **It chains.** Every entry carries the hash of the one before it and of its own content, so a
 * journal verifies end to end and an entry that was altered or removed is detectable rather than
 * merely absent. A record of what a plant did is evidence, and evidence that cannot be checked is
 * testimony.
 *
 * **It refuses to lose what it would need.** Retention is not an age: it is what remains replayable.
 * Compaction that discarded entries between a retained snapshot and the present would leave a
 * journal that still looked complete and could no longer carry that snapshot forward, so compaction
 * is expressed as *keep everything after this snapshot* and refuses anything else.
 */

/** What kind of transition an entry records. The design's three classes, plus the inputs to replay. */
export type RpcJournalEntryKind =
    /** An input applied at a position. The only kind replay consumes, and the reason for the rest. */
    | 'input'
    /** A state transition, or the sealing of a snapshot. What a replay starts from. */
    | 'state'
    /** An obligation taken on or discharged. What the component owed, and when it stopped owing it. */
    | 'obligation'
    /** An ownership transition: a handoff attempted, committed, abandoned, or failed after commit. */
    | 'activation'

export interface RpcJournalEntry {
    /** The journal's own position. Monotonic per component, and gapless by construction. */
    readonly sequence: bigint
    readonly componentId: string
    readonly kind: RpcJournalEntryKind
    /** Which activation wrote it. An entry from an epoch that has been fenced is still history. */
    readonly epoch: bigint
    /** Wall clock, because "what was it doing at 03:14" is asked in wall clock. */
    readonly at: string
    readonly logicalTime?: bigint
    /**
     * For an `input`: the position that input was applied at.
     *
     * The join between a snapshot and this journal, and the only one there is. A snapshot's
     * `lastAppliedInputSequence` says where it stopped; replay begins at the entry after it. Two
     * different numbers deliberately: the journal's own sequence counts every entry of every kind,
     * and the input sequence counts only what the component was given to apply.
     */
    readonly inputSequence?: bigint
    /**
     * What happened, in the portable vocabulary.
     *
     * JSON-shaped, for the same reason a snapshot's held state is: a journal that could only be read
     * by the language that wrote it cannot be verified by the successor, and a successor in another
     * language is the case the whole design is built around.
     *
     * **Shaped for that and not yet proved for it.** No other implementation reads this format, and
     * until a fixture in `packages/conformance/fixtures` has been asked of two of them, "portable"
     * is a property of the shape rather than a demonstrated fact - which is the same standard the
     * snapshot's own cross-language claim had to meet before it was made.
     */
    readonly payload: unknown
    /** The hash of the entry before this one, or the empty string for the first. */
    readonly previousHash: string
    /** Over everything above. What makes the chain a chain. */
    readonly entryHash: string
}

/** What a journal can actually promise, said out loud rather than assumed. */
export interface RpcJournalCapabilities {
    /**
     * Whether entries survive this process.
     *
     * A journal that does not is a journal that cannot answer a question about last night, which is
     * the only kind of question anybody asks a journal. It is still useful within one run - a
     * replay after a failed handoff happens in seconds - and it must not be mistaken for the other
     * thing.
     */
    readonly durable: boolean
    /** Whether an entry, once appended, cannot be rewritten by this implementation. */
    readonly appendOnly: boolean
    /** Whether the chain is verified on read, so a caller need not remember to. */
    readonly tamperEvident: boolean
}

export interface RpcJournal {
    readonly capabilities: RpcJournalCapabilities
    append(draft: Omit<RpcJournalEntry, 'sequence' | 'previousHash' | 'entryHash'>): Promise<RpcJournalEntry>
    /** Everything from `fromSequence` on, in order. Everything, when it is not given. */
    read(componentId: string, fromSequence?: bigint): Promise<readonly RpcJournalEntry[]>
    /**
     * Discard what is no longer needed to carry `snapshot` forward, and refuse anything else.
     *
     * The snapshot is the argument rather than a date, because that is what retention actually is
     * here: a journal is long enough when it reaches from a snapshot somebody kept to now.
     */
    compactTo(snapshot: RpcSnapshotEnvelope): Promise<number>
}

const hashedForm = (entry: Omit<RpcJournalEntry, 'entryHash'>) => ({ ...entry })

/** Seal an entry onto the end of a chain. The hash covers the link, so the order is part of it. */
export const sealEntry = async (draft: Omit<RpcJournalEntry, 'entryHash'>): Promise<RpcJournalEntry> =>
    Object.freeze({ ...draft, entryHash: await digestText(canonicalText(hashedForm(draft))) })

/**
 * Walk the chain. The first thing that does not hold, or nothing.
 *
 * Checked in order and reported on the first break, because a journal with one altered entry has
 * every entry after it in question - listing them all would be listing consequences as though they
 * were causes.
 */
export const verifyJournal = async (entries: readonly RpcJournalEntry[]): Promise<string | undefined> => {
    let previousHash = ''
    let previousSequence: bigint | undefined
    for (const entry of entries) {
        if (previousSequence !== undefined && entry.sequence !== previousSequence + 1n)
            return `the journal jumps from ${previousSequence} to ${entry.sequence}: entries are missing, and what a component did between them cannot be reconstructed from what is left`
        if (entry.previousHash !== previousHash) return `entry ${entry.sequence} follows ${entry.previousHash || '(nothing)'} and the entry before it hashes to ${previousHash || '(nothing)'}: the chain has been rewritten`
        const { entryHash, ...rest } = entry
        const expected = await digestText(canonicalText(hashedForm(rest)))
        if (expected !== entryHash) return `entry ${entry.sequence} hashes to ${expected}, not the ${entryHash} it carries: its content changed after it was written`
        previousHash = entryHash
        previousSequence = entry.sequence
    }
    return undefined
}

/**
 * A journal in memory, and the reference implementation rather than a default.
 *
 * `durable: false`, for the same reason `MemoryOwnershipStore` answers false to everything it cannot
 * promise: a journal that forgets when the process does can carry a failed handoff forward - which
 * takes seconds and is the case it is most often needed for - and cannot answer anything about last
 * night. Both are true, and only one of them is what somebody means when they ask for a journal.
 */
export class RpcMemoryJournal implements RpcJournal {
    readonly capabilities: RpcJournalCapabilities = { durable: false, appendOnly: true, tamperEvident: true }
    private readonly entries = new Map<string, RpcJournalEntry[]>()

    async append(draft: Omit<RpcJournalEntry, 'sequence' | 'previousHash' | 'entryHash'>): Promise<RpcJournalEntry> {
        const held = this.entries.get(draft.componentId) ?? []
        const last = held[held.length - 1]
        const entry = await sealEntry({ ...draft, sequence: (last?.sequence ?? 0n) + 1n, previousHash: last?.entryHash ?? '' })
        held.push(entry)
        this.entries.set(draft.componentId, held)
        return entry
    }

    async read(componentId: string, fromSequence?: bigint): Promise<readonly RpcJournalEntry[]> {
        const held = this.entries.get(componentId) ?? []
        return fromSequence === undefined ? [...held] : held.filter((entry) => entry.sequence >= fromSequence)
    }

    /**
     * Keep what reaches from this snapshot to now, and drop what is older.
     *
     * Refuses when the journal does not reach the snapshot at all: discarding then would leave a
     * journal that still looked whole and could no longer carry that snapshot forward, which is
     * worse than a short journal because it is a short journal that says otherwise.
     */
    async compactTo(snapshot: RpcSnapshotEnvelope): Promise<number> {
        const held = this.entries.get(snapshot.componentId) ?? []
        const position = snapshot.lastAppliedInputSequence
        if (position === undefined) throw new RpcSnapshotRefused('a held-state-only snapshot names no input position, so nothing can be said about which entries follow it', 'lastAppliedInputSequence')
        const inputs = held.filter((entry) => entry.kind === 'input' && entry.inputSequence !== undefined)
        const earliest = inputs[0]?.inputSequence
        // The question is whether the journal reaches *back* to the snapshot, not whether it holds
        // anything after it. A journal beginning at input 50 has plenty after a snapshot that stops
        // at 40 and cannot carry it, because 41 to 49 are nowhere.
        if (earliest !== undefined && earliest > position + 1n)
            throw new RpcSnapshotRefused(
                `this journal begins at input ${earliest} and the snapshot stops at ${position}: compacting to it would leave a journal that reaches neither, and a journal that cannot carry the snapshot it was kept for is a journal nobody can use`,
                'lastAppliedInputSequence'
            )
        // Everything the snapshot already contains is what goes; entries at or after its position
        // stay, whatever kind they are, because an obligation or an ownership change recorded in
        // that window is part of the history a replay is walking through.
        const keep = held.filter((entry) => entry.kind !== 'input' || (entry.inputSequence ?? 0n) > position)
        this.entries.set(snapshot.componentId, keep)
        return held.length - keep.length
    }
}

/** What replay is allowed to do about effects, and there is no default. */
export type RpcReplayEffects =
    /**
     * The successor runs with its outputs fenced, so replaying produces state and nothing else.
     *
     * The safe one, and the one to want: re-applying a hundred inputs re-runs a hundred handlers,
     * and a handler that commanded a valve the first time will command it again. A shadow replay
     * rebuilds what the component knew without repeating what it did.
     */
    | 'suppress-effects'
    /**
     * Effects go out, deduplicated by the idempotency keys they were recorded under.
     *
     * Only for a deployment whose sinks actually deduplicate - which is a claim about the plant, not
     * about this library - and never for a component whose outbound commands were not keyed. The
     * design's rule that a non-repeatable command is never silently re-executed because a process
     * changed applies with more force here, not less.
     */
    | 'honour-idempotency'

export interface RpcReplayPlan {
    readonly componentId: string
    /** The snapshot to start from, by id, so a plan can be read without holding the snapshot. */
    readonly fromSnapshotId: string
    readonly fromInputSequence: bigint
    /** The inputs to apply, in order. Every one of them, or the plan is a refusal instead. */
    readonly inputs: readonly RpcJournalEntry[]
    readonly toInputSequence: bigint
    readonly effects: RpcReplayEffects
    /** What a reader has to be told about this plan before acting on it. */
    readonly why: string
}

export type RpcReplayOutcome = { readonly plan: RpcReplayPlan } | { readonly refused: string }

/**
 * Whether this journal can carry this snapshot to the present, and exactly how.
 *
 * **Refuses on a gap rather than replaying what is left**, which is the whole discipline of the
 * thing. A journal missing input 41 can still apply 42 onwards, and the state that results never
 * existed in the plant: it is the state of a component that received one fewer command than it did.
 * A recovery that produced it would look like a recovery and be a fabrication.
 */
export const replayableFrom = async (snapshot: RpcSnapshotEnvelope, entries: readonly RpcJournalEntry[], effects: RpcReplayEffects): Promise<RpcReplayOutcome> => {
    if (snapshot.captureKind !== 'quiescent-handoff' || snapshot.lastAppliedInputSequence === undefined)
        return { refused: `${snapshot.componentId}'s snapshot names no input position: a held-state-only capture says what the values were and not where in the input they were, so nothing can be replayed onto it` }

    // Whose entries these are, before whether they chain. Two journals stapled together are not one
    // broken chain, and reporting them as one would send somebody looking for a missing entry that
    // was never missing - the diagnosis has to be the more precise of the two that are true.
    const mine = entries.filter((entry) => entry.componentId === snapshot.componentId)
    const foreign = entries.length - mine.length
    if (foreign) return { refused: `${foreign} of these entries belong to another component, and a replay that mixed two components' inputs would produce a state neither of them was ever in` }

    const broken = await verifyJournal(mine)
    if (broken) return { refused: `this journal cannot be replayed from: ${broken}` }

    const from = snapshot.lastAppliedInputSequence
    const inputs = mine.filter((entry) => entry.kind === 'input' && entry.inputSequence !== undefined && entry.inputSequence > from).sort((a, b) => (a.inputSequence! < b.inputSequence! ? -1 : 1))
    if (!inputs.length)
        return {
            plan: {
                componentId: snapshot.componentId,
                fromSnapshotId: snapshot.snapshotId,
                fromInputSequence: from,
                inputs: [],
                toInputSequence: from,
                effects,
                why: `${snapshot.componentId} has no input recorded after ${from}, so the snapshot is already the present as far as this journal knows`
            }
        }

    let expected = from + 1n
    for (const entry of inputs) {
        if (entry.inputSequence !== expected)
            return {
                refused: `this journal reaches input ${expected - 1n} and the next it holds is ${entry.inputSequence}: replaying across that gap would produce the state of a component that received one fewer input than it did, which is a fabrication rather than a recovery`
            }
        expected++
    }

    const last = inputs[inputs.length - 1]!
    return {
        plan: {
            componentId: snapshot.componentId,
            fromSnapshotId: snapshot.snapshotId,
            fromInputSequence: from,
            inputs,
            toInputSequence: last.inputSequence!,
            effects,
            why:
                effects === 'suppress-effects'
                    ? `${inputs.length} input${inputs.length === 1 ? '' : 's'} from ${from + 1n} to ${last.inputSequence} applied with outputs fenced: the successor is rebuilt to what the component knew, without repeating what it did`
                    : `${inputs.length} input${inputs.length === 1 ? '' : 's'} from ${from + 1n} to ${last.inputSequence} applied with effects going out under their recorded idempotency keys - which is safe only where the sinks actually deduplicate, and that is a claim about the plant`
        }
    }
}

/** How a replay went, and how far it got when it did not go all the way. */
export interface RpcReplayResult {
    readonly applied: number
    readonly reachedInputSequence: bigint
    readonly failedAt?: { readonly inputSequence: bigint; readonly why: string }
}

/**
 * Apply a plan, in order, stopping at the first input the successor could not take.
 *
 * Stops rather than skips, and reports where. An input that could not be applied is a divergence
 * between what the journal recorded and what this revision can accept, and continuing past it would
 * build a state on top of a hole - the same fabrication `replayableFrom` refuses at the gap, arrived
 * at from the other direction.
 */
export const replay = async (plan: RpcReplayPlan, apply: (entry: RpcJournalEntry) => Promise<void> | void): Promise<RpcReplayResult> => {
    let reached = plan.fromInputSequence
    let applied = 0
    for (const entry of plan.inputs) {
        try {
            await apply(entry)
        } catch (failure) {
            return { applied, reachedInputSequence: reached, failedAt: { inputSequence: entry.inputSequence!, why: (failure as Error)?.message ?? 'the successor refused this input' } }
        }
        reached = entry.inputSequence!
        applied++
    }
    return { applied, reachedInputSequence: reached }
}

/**
 * The procedure `failed-after-commit` has been asking for.
 *
 * Phase 3 ends a handoff that failed past the commit point with *recover forward*, and until now
 * that was an instruction rather than something anybody could carry out. This is what it means: the
 * successor holds authority and may already have acted, so the incumbent's snapshot is not a
 * rollback and must not be treated as one - what is available is the last snapshot plus everything
 * the journal recorded after it, replayed into a revision that can take it.
 *
 * Refuses when the journal cannot support it, which is the answer that matters most. A deployment
 * told *recover forward* by a coordinator and *this journal cannot* by this function knows it is in
 * the situation the design warns about, where the only remaining routes are a new revision or a
 * separately designed compatibility window - rather than discovering that halfway through a replay.
 */
export const recoverForward = async (
    record: RpcHandoffRecord,
    snapshot: RpcSnapshotEnvelope,
    entries: readonly RpcJournalEntry[],
    effects: RpcReplayEffects
): Promise<RpcReplayOutcome> => {
    if (record.classification !== 'failed-after-commit')
        return { refused: `${record.componentId}'s handoff ended as ${record.classification}, and forward recovery is for a failure past the commit point: before it, the incumbent never stopped being the owner and there is nothing to recover from` }
    if (snapshot.componentId !== record.componentId) return { refused: `this snapshot is of ${snapshot.componentId} and the handoff that failed was ${record.componentId}'s` }
    if (record.committedEpoch === undefined) return { refused: `${record.componentId}'s record carries no committed epoch, so it does not describe a failure past the commit point however it is classified` }

    const outcome = await replayableFrom(snapshot, entries, effects)
    if ('refused' in outcome) return outcome
    return {
        plan: {
            ...outcome.plan,
            why: `${record.componentId} is owned by ${record.to.activationId} at epoch ${record.committedEpoch} and its handoff failed after the commit point. ${outcome.plan.why}. The incumbent's snapshot is not a rollback: it would discard whatever the successor has already done.`
        }
    }
}
