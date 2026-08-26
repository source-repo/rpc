import { canonicalText } from '@source-repo/rpc'
import { RpcSnapshotRefused, sealSnapshot, verifySnapshot, type RpcDefaultedValue, type RpcMigrationApproval, type RpcMigrationRecord, type RpcSnapshotEnvelope } from './Envelope.js'
import { RpcStateSchemas } from './Schemas.js'

/**
 * Taking a component's held state forward across a schema change.
 *
 * **One reviewed transform per adjacent version, and the chain is walked.** vK to vN applies K→K+1
 * through N−1→N in order, which is V−1 transforms to maintain rather than a transform for every pair
 * - and, more to the point, one place per version where somebody had to decide what a new field
 * means. A direct K→N transform is a decision nobody reviewed, taken about versions that were never
 * adjacent.
 */

/**
 * What a step turned out to be.
 *
 * `defaulted` is not a lesser `total`. It is the outcome that says a value in the new state came
 * from a *decision* rather than from the old state, and the whole of the provenance record exists so
 * that six months later the question - who chose 20 °C, and against what - has an answer.
 */
export type RpcMigrationOutcome = 'total' | 'defaulted' | 'impossible'

/** What a transform is handed so that what it did is recorded rather than inferred afterwards. */
export interface RpcMigrationScribe {
    /** A field the old state determined: carried across, renamed, converted. */
    transformed(path: string): void
    /**
     * A field the old state did not determine, supplied by a reviewed declared value.
     *
     * `why` is not optional and not decoration: a default is the one place a migration invents
     * something, and a record that says a default was applied without saying on what grounds
     * answers the wrong half of the question anybody will actually ask.
     */
    defaulted(path: string, value: unknown, why: string): void
    /**
     * Required information cannot be supplied under the approved rules. Refuses the whole chain.
     *
     * Throws rather than returning, so a transform body reads as ordinary code and cannot forget to
     * stop. An impossible field is a question for a person, not a value for a program to invent -
     * and the reason travels with the path so the person is asked something answerable.
     */
    impossible(path: string, why: string): never
}

/**
 * One reviewed step between adjacent versions.
 *
 * There is no `to`: a step goes from `from` to `from + 1` and nowhere else. Making that a field
 * would admit a step claiming to span versions, which is the thing the adjacent rule exists to
 * prevent.
 *
 * The defaults are what makes a bare `RpcMigrationStep` mean *any* step, which is what a registry
 * holds: `never` in accepts every input type by contravariance, and `unknown` out accepts every
 * result. A concrete step is written with both - `RpcMigrationStep<OvenV1, OvenV2>` - and stays
 * assignable to the bare form.
 */
export interface RpcMigrationStep<From = never, To = unknown> {
    /** How this step is named in provenance. Stable, because a record refers to it for ever. */
    readonly id: string
    readonly schemaId: string
    readonly from: number
    /** Who reviewed it and where that is recorded. Never inferred, never defaulted. */
    readonly approval: RpcMigrationApproval
    apply(state: From, say: RpcMigrationScribe): To
}

/** Why a chain refused, with enough to act on. */
export interface RpcMigrationRefusal {
    /** The step that refused, where one was reached. Absent when the chain could not be assembled. */
    readonly stepId?: string
    readonly schemaId: string
    /** The version being left when it refused. */
    readonly atVersion: number
    /** The exact field, where the refusal is about one. */
    readonly path?: string
    readonly why: string
}

export type RpcMigrationResult<State = unknown> =
    | {
          readonly outcome: 'total' | 'defaulted'
          readonly snapshot: RpcSnapshotEnvelope<State>
          /** Every step that ran, oldest first. Also on the snapshot, which is where it stays. */
          readonly records: readonly RpcMigrationRecord[]
      }
    | { readonly outcome: 'impossible'; readonly refusal: RpcMigrationRefusal }

/**
 * The steps this process knows.
 *
 * Registering two steps for one adjacent pair is refused rather than the second replacing the first:
 * which of two transforms ran would then depend on module load order, and a state migration decided
 * by load order is not a reviewed transform whatever the review said.
 */
export class RpcMigrations {
    private readonly steps = new Map<string, RpcMigrationStep>()

    private static key(schemaId: string, from: number) {
        // Written as an escape and never as the byte. See CLAUDE.md.
        return `${schemaId}\u0000${from}`
    }

    register(step: RpcMigrationStep): this {
        if (!step.id) throw new RpcSnapshotRefused('a migration step has an id, because provenance refers to it for ever', 'id')
        if (!Number.isInteger(step.from) || step.from < 0)
            throw new RpcSnapshotRefused(`a migration step leaves a non-negative integer version, not ${String(step.from)}`, 'from')
        if (!step.approval?.by || !step.approval?.reference)
            throw new RpcSnapshotRefused(`${step.id} carries no approval; a default or a conversion is a decision, and an unattributed one is not reviewable`, 'approval')
        const key = RpcMigrations.key(step.schemaId, step.from)
        const held = this.steps.get(key)
        if (held && held.id !== step.id)
            throw new RpcSnapshotRefused(`${step.schemaId} v${step.from} already migrates through ${held.id}; two steps for one pair would make load order decide which ran`)
        this.steps.set(key, step as RpcMigrationStep)
        return this
    }

    at(schemaId: string, from: number): RpcMigrationStep | undefined {
        return this.steps.get(RpcMigrations.key(schemaId, from))
    }

    /**
     * The steps from one version to another, or the gap that stops it.
     *
     * Forward only. Reverse transforms are deliberately not part of this: the pre-migration snapshot
     * is what a rollback uses, and only until the new activation has begun authoritative work - see
     * the specification. A reverse chain would look like a general undo and would not be one.
     */
    chain(schemaId: string, from: number, to: number): readonly RpcMigrationStep[] | RpcMigrationRefusal {
        if (to < from)
            return { schemaId, atVersion: from, why: `v${from} is newer than the v${to} being asked for, and migration is forward only: an old snapshot is what a rollback uses, not a reverse transform` }
        const steps: RpcMigrationStep[] = []
        for (let at = from; at < to; at++) {
            const step = this.at(schemaId, at)
            if (!step) return { schemaId, atVersion: at, why: `no reviewed migration from ${schemaId} v${at} to v${at + 1}, so the chain from v${from} to v${to} cannot be walked` }
            steps.push(step)
        }
        return steps
    }
}

/** Recursively frozen, so a transform that writes to its input fails rather than being obeyed. */
const freeze = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value
    for (const held of Object.values(value as Record<string, unknown>)) freeze(held)
    return Object.freeze(value)
}

class Scribe implements RpcMigrationScribe {
    readonly transformedPaths: string[] = []
    readonly defaultedValues: RpcDefaultedValue[] = []

    transformed(path: string) {
        this.transformedPaths.push(path)
    }

    defaulted(path: string, value: unknown, why: string) {
        if (!why) throw new RpcSnapshotRefused(`a default at ${path} was recorded with no reason; the question nobody can answer later is on what grounds`, path)
        this.defaultedValues.push({ path, value, why })
    }

    impossible(path: string, why: string): never {
        throw new Impossible(path, why)
    }
}

class Impossible extends Error {
    constructor(
        readonly path: string,
        readonly why: string
    ) {
        super(`${path}: ${why}`)
        this.name = 'RpcMigrationImpossible'
    }
}

export interface RpcMigrateOptions {
    readonly schemas: RpcStateSchemas
    readonly migrations: RpcMigrations
    /** Where the chain is heading. The newest version this process knows, by default. */
    readonly toVersion?: number
    /** What is holding the result. Written onto the derived snapshot, which is a new revision's. */
    readonly sourceRevision?: string
}

/**
 * Take a snapshot's held state to another version of its schema.
 *
 * **There is no separate dry run, and that is the point.** A dry run executing different code from
 * the committed one proves nothing about the committed one - so this is a pure function of an
 * immutable snapshot, and a dry run is *calling it and not storing the answer*. Two calls over one
 * input produce the same snapshot in every field, hash included, because nothing here reads a clock:
 * a derived snapshot carries its parent's `capturedAt`, since deriving is not observing.
 *
 * Each step is run **twice** and its two outputs compared. That is how "transforms are
 * deterministic" becomes a checked property rather than a rule in a document: a clock or a random
 * value is caught here, by the only party in a position to catch it. There is deliberately no way to
 * turn it off, because an off switch is what gets flipped when the check fires.
 *
 * The state is `structuredClone`d before each step and then frozen. The clone protects the caller's
 * object; the freeze catches a transform that writes to its input instead of returning a new value.
 * And the clone enforces the rule the whole design rests on - state that cannot be structured-cloned
 * is state living in a language's object layout, which is exactly the state that cannot survive the
 * process that holds it.
 */
export const migrate = async <State = unknown>(snapshot: RpcSnapshotEnvelope, options: RpcMigrateOptions): Promise<RpcMigrationResult<State>> => {
    const { schemas, migrations } = options
    const schemaId = snapshot.stateSchemaId
    const from = snapshot.stateVersion
    const to = options.toVersion ?? schemas.latestOf(schemaId)
    if (to === undefined) return { outcome: 'impossible', refusal: { schemaId, atVersion: from, why: `this process knows no version of ${schemaId}, so there is nothing to migrate towards` } }

    const corrupt = await verifySnapshot(snapshot)
    if (corrupt) return { outcome: 'impossible', refusal: { schemaId, atVersion: from, why: corrupt } }

    const declared = schemas.hashAt(schemaId, from)
    if (declared !== undefined && declared !== snapshot.stateSchemaHash)
        return {
            outcome: 'impossible',
            refusal: { schemaId, atVersion: from, why: `the snapshot says it was validated against ${schemaId} v${from} hashing ${snapshot.stateSchemaHash}, and this process has that version hashing ${declared}` }
        }

    const invalid = schemas.check(schemaId, from, snapshot.heldState)
    if (invalid) return { outcome: 'impossible', refusal: { schemaId, atVersion: from, path: invalid.split(':')[0], why: `the snapshot's own state does not match the schema it declares - ${invalid}` } }

    const assembled = migrations.chain(schemaId, from, to)
    if (!Array.isArray(assembled)) return { outcome: 'impossible', refusal: assembled as RpcMigrationRefusal }

    const records: RpcMigrationRecord[] = []
    let state: unknown = snapshot.heldState
    let inputHash = canonicalText(state)

    for (const step of assembled as readonly RpcMigrationStep[]) {
        const run = () => {
            const scribe = new Scribe()
            let input: unknown
            try {
                input = freeze(structuredClone(state))
            } catch (failure) {
                throw new RpcSnapshotRefused(
                    `${schemaId} v${step.from} cannot be copied for migration (${(failure as Error).message}); state that cannot be structured-cloned lives in this language's object layout, which is the state that cannot survive the process holding it`
                )
            }
            return { output: step.apply(input as never, scribe), scribe }
        }

        let first: ReturnType<typeof run>
        let second: ReturnType<typeof run>
        try {
            first = run()
            second = run()
        } catch (failure) {
            if (failure instanceof Impossible)
                return { outcome: 'impossible', refusal: { stepId: step.id, schemaId, atVersion: step.from, path: failure.path, why: failure.why } }
            throw failure
        }

        const outputText = canonicalText(first.output)
        if (outputText !== canonicalText(second.output))
            return {
                outcome: 'impossible',
                refusal: {
                    stepId: step.id,
                    schemaId,
                    atVersion: step.from,
                    why: `${step.id} produced two different results from one input, so it is reading a clock, a random value or something else outside the state it was given`
                }
            }

        const badOutput = schemas.check(schemaId, step.from + 1, first.output)
        if (badOutput)
            return { outcome: 'impossible', refusal: { stepId: step.id, schemaId, atVersion: step.from, path: badOutput.split(':')[0], why: `${step.id} produced state its own target schema refuses - ${badOutput}` } }

        const outputHash = outputText
        records.push({
            stepId: step.id,
            schemaId,
            fromVersion: step.from,
            toVersion: step.from + 1,
            approval: step.approval,
            transformed: [...first.scribe.transformedPaths],
            defaulted: [...first.scribe.defaultedValues],
            inputHash,
            outputHash
        })
        state = first.output
        inputHash = outputHash
    }

    const targetHash = schemas.hashAt(schemaId, to)
    if (targetHash === undefined) return { outcome: 'impossible', refusal: { schemaId, atVersion: to, why: `this process does not know ${schemaId} v${to}, so it cannot say what the migrated state should be` } }

    const derived = await sealSnapshot<State>({
        // Deriving is not capturing: `held-state-only`, because a migrated state is not a statement
        // about where a running activation had got to even when its parent was.
        captureKind: 'held-state-only',
        componentType: snapshot.componentType,
        componentId: snapshot.componentId,
        sourceRevision: options.sourceRevision ?? snapshot.sourceRevision,
        stateSchemaId: schemaId,
        stateVersion: to,
        stateSchemaHash: targetHash,
        heldState: state as State,
        // Oldest first, and the parent's kept: a snapshot four versions along should be able to say
        // which value was defaulted at v2 without the v2 snapshot being present.
        provenance: [...snapshot.provenance, ...records],
        capturedAt: snapshot.capturedAt,
        parentSnapshotHash: snapshot.contentHash
    })

    return { outcome: records.some((record) => record.defaulted.length > 0) ? 'defaulted' : 'total', snapshot: derived, records }
}
