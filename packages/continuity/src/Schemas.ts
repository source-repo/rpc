import { canonicalText, digestText, validateValue, type RpcSchema, type TypeNode } from '@source-repo/rpc'
import { RpcSnapshotRefused } from './Envelope.js'

/**
 * What a component's held state is allowed to be, at one version of it.
 *
 * The shape language is the library's own `TypeNode` rather than a second one, and that is not
 * economy. A component's state is already described by `TypeNode` in the contract the extractor
 * writes, already validated against it on publish, and already ruled on by the compatibility
 * checker - so a migration that validated against a *different* description of the same state would
 * be the place the two quietly disagreed, and it would disagree about whether a plant's values are
 * admissible.
 */
export interface RpcStateSchema {
    /** What this state is, across every version of it. Stable for the life of the component type. */
    readonly schemaId: string
    /** Which version this description is. Adjacent versions are what a migration steps between. */
    readonly version: number
    readonly schema: TypeNode
    /** Named types the schema refers to, exactly as a contract carries them. */
    readonly types?: RpcSchema['types']
}

/**
 * The digest of a schema, which is what a snapshot carries so it can say what it was validated
 * against without the schema being present.
 *
 * Over the canonical form, so a description written with its fields in a different order is the same
 * description. The id and the version are inside it, so one shape reused at two versions - which is
 * ordinary, since most versions change one field - still hashes to two different values.
 */
export const stateSchemaHash = (schema: RpcStateSchema): Promise<string> =>
    digestText(canonicalText({ schemaId: schema.schemaId, version: schema.version, schema: schema.schema, types: schema.types ?? {} }))

/**
 * Every version of every state this process knows how to read.
 *
 * A registry rather than a lookup on the component, because the thing doing the migrating is not the
 * component: an old snapshot's schema belongs to a revision that is no longer running, and the whole
 * exercise is reading values written by a program that is gone.
 */
export class RpcStateSchemas {
    private readonly byVersion = new Map<string, RpcStateSchema>()
    private readonly hashes = new Map<string, string>()

    private static key(schemaId: string, version: number) {
        // NUL, written as an escape and never as the byte: it cannot occur in a schema id, so no
        // clever id can make two schemas one - and a literal control character makes the file binary
        // to everything that sniffs content. See CLAUDE.md.
        return `${schemaId}\u0000${version}`
    }

    /**
     * Add a version.
     *
     * Registering the same version twice with a *different* shape is refused rather than replacing
     * the first. A schema version is a published fact - snapshots in the field carry its hash - so
     * redefining one in place is how a snapshot comes to claim it was validated against something it
     * was not. Registering the identical shape again is harmless and allowed, since a process
     * assembling its registry from several modules will do it.
     */
    async register(schema: RpcStateSchema): Promise<this> {
        if (!schema.schemaId) throw new RpcSnapshotRefused('a state schema has an id', 'schemaId')
        if (!Number.isInteger(schema.version) || schema.version < 0)
            throw new RpcSnapshotRefused(`a state schema version is a non-negative integer, not ${String(schema.version)}`, 'version')
        const key = RpcStateSchemas.key(schema.schemaId, schema.version)
        const hash = await stateSchemaHash(schema)
        const held = this.hashes.get(key)
        if (held !== undefined && held !== hash)
            throw new RpcSnapshotRefused(
                `${schema.schemaId} v${schema.version} is already registered with a different shape (${held} against ${hash}); a version that has been published cannot be redefined, because snapshots in the field carry its hash`
            )
        this.byVersion.set(key, schema)
        this.hashes.set(key, hash)
        return this
    }

    /** One version, or nothing where this process does not know it. */
    at(schemaId: string, version: number): RpcStateSchema | undefined {
        return this.byVersion.get(RpcStateSchemas.key(schemaId, version))
    }

    /** The hash of a registered version, for putting on a snapshot. */
    hashAt(schemaId: string, version: number): string | undefined {
        return this.hashes.get(RpcStateSchemas.key(schemaId, version))
    }

    /** The versions of one schema this process knows, ascending. */
    versionsOf(schemaId: string): readonly number[] {
        return [...this.byVersion.values()]
            .filter((schema) => schema.schemaId === schemaId)
            .map((schema) => schema.version)
            .sort((a, b) => a - b)
    }

    /** The newest version of one schema, which is what a migration chain is heading for. */
    latestOf(schemaId: string): number | undefined {
        return this.versionsOf(schemaId).at(-1)
    }

    /**
     * Whether a state payload is what the schema says, naming the field and reason when it is not.
     *
     * Through the library's own `validateValue`, which already answers with a path - "expected
     * number" three levels into a state is not much help, and a migration's whole job is to say
     * *which* field it could not carry.
     */
    check(schemaId: string, version: number, state: unknown): string | undefined {
        const schema = this.at(schemaId, version)
        if (!schema) return `this process does not know ${schemaId} v${version}, so it cannot say whether the state is valid`
        return validateValue(state, schema.schema, schema.types ?? {}, 'state')
    }
}
