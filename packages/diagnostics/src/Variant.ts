import { canonicalText, digestText } from '@source-repo/rpc'
import type { RpcSourceSpan } from './Catalogue.js'

/**
 * What a diagnostic variant claims to be, and what has to be true before anybody runs it.
 *
 * A diagnostic variant is the node's own source with probes generated into it. That is a licence to
 * put *different code* on a plant in order to watch the code that was approved, so the whole design
 * rests on one claim: **the variant differs from the approved revision in probes and nothing else.**
 * This file is where that claim is made checkable, and it is deliberately built before anything can
 * generate a variant - the same order the handoff work ran in, where admissibility was provable
 * before a handoff could be performed. A rule written after the thing it governs is a rule written
 * to fit it.
 *
 * **The types only, and hashes rather than syntax trees.** A node decides whether to activate a
 * variant, and a node has no compiler: it holds the hash of what it approved and compares. The walk
 * that reduces a variant back to its base - strip the probes, print, hash - is in
 * `@source-repo/rpc-cli`, with the compiler, exactly as the binding catalogue's walk is. That split
 * is what keeps this package's dependency list one line long.
 *
 * Verification is not activation, and this phase does neither. `diagnosticVariants` stays `false` in
 * the advertised capabilities until something can actually build and swap one, because a flag that
 * ran ahead of the code would be the one thing the capability set exists to prevent.
 */

/** What a probe observes. The design's seven, and a variant may contain no other kind. */
export type RpcProbeKind = 'value' | 'statement' | 'condition' | 'branch' | 'function-entry' | 'function-exit' | 'breakpoint'

export interface RpcProbeDefinition {
    /**
     * Stable within one semantic revision and one plan-generation scheme, and **not** across
     * revisions. A probe id that looked stable across an edit would let a session carry a watch onto
     * a line that has moved, which is the same failure as a value drawn beside the wrong source.
     */
    readonly probeId: string
    readonly semanticRevisionId: string
    readonly fileId: string
    readonly span: RpcSourceSpan
    readonly kind: RpcProbeKind
    readonly symbolId?: string
    readonly displayText?: string
    readonly declaredType?: string
    readonly containingFunctionId?: string
    /** Carried from the declaration, so a later phase that can capture honours it before capturing. */
    readonly sensitivity?: string
}

export interface RpcDiagnosticVariantManifest {
    readonly diagnosticManifestVersion: number

    readonly componentId: string
    /** The revision this is a derivative *of*. A variant never names a revision of its own. */
    readonly semanticRevisionId: string
    readonly sourceBundleHash: string
    readonly baseArtifactHash: string

    readonly artifactVariantId: string
    readonly artifactVariantHash: string
    readonly probePlanId: string
    readonly probePlanHash: string

    /**
     * The three hashes that say this is the same component to everybody but a debugger.
     *
     * Carried on the manifest rather than recomputed at activation, because the party that must
     * agree they are unchanged is the node holding what it approved - and a variant that computed
     * its own idea of "unchanged" would be marking its own homework.
     */
    readonly contractHash: string
    readonly persistentStateSchemaHash: string
    readonly nonDiagnosticCapabilityHash: string

    readonly diagnosticsAdapter: {
        readonly language: string
        readonly adapterVersion: string
    }

    /** Over every field above. What makes the plan, the artifact and the adapter version immutable. */
    readonly manifestHash: string
}

export const DIAGNOSTIC_MANIFEST_VERSION = 1

/**
 * The one capability a variant is allowed to have that its base does not.
 *
 * Named as a constant because "the only added capability is the bounded diagnostics sink" is a rule
 * somebody has to be able to read, and a rule that lives as a string literal inside a comparison is
 * a rule nobody reads.
 */
export const DIAGNOSTICS_SINK_CAPABILITY = 'diagnostics.telemetry'

/** Refused because a variant could not be shown to be a derivative rather than a different program. */
export class RpcVariantRefused extends Error {
    constructor(
        readonly field: string,
        message: string
    ) {
        super(message)
        this.name = 'RpcVariantRefused'
    }
}

/**
 * The probe plan's identity, taken over the plan and nothing else.
 *
 * Sorted by probe id first, so two planners that walked a file in different orders produce the same
 * hash for the same set of probes - the plan is a set of observations, and calling two orderings of
 * one set two different plans would make the hash mean "who generated it" instead of "what it is".
 */
export const probePlanHash = async (probes: readonly RpcProbeDefinition[]): Promise<string> => {
    const ordered = [...probes].sort((a, b) => (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0))
    return digestText(canonicalText(ordered))
}

const required = [
    'componentId',
    'semanticRevisionId',
    'sourceBundleHash',
    'baseArtifactHash',
    'artifactVariantId',
    'artifactVariantHash',
    'probePlanId',
    'probePlanHash',
    'contractHash',
    'persistentStateSchemaHash',
    'nonDiagnosticCapabilityHash'
] as const

const hashedForm = (manifest: Omit<RpcDiagnosticVariantManifest, 'manifestHash'>) => ({ ...manifest })

/**
 * Seal a manifest, refusing one that cannot answer a question its reader will ask.
 *
 * Refused where it is *written* rather than where it is used, for the reason the snapshot envelope
 * gives: the party holding the missing context is the one building the thing, and a manifest that
 * reached a node with an empty `contractHash` would be refused there by somebody with no way to
 * find out what it should have been.
 */
export const sealVariantManifest = async (
    draft: Omit<RpcDiagnosticVariantManifest, 'manifestHash' | 'diagnosticManifestVersion'> & { diagnosticManifestVersion?: number }
): Promise<RpcDiagnosticVariantManifest> => {
    for (const field of required) if (!draft[field]) throw new RpcVariantRefused(field, `a diagnostic variant manifest states its ${field}`)
    if (!draft.diagnosticsAdapter?.language || !draft.diagnosticsAdapter?.adapterVersion)
        throw new RpcVariantRefused(
            'diagnosticsAdapter',
            'a diagnostic variant manifest names the adapter and version that transformed it: which transformer produced a derivative is part of what a reviewer is being asked to accept'
        )
    if (draft.artifactVariantHash === draft.baseArtifactHash)
        throw new RpcVariantRefused(
            'artifactVariantHash',
            'the variant hashes to the same artifact as its base, so it carries no probes - an instrumented build that is byte-identical to the approved one is a build step that silently did nothing'
        )
    const sealed = { ...draft, diagnosticManifestVersion: draft.diagnosticManifestVersion ?? DIAGNOSTIC_MANIFEST_VERSION }
    return Object.freeze({ ...sealed, manifestHash: await digestText(canonicalText(hashedForm(sealed))) })
}

/** Recompute the hash. The reason it does not match, or nothing. */
export const verifyVariantManifest = async (manifest: RpcDiagnosticVariantManifest): Promise<string | undefined> => {
    const { manifestHash, ...rest } = manifest
    const expected = await digestText(canonicalText(hashedForm(rest)))
    return expected === manifestHash ? undefined : `the manifest for ${manifest.artifactVariantId} hashes to ${expected}, not the ${manifestHash} it carries: something changed after it was sealed`
}

/** What the node approved and is currently running. The thing a variant is measured against. */
export interface RpcApprovedRevision {
    readonly componentId: string
    readonly semanticRevisionId: string
    readonly sourceBundleHash: string
    readonly artifactHash: string
    readonly contractHash: string
    readonly persistentStateSchemaHash: string
    readonly nonDiagnosticCapabilityHash: string
}

/**
 * What the compiler found when it reduced the variant back to its base.
 *
 * Two digests and a plan, because that is all a node needs and all it can check. The walk that
 * produces them runs where the compiler is; what crosses to the node is the answer, and the node
 * still compares it against what *it* holds rather than trusting the comparison already made.
 */
export interface RpcDerivativeEvidence {
    /** The canonical semantic digest of the approved source, taken by the party that stripped. */
    readonly baseSemanticDigest: string
    /** The same digest, taken of the variant with every recognised probe removed. */
    readonly strippedSemanticDigest: string
    /** The probes the strip actually found, so a plan cannot claim probes the artifact lacks. */
    readonly probes: readonly RpcProbeDefinition[]
    /** Capabilities the variant requires beyond its base's. Empty is the ordinary case. */
    readonly addedCapabilities: readonly string[]
}

/**
 * Whether this variant may be activated, or the first reason it may not.
 *
 * The design's seven verification rules, each with its own sentence, because they are seven
 * different conversations. A revision mismatch means somebody built against source that has moved
 * on. A semantic difference means the transformer changed the program - the one failure this whole
 * file exists to catch. A changed contract or state schema means the successor is not the same
 * component, and no amount of debugging value justifies swapping it in. A widened capability means
 * an artifact granting itself authority its base never had, which is exactly the shape a debugger
 * would take if it were being used as a way in.
 *
 * Refuses on the first, rather than reporting all seven: a partial pass reads as progress, and the
 * decision here is binary. The order runs cheapest and most-likely-wrong first.
 */
export const admissibleVariant = async (
    manifest: RpcDiagnosticVariantManifest,
    approved: RpcApprovedRevision,
    evidence: RpcDerivativeEvidence
): Promise<string | undefined> => {
    const tampered = await verifyVariantManifest(manifest)
    if (tampered) return tampered

    if (manifest.componentId !== approved.componentId)
        return `${manifest.artifactVariantId} is a variant of ${manifest.componentId} and ${approved.componentId} is what is running: an instrumented build of a different component is not a debugger, it is a replacement`
    if (manifest.semanticRevisionId !== approved.semanticRevisionId || manifest.sourceBundleHash !== approved.sourceBundleHash)
        return `${manifest.artifactVariantId} was built from ${manifest.semanticRevisionId} and ${approved.componentId} is running ${approved.semanticRevisionId}: probes generated against source that has since moved would be drawn beside lines that mean something else`
    if (manifest.baseArtifactHash !== approved.artifactHash)
        return `${manifest.artifactVariantId} names a base artifact that is not the one running: two builds of one revision are still two artifacts, and only one of them is the thing being observed`

    // The rule the rest of this exists to support. Everything above establishes *which* base;
    // this establishes that the variant is that base plus probes and nothing else.
    if (evidence.baseSemanticDigest !== evidence.strippedSemanticDigest)
        return `removing ${manifest.artifactVariantId}'s probes does not reproduce the approved source: the transformation changed the program, so nothing observed through it would be evidence about the program that was approved`

    if (manifest.contractHash !== approved.contractHash)
        return `${manifest.artifactVariantId} does not implement the same contract as the revision it instruments, so callers would be talking to a different component while being told they were debugging this one`
    if (manifest.persistentStateSchemaHash !== approved.persistentStateSchemaHash)
        return `${manifest.artifactVariantId} holds a different persistent state schema: a diagnostic swap carries state across unmigrated, and a schema that moved would be restored into a shape that cannot hold it`
    if (manifest.nonDiagnosticCapabilityHash !== approved.nonDiagnosticCapabilityHash)
        return `${manifest.artifactVariantId} requires different non-diagnostic capabilities than its base, so instrumenting a component would be the act that changed what it is allowed to do`

    const beyond = evidence.addedCapabilities.filter((capability) => capability !== DIAGNOSTICS_SINK_CAPABILITY)
    if (beyond.length)
        return `${manifest.artifactVariantId} asks for ${beyond.join(', ')} beyond its base, and the only capability a variant may add is ${DIAGNOSTICS_SINK_CAPABILITY} - anything else is an artifact using instrumentation as a way to widen its own authority`

    const planned = await probePlanHash(evidence.probes)
    if (planned !== manifest.probePlanHash)
        return `${manifest.artifactVariantId}'s manifest names probe plan ${manifest.probePlanHash} and the artifact carries ${planned}: the plan a reviewer approved is not the plan compiled in`

    return undefined
}
