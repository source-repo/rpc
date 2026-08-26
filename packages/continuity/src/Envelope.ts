import { canonicalText, digestText } from '@source-repo/rpc'

/**
 * What a component keeps when the process implementing it is replaced.
 *
 * A logical component outlives any one activation of it. The values it carries between handlers do
 * not live in a process's object layout, its closures or its stacks - those cannot be handed over -
 * so they are captured explicitly, versioned explicitly, and named by what they contain.
 *
 * **Phase 1 makes no claim of live process replacement.** What is here is the snapshot and the
 * migration of held state: enough to take a component's state forward across a schema change and to
 * prove afterwards which value came from where. A handoff needs the obligations a running activation
 * holds - its timers, its calls in flight, its subscriptions and leases - and `admissibleForHandoff`
 * refuses a snapshot that has none rather than letting a caller discover the gap at the barrier.
 */

/**
 * What a snapshot is enough for.
 *
 * The two are not degrees of completeness, they are different claims. `held-state-only` says *these
 * were the values*; `quiescent-handoff` says *these were the values, at this position in the input,
 * under this activation, with this work outstanding*. The second is a statement about an instant and
 * the first is not, which is exactly why the first can never stand in for it.
 */
export type RpcCaptureKind = 'held-state-only' | 'quiescent-handoff'

/** One migration that was applied, and what it did. See `Migration.ts`. */
export interface RpcMigrationRecord {
    /** The reviewed step, by the id it is registered under. */
    readonly stepId: string
    readonly schemaId: string
    readonly fromVersion: number
    readonly toVersion: number
    /** Who approved the step, and where the approval is recorded. Never inferred. */
    readonly approval: RpcMigrationApproval
    /** Paths the step carried across or converted. */
    readonly transformed: readonly string[]
    /** Paths the step supplied a reviewed value for, with the value and the reason. */
    readonly defaulted: readonly RpcDefaultedValue[]
    /** The canonical digest of the state this step was given, so a chain can be re-walked. */
    readonly inputHash: string
    readonly outputHash: string
}

export interface RpcMigrationApproval {
    /** Whoever reviewed the transform. A person or a team, never a process. */
    readonly by: string
    /** Where the review is recorded - a pull request, a change record, a ticket. */
    readonly reference: string
}

export interface RpcDefaultedValue {
    /** The exact field, spelled from the root of the state: `zones.top.setpoint`. */
    readonly path: string
    readonly value: unknown
    /**
     * Why this value and not another.
     *
     * Recorded because a default is the one place a migration *invents* something, and six months
     * later the question is never "was a default applied" - it is "who decided 20 °C, and against
     * what". A record without that sentence answers the wrong half.
     */
    readonly why: string
}

/**
 * An immutable, consistent capture of a component's held state.
 *
 * Every field that identifies it is on the snapshot rather than around it: a snapshot found on a
 * disk, in a bucket or in a message must be able to say what it is without whatever wrote it being
 * present to explain.
 */
export interface RpcSnapshotEnvelope<State = unknown> {
    readonly snapshotFormatVersion: number
    /**
     * What this snapshot is called.
     *
     * A **captured** snapshot is named by whoever captured it. A **derived** one - the output of a
     * migration - is named by its own content hash, and that is not decoration: two dry runs of one
     * migration over one input have to produce the same snapshot in every field, or "dry run and
     * committed migration produce the same output" is a claim about timing rather than about the
     * transform.
     */
    readonly snapshotId: string
    readonly captureKind: RpcCaptureKind

    readonly componentType: string
    readonly componentId: string
    /** The revision of the program that held this state. Not the schema - see `stateSchemaId`. */
    readonly sourceRevision: string

    readonly stateSchemaId: string
    /** Written on the snapshot and never inferred, because inference here is a guess about a plant. */
    readonly stateVersion: number
    readonly stateSchemaHash: string

    /** Present only on a `quiescent-handoff` capture. See `admissibleForHandoff`. */
    readonly activationEpoch?: bigint
    readonly logicalTime?: bigint
    readonly lastAppliedInputSequence?: bigint
    readonly lastCommittedOutputSequence?: bigint

    readonly heldState: State
    /** Every migration this state has been through, oldest first. Empty on a fresh capture. */
    readonly provenance: readonly RpcMigrationRecord[]

    /**
     * When the values were captured, as a human-facing ISO instant.
     *
     * **Not a clock to compute with.** A migrated snapshot carries its parent's `capturedAt`
     * unchanged, because the values describe that instant and a migration does not observe the
     * component again - deriving is not capturing. Ordering is `logicalTime` and the sequence
     * positions, which are the only things here that mean *when* in any sense a machine may use.
     */
    readonly capturedAt: string
    readonly parentSnapshotHash?: string
    /** The digest of everything above. See `sealSnapshot`. */
    readonly contentHash: string
}

/** The format this package writes. Bumped when the envelope's own shape changes, never for state. */
export const SNAPSHOT_FORMAT_VERSION = 1

/** A snapshot before it has been named and hashed - what `sealSnapshot` takes. */
export type RpcSnapshotDraft<State = unknown> = Omit<RpcSnapshotEnvelope<State>, 'snapshotId' | 'contentHash' | 'snapshotFormatVersion'> & {
    readonly snapshotFormatVersion?: number
    /** Absent means "name it by what it contains", which is what a derived snapshot wants. */
    readonly snapshotId?: string
}

/**
 * What the content hash is taken over.
 *
 * Everything that says what this snapshot *is*, and deliberately not `snapshotId` - which would be
 * circular for a derived snapshot, since the id is the hash. `capturedAt` **is** covered, which it
 * can be precisely because a migration carries it forward rather than restamping it.
 *
 * The hash is a corruption check rather than a tamper seal: anyone who can rewrite a snapshot can
 * recompute it. A deployment wanting tamper evidence signs the snapshot as well, which is the same
 * division the row stamp makes and says so for the same reason.
 */
const hashedForm = <State>(draft: Omit<RpcSnapshotEnvelope<State>, 'snapshotId' | 'contentHash'>) => ({
    snapshotFormatVersion: draft.snapshotFormatVersion,
    captureKind: draft.captureKind,
    componentType: draft.componentType,
    componentId: draft.componentId,
    sourceRevision: draft.sourceRevision,
    stateSchemaId: draft.stateSchemaId,
    stateVersion: draft.stateVersion,
    stateSchemaHash: draft.stateSchemaHash,
    activationEpoch: draft.activationEpoch,
    logicalTime: draft.logicalTime,
    lastAppliedInputSequence: draft.lastAppliedInputSequence,
    lastCommittedOutputSequence: draft.lastCommittedOutputSequence,
    heldState: draft.heldState,
    provenance: draft.provenance,
    capturedAt: draft.capturedAt,
    parentSnapshotHash: draft.parentSnapshotHash
})

/** A refusal that names the field and the reason, which is the only kind worth returning. */
export class RpcSnapshotRefused extends Error {
    constructor(
        message: string,
        /** The field this is about, where it is about one. */
        readonly path?: string
    ) {
        super(message)
        this.name = 'RpcSnapshotRefused'
    }
}

const REQUIRED_FOR_HANDOFF = ['activationEpoch', 'logicalTime', 'lastAppliedInputSequence', 'lastCommittedOutputSequence'] as const

/**
 * Name and hash a snapshot, refusing one that does not say what it claims to be.
 *
 * A `quiescent-handoff` capture without its epoch and positions is refused here rather than accepted
 * and found wanting at a barrier: the whole value of the kind is that it is a statement about one
 * instant, and a partial one is a statement about nothing.
 */
export const sealSnapshot = async <State>(draft: RpcSnapshotDraft<State>): Promise<RpcSnapshotEnvelope<State>> => {
    if (!draft.componentType) throw new RpcSnapshotRefused('a snapshot names the component type it came from', 'componentType')
    if (!draft.componentId) throw new RpcSnapshotRefused('a snapshot names the instance it came from', 'componentId')
    if (!draft.sourceRevision) throw new RpcSnapshotRefused('a snapshot names the revision that held the state', 'sourceRevision')
    if (!draft.stateSchemaId) throw new RpcSnapshotRefused('a snapshot names the state schema its values are described by', 'stateSchemaId')
    if (!draft.stateSchemaHash) throw new RpcSnapshotRefused('a snapshot carries the hash of the schema it was validated against', 'stateSchemaHash')
    if (!Number.isInteger(draft.stateVersion) || draft.stateVersion < 0)
        throw new RpcSnapshotRefused(`a state version is a non-negative integer, not ${String(draft.stateVersion)}`, 'stateVersion')
    if (draft.captureKind === 'quiescent-handoff')
        for (const field of REQUIRED_FOR_HANDOFF)
            if (draft[field] === undefined)
                throw new RpcSnapshotRefused(`a quiescent-handoff snapshot is a statement about one instant, and ${field} is part of saying which`, field)

    const sealed = {
        ...draft,
        snapshotFormatVersion: draft.snapshotFormatVersion ?? SNAPSHOT_FORMAT_VERSION
    } as Omit<RpcSnapshotEnvelope<State>, 'snapshotId' | 'contentHash'>
    const contentHash = await digestText(canonicalText(hashedForm(sealed)))
    return Object.freeze({ ...sealed, snapshotId: draft.snapshotId ?? contentHash, contentHash })
}

/** Recompute the hash. Returns the reason it does not match, or nothing when it does. */
export const verifySnapshot = async <State>(snapshot: RpcSnapshotEnvelope<State>): Promise<string | undefined> => {
    const expected = await digestText(canonicalText(hashedForm(snapshot)))
    return expected === snapshot.contentHash ? undefined : `snapshot ${snapshot.snapshotId} hashes to ${expected}, and carries ${snapshot.contentHash}`
}

/**
 * Whether this snapshot is enough to restore an activation from, rather than only enough to migrate.
 *
 * **It is never enough in Phase 1**, and that is the point of the function existing now. A handoff
 * needs the obligations a running activation holds - the timers it owes, the calls it has out, the
 * subscriptions and leases it is answering for - and none of that is captured yet. Returning a
 * reason rather than `false` is what stops "we have snapshots" being read as "we can hand over".
 */
export const admissibleForHandoff = (snapshot: RpcSnapshotEnvelope): string | undefined => {
    if (snapshot.captureKind !== 'quiescent-handoff')
        return `${snapshot.snapshotId} is a ${snapshot.captureKind} capture: it says what the values were, not where the component had got to`
    for (const field of REQUIRED_FOR_HANDOFF)
        if (snapshot[field] === undefined) return `${snapshot.snapshotId} is missing ${field}, so it does not describe one instant`
    return 'no activation may be restored from a snapshot yet: the obligations manifest is Phase 2, and a handoff without it would silently drop the work the old activation still owed'
}
