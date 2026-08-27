import { canonicalText, digestText } from '@source-repo/rpc'
import { RpcSnapshotRefused, type RpcSnapshotEnvelope } from './Envelope.js'

/**
 * What a compiled artifact says about itself.
 *
 * Until now a handoff was between two things this process already knew - two classes in one
 * language, checked by the compiler that built both. Across languages nothing is checked by anything
 * unless it is written down, so the artifact carries a manifest: what component type it implements,
 * which contract at which version, which state schema at which version, what it needs to be allowed
 * to do, and whether it can be changed online at all.
 *
 * **The manifest describes the revision. It does not grant authority.** That sentence is the one
 * rule this file exists to enforce, and it is easy to lose: a manifest is emitted by the artifact,
 * and an artifact that could authorise itself by asserting its own capabilities would make the whole
 * approval path decorative. Every check here takes the manifest as a *claim* and something else - an
 * approval record, a snapshot, an identity policy - as the thing it is checked against.
 */

/**
 * What kind of thing this is.
 *
 * Present so the manifest can be read without knowing what produced it, which is the situation the
 * whole phase is about: a coordinator choosing between a JavaScript and a .NET replacement should
 * not have to infer which it is holding from a file extension.
 */
export type RpcArtifactType = 'javascript' | 'dotnet' | 'wasm' | 'native' | 'source-ir'

/**
 * What the artifact claims about its own suitability for online change.
 *
 * Every field is a claim about the *code*, which is why none of them can be verified by the runtime
 * and all of them have to be declared. `serialisedHandlers` is the one the barrier depends on: a
 * component whose state is changed by anything other than a handler the runtime dispatched is not
 * quiescent when the queue is empty, and no barrier can detect it. Phase 2 recorded that limit in a
 * test; this is where a revision states which side of it it is on.
 */
export interface RpcOnlineChangeProfile {
    readonly supported: boolean
    readonly serialisedHandlers: boolean
    readonly runtimeManagedObligations: boolean
    readonly quiescenceDeadlineMs: number
}

export interface RpcRevisionManifest {
    readonly manifestVersion: number
    readonly componentType: string
    readonly revisionId: string
    readonly artifactType: RpcArtifactType
    /** The digest of the built artifact, taken by whatever built it. Compared, never recomputed here. */
    readonly artifactHash: string
    readonly contract: { readonly id: string; readonly version: number; readonly schemaHash: string }
    readonly state: { readonly schemaId: string; readonly version: number; readonly schemaHash: string }
    readonly requiredCapabilities: readonly string[]
    readonly onlineChange: RpcOnlineChangeProfile
    /** The digest of everything above. Set by `sealManifest`. */
    readonly manifestHash: string
}

/** The version this implementation writes and the highest it reads. */
export const RPC_MANIFEST_VERSION = 1

const hashedForm = (draft: Omit<RpcRevisionManifest, 'manifestHash'>) => ({
    manifestVersion: draft.manifestVersion,
    componentType: draft.componentType,
    revisionId: draft.revisionId,
    artifactType: draft.artifactType,
    artifactHash: draft.artifactHash,
    contract: draft.contract,
    state: draft.state,
    // Sorted, because a manifest listing the same capabilities in a different order is the same
    // manifest, and an artifact rebuilt on a machine that walked its imports differently would
    // otherwise hash to something else and read as a different revision.
    requiredCapabilities: [...draft.requiredCapabilities].sort(),
    onlineChange: draft.onlineChange
})

const required = ['componentType', 'revisionId', 'artifactType', 'artifactHash'] as const

/** Name the manifest by its content, refusing one that cannot say what it is. */
export const sealManifest = async (draft: Omit<RpcRevisionManifest, 'manifestHash' | 'manifestVersion'> & { manifestVersion?: number }): Promise<RpcRevisionManifest> => {
    for (const field of required) if (!draft[field]) throw new RpcSnapshotRefused(`a revision manifest states its ${field}`, field)
    if (!draft.contract?.schemaHash) throw new RpcSnapshotRefused('a revision manifest states the hash of the contract it implements', 'contract.schemaHash')
    if (!draft.state?.schemaHash) throw new RpcSnapshotRefused('a revision manifest states the hash of the state schema it holds', 'state.schemaHash')
    if (draft.onlineChange.supported && draft.onlineChange.quiescenceDeadlineMs <= 0)
        throw new RpcSnapshotRefused('a revision that supports online change states a quiescence deadline, because a barrier with no deadline is a component that stops answering for good', 'onlineChange.quiescenceDeadlineMs')

    const sealed = { ...draft, manifestVersion: draft.manifestVersion ?? RPC_MANIFEST_VERSION, requiredCapabilities: [...draft.requiredCapabilities].sort() }
    return Object.freeze({ ...sealed, manifestHash: await digestText(canonicalText(hashedForm(sealed))) })
}

/** Recompute the hash. The reason it does not match, or nothing. */
export const verifyManifest = async (manifest: RpcRevisionManifest): Promise<string | undefined> => {
    const expected = await digestText(canonicalText(hashedForm(manifest)))
    return expected === manifest.manifestHash ? undefined : `manifest for ${manifest.revisionId} hashes to ${expected}, and carries ${manifest.manifestHash}`
}

/**
 * Whether a revision can take over a particular snapshot.
 *
 * This is the check that makes cross-language handoff mean something. The two artifacts share no
 * compiler, no type system and no runtime; what they share is a component type, a contract hash and
 * a state schema hash, and if those agree then the successor is holding the same description of the
 * same values that the incumbent was. If they do not, nothing else about the two being
 * interface-compatible matters.
 *
 * The state *version* may legitimately differ - that is what migration is for - so a mismatch there
 * is reported separately from a mismatch of identity, which is never migratable.
 */
export const reconcile = (manifest: RpcRevisionManifest, snapshot: RpcSnapshotEnvelope): { readonly agreed: true; readonly migrationNeeded: boolean } | { readonly agreed: false; readonly why: string } => {
    if (manifest.componentType !== snapshot.componentType)
        return { agreed: false, why: `${manifest.revisionId} implements ${manifest.componentType} and this snapshot is of ${snapshot.componentType}: two component types are not two versions of one` }
    if (manifest.state.schemaId !== snapshot.stateSchemaId)
        return { agreed: false, why: `${manifest.revisionId} holds ${manifest.state.schemaId} and this snapshot carries ${snapshot.stateSchemaId}: a schema id is stable for the life of a component type, so two of them are two different states` }
    if (manifest.state.version === snapshot.stateVersion && manifest.state.schemaHash !== snapshot.stateSchemaHash)
        return {
            agreed: false,
            why: `${manifest.revisionId} and this snapshot both claim ${manifest.state.schemaId} v${manifest.state.version} and describe it differently (${manifest.state.schemaHash} against ${snapshot.stateSchemaHash}): a published version cannot be redefined, and one of these two was`
        }
    if (manifest.state.version < snapshot.stateVersion)
        return { agreed: false, why: `${manifest.revisionId} holds ${manifest.state.schemaId} v${manifest.state.version} and this snapshot is at v${snapshot.stateVersion}: migration is forward only, and this would be a rollback` }
    return { agreed: true, migrationNeeded: manifest.state.version !== snapshot.stateVersion }
}

/**
 * What a deployment has decided a component may be, independently of what any artifact says.
 *
 * The four concerns the design keeps apart meet here: this is identity policy and artifact
 * authorisation, and the manifest is the claim being measured against them.
 */
export interface RpcIdentityPolicy {
    readonly componentId: string
    readonly componentType: string
    /** The artifact digests approved for this identity. An empty list approves nothing, not everything. */
    readonly approvedArtifacts: readonly string[]
    /** The most this identity may ever be granted, whatever a revision asks for. */
    readonly capabilityEnvelope: readonly string[]
    /** Whether this identity may be changed while running at all. Some plant is not eligible, by decision. */
    readonly onlineChangePermitted: boolean
}

/**
 * Whether this artifact is allowed to be this component.
 *
 * Returns the reason it is not, and there are four of them because they are four different
 * conversations: the wrong type is a mistake, an unapproved artifact needs a deployment approval, a
 * capability outside the envelope needs the envelope widened by whoever owns the identity, and an
 * identity that is not eligible for online change needs a controlled restart instead. Collapsing
 * them into `false` would leave every one of those as the same shrug.
 */
export const authorised = (manifest: RpcRevisionManifest, policy: RpcIdentityPolicy): string | undefined => {
    if (manifest.componentType !== policy.componentType)
        return `${policy.componentId} is a ${policy.componentType} and ${manifest.revisionId} implements ${manifest.componentType}`
    if (!policy.approvedArtifacts.includes(manifest.artifactHash))
        return `${manifest.revisionId} (${manifest.artifactHash}) is not among the artifacts approved for ${policy.componentId}: a manifest describes a revision, it does not approve one`
    const beyond = manifest.requiredCapabilities.filter((capability) => !policy.capabilityEnvelope.includes(capability))
    if (beyond.length)
        return `${manifest.revisionId} requires ${beyond.join(', ')}, which ${policy.componentId} is not permitted to grant - an interface-compatible replacement does not inherit an authority the identity never had`
    if (!policy.onlineChangePermitted) return `${policy.componentId} is not eligible for online change, so ${manifest.revisionId} is deployed by a controlled restart rather than a handoff`
    if (!manifest.onlineChange.supported) return `${manifest.revisionId} does not support online change and says so in its own manifest`
    if (!manifest.onlineChange.serialisedHandlers)
        return `${manifest.revisionId} does not serialise its handlers, so no barrier can establish that it is quiescent - the queue being empty would say nothing about what is running`
    return undefined
}
