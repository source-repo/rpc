import { RpcSnapshotRefused, type RpcSnapshotEnvelope } from './Envelope.js'
import type { RpcObligation, RpcObligations } from './Obligations.js'

/**
 * The form a snapshot takes when it leaves the process that made it.
 *
 * Everything before this phase could be in-memory objects, because both ends were the same language
 * and often the same process. Cross-language handoff is where a snapshot has to survive being
 * written down - and JSON, which is what it will be written as, cannot carry two of the things the
 * envelope depends on.
 *
 * **Positions are decimal strings, not numbers.** JSON has one numeric type and it is an IEEE-754
 * double. `lastAppliedInputSequence` past 2^53 rounds, silently, to a value near the one intended -
 * and a sequence position that rounds is a successor that reprocesses input or skips it. There is no
 * indication at the time and no way to tell afterwards which happened. The four positions and every
 * obligation deadline are therefore strings the whole way across, converted at the edges where the
 * conversion is visible.
 *
 * **Held state must be portable, which is stronger than cloneable.** Phase 1's rule was that state
 * must survive `structuredClone`, because a closure cannot be handed to another process. This one is
 * that it must survive JSON, because a `Date`, a `Uint8Array`, a `Map` and a `bigint` all clone
 * perfectly and none of them cross a language boundary as themselves. A component that wants to be
 * replaceable by one written in another language holds its state in the vocabulary its declared
 * schema can describe, and this is where that stops being advice.
 *
 * The content hash does not change. It is taken over the envelope's own values - real integers,
 * through the canonical encoder both languages already implement - so a snapshot written here,
 * parsed in C#, and hashed there produces the same digest. That is the whole claim of this file, and
 * the fixtures under `packages/conformance` are how it is checked rather than asserted.
 */

/** Every field of the envelope, with the positions as decimal strings. Directly `JSON.stringify`-able. */
export interface RpcPortableSnapshot {
    readonly snapshotFormatVersion: number
    readonly snapshotId: string
    readonly captureKind: RpcSnapshotEnvelope['captureKind']
    readonly componentType: string
    readonly componentId: string
    readonly sourceRevision: string
    readonly stateSchemaId: string
    readonly stateVersion: number
    readonly stateSchemaHash: string
    readonly activationEpoch?: string
    readonly logicalTime?: string
    readonly lastAppliedInputSequence?: string
    readonly lastCommittedOutputSequence?: string
    readonly heldState: unknown
    readonly obligations?: RpcPortableObligations
    readonly provenance: RpcSnapshotEnvelope['provenance']
    readonly capturedAt: string
    readonly parentSnapshotHash?: string
    readonly contentHash: string
}

/** The manifest, with every deadline and cursor as a decimal string for the same reason. */
export type RpcPortableObligations = { readonly [K in keyof RpcObligations]: readonly Record<string, unknown>[] }

/**
 * The obligation fields that are integers, by name, so both directions convert the same set.
 *
 * A list rather than a walk that guesses, because coming back there is nothing to guess *from*: a
 * decimal string is a decimal string, and `idempotencyKey: "12"` must stay a string while
 * `sequence: "12"` must not. Writing them out is also what makes an obligation kind added later
 * fail here rather than silently hand a successor a deadline as text - `interval` and `position` are
 * on this list because they were missed once, and both are nested or rare enough that the round trip
 * was the only thing that would have caught it.
 */
const POSITIONS = new Set(['dueAt', 'capturedAt', 'expiresAt', 'lastAcknowledgedSequence', 'sequence', 'position', 'interval'])

const OBLIGATION_GROUPS = ['timers', 'outboundCalls', 'inboundWork', 'subscriptions', 'pendingPublications', 'leases', 'sequences', 'watchdogs'] as const

/**
 * What JSON can carry, checked by walking rather than by trying and seeing.
 *
 * A `JSON.stringify` that succeeded would prove nothing here: it turns a `Date` into a string and a
 * `Uint8Array` into an object with numeric keys, both silently, and the value that comes back on the
 * other side is not the value that went in. The failure is not an exception, it is a plant reading a
 * timestamp as text - so the check has to be for what the value *is*, before anything encodes it.
 */
const unportable = (value: unknown, path: string): string | undefined => {
    if (value === null) return undefined
    switch (typeof value) {
        case 'boolean':
        case 'string':
            return undefined
        case 'number':
            return Number.isFinite(value) ? undefined : `${path} is ${String(value)}, and JSON has no way to write it - a state that can be NaN needs a value the schema can describe`
        case 'bigint':
            return `${path} is a bigint, which JSON cannot carry: hold a value this large as a decimal string, the way the envelope's own positions are`
        case 'undefined':
            return `${path} is undefined, which JSON drops from an object and turns into null in an array - say null, or leave the key out`
        case 'function':
        case 'symbol':
            return `${path} is a ${typeof value}, which is the shape of everything that cannot survive the process holding it`
    }
    if (value instanceof Date) return `${path} is a Date: cross a language boundary as an ISO-8601 string, declared as a date in the schema, so the two ends agree on the time zone rather than on the object`
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `${path} is binary: cross as base64, declared as bytes in the schema, so the encoding is stated rather than whichever one each side guessed`
    if (value instanceof Map || value instanceof Set) return `${path} is a ${value.constructor.name}, which clones and does not travel: a record or an array says the same thing in a form both ends can read`
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            const refusal = unportable(item, `${path}[${index}]`)
            if (refusal) return refusal
        }
        return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return `${path} is a ${(value as object).constructor?.name ?? 'class instance'}: what crosses is its data, and a class is the part that has to be rebuilt from that data on the far side`
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const refusal = unportable(item, `${path}.${key}`)
        if (refusal) return refusal
    }
    return undefined
}

/** The check on its own, for a caller that wants to know before it has a snapshot to refuse. */
export const portableState = (state: unknown): string | undefined => unportable(state, 'heldState')

/** Every integer in an obligation becomes a decimal string, at whatever depth it sits. */
const positioned = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(positioned)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, positioned(item)]))
    return value
}

/** And back, by name, at whatever depth - `periodic.interval` is the one that is not at the top. */
const depositioned = (value: unknown, where: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => depositioned(item, `${where}[${index}]`))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
            const at = `${where}.${key}`
            if (!POSITIONS.has(key)) return [key, depositioned(item, at)]
            return [key, asPosition(item, at)]
        })
    )
}

/**
 * One position, from the decimal string it crosses as.
 *
 * A number is refused rather than converted, and that is the whole reason the field is a string.
 * Something that arrived as a JSON number has already been through a double: if it was large enough
 * to matter it is already the wrong value, and converting it now would launder a rounding error into
 * an authoritative sequence position. Nothing here can tell whether it survived, and guessing wrong
 * means a successor that replays input or skips it.
 */
const asPosition = (value: unknown, path: string): bigint => {
    if (typeof value === 'number') throw new RpcSnapshotRefused(`${path} is a JSON number, and a position crosses as a decimal string - a number here has already been through a double`, path)
    if (typeof value !== 'string') throw new RpcSnapshotRefused(`${path} is ${typeof value}, and a position crosses as a decimal string`, path)
    if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new RpcSnapshotRefused(`${path} is "${value}", which is not a decimal integer`, path)
    return BigInt(value)
}

/**
 * Write a snapshot out.
 *
 * Refuses rather than encoding around a problem. A snapshot that left here with its held state
 * quietly mangled would verify against its own hash - the hash is over the values, and the values
 * are what changed - and the failure would surface as a plant reading a wrong number, days later,
 * with nothing to point at.
 */
export const toPortable = <State>(snapshot: RpcSnapshotEnvelope<State>): RpcPortableSnapshot => {
    const refusal = portableState(snapshot.heldState)
    if (refusal) throw new RpcSnapshotRefused(`snapshot ${snapshot.snapshotId} cannot be written down: ${refusal}`, 'heldState')

    const obligations = snapshot.obligations
        ? (Object.fromEntries(OBLIGATION_GROUPS.map((group) => [group, (snapshot.obligations![group] as readonly RpcObligation[]).map(positioned)])) as unknown as RpcPortableObligations)
        : undefined

    return {
        snapshotFormatVersion: snapshot.snapshotFormatVersion,
        snapshotId: snapshot.snapshotId,
        captureKind: snapshot.captureKind,
        componentType: snapshot.componentType,
        componentId: snapshot.componentId,
        sourceRevision: snapshot.sourceRevision,
        stateSchemaId: snapshot.stateSchemaId,
        stateVersion: snapshot.stateVersion,
        stateSchemaHash: snapshot.stateSchemaHash,
        ...(snapshot.activationEpoch !== undefined ? { activationEpoch: snapshot.activationEpoch.toString() } : {}),
        ...(snapshot.logicalTime !== undefined ? { logicalTime: snapshot.logicalTime.toString() } : {}),
        ...(snapshot.lastAppliedInputSequence !== undefined ? { lastAppliedInputSequence: snapshot.lastAppliedInputSequence.toString() } : {}),
        ...(snapshot.lastCommittedOutputSequence !== undefined ? { lastCommittedOutputSequence: snapshot.lastCommittedOutputSequence.toString() } : {}),
        heldState: snapshot.heldState,
        ...(obligations ? { obligations } : {}),
        provenance: snapshot.provenance,
        capturedAt: snapshot.capturedAt,
        ...(snapshot.parentSnapshotHash !== undefined ? { parentSnapshotHash: snapshot.parentSnapshotHash } : {}),
        contentHash: snapshot.contentHash
    }
}

/**
 * Read a snapshot back.
 *
 * Does not verify the hash, deliberately: parsing and verifying are separate acts and a caller has
 * to be able to say which one failed. `verifySnapshot` is the next call, and the two together are
 * what "this is the snapshot that was written" means.
 */
export const fromPortable = <State>(portable: RpcPortableSnapshot): RpcSnapshotEnvelope<State> => {
    const obligations = portable.obligations
        ? (Object.fromEntries(OBLIGATION_GROUPS.map((group) => [group, (portable.obligations![group] ?? []).map((one, index) => depositioned(one, `obligations.${group}[${index}]`))])) as unknown as RpcObligations)
        : undefined

    return Object.freeze({
        snapshotFormatVersion: portable.snapshotFormatVersion,
        snapshotId: portable.snapshotId,
        captureKind: portable.captureKind,
        componentType: portable.componentType,
        componentId: portable.componentId,
        sourceRevision: portable.sourceRevision,
        stateSchemaId: portable.stateSchemaId,
        stateVersion: portable.stateVersion,
        stateSchemaHash: portable.stateSchemaHash,
        ...(portable.activationEpoch !== undefined ? { activationEpoch: asPosition(portable.activationEpoch, 'activationEpoch') } : {}),
        ...(portable.logicalTime !== undefined ? { logicalTime: asPosition(portable.logicalTime, 'logicalTime') } : {}),
        ...(portable.lastAppliedInputSequence !== undefined ? { lastAppliedInputSequence: asPosition(portable.lastAppliedInputSequence, 'lastAppliedInputSequence') } : {}),
        ...(portable.lastCommittedOutputSequence !== undefined ? { lastCommittedOutputSequence: asPosition(portable.lastCommittedOutputSequence, 'lastCommittedOutputSequence') } : {}),
        heldState: portable.heldState as State,
        ...(obligations ? { obligations } : {}),
        provenance: portable.provenance,
        capturedAt: portable.capturedAt,
        ...(portable.parentSnapshotHash !== undefined ? { parentSnapshotHash: portable.parentSnapshotHash } : {}),
        contentHash: portable.contentHash
    }) as RpcSnapshotEnvelope<State>
}

/**
 * The bytes. Two spaces, sorted keys nowhere - this is a document people read in a pull request, not
 * a digest input, and the digest has its own canonical form that does not care how this is spaced.
 */
export const portableText = <State>(snapshot: RpcSnapshotEnvelope<State>): string => JSON.stringify(toPortable(snapshot), null, 4) + '\n'
