/**
 * Where a component's values are written down, and what a node will and will not do with that.
 *
 * The types only, with nothing that reads a file or opens a link, so a browser can hold them. The
 * service that serves them is the module beside this one; the walk that produces them is in
 * `@source-repo/rpc-cli`, where the compiler already is.
 *
 * **The first phase of the diagnostics design, and the whole of its economy: this carries no
 * values.** Props and state are already observable - a subscriber receives them, `authorize()` has
 * already ruled on them, a projection has already narrowed them - so the only thing missing from a
 * PLC-style live view is *where each one is declared*. That is static, known at build time, and
 * costs the running artifact nothing.
 *
 * Which makes the design's third acceptance criterion - that a user cannot obtain a field through
 * source view that they could not obtain through ordinary authorised observation - a fact about the
 * architecture rather than a check somebody has to remember to write. There is no second data path
 * to secure, because there is no second data path.
 */

export interface RpcSourceSpan {
    readonly startLine: number
    readonly startColumn: number
    readonly endLine: number
    readonly endColumn: number
}

export interface RpcSourceBinding {
    /** The path as Source RPC spells it: `state`, `state.zones`, `state.zones.top.setpoint`. */
    readonly sourceRpcPath: string
    /** Which file, by the id the catalogue uses. Relative to the project root, never absolute. */
    readonly fileId: string
    /**
     * Where it is written. A list because a path can be declared in more than one place - an
     * interface and a class that narrows it - though the first phase emits the declaration only.
     */
    readonly spans: readonly RpcSourceSpan[]
    /** How the source spells the type, for a tooltip. Not the schema, which the contract carries. */
    readonly declaredType: string
    /**
     * What the field holds, where the source says. A viewer draws a marker instead of a value.
     *
     * Read-only visibility is not harmless: a value can be a credential, a production quantity or
     * somebody's name. Classification belongs beside the declaration because that is where the
     * person who knows is, and it is honoured before capture where a later phase can capture at all.
     */
    readonly sensitivity?: string
}

/** One file the catalogue refers to, and what it hashed to when the catalogue was built. */
export interface RpcSourceFile {
    readonly fileId: string
    readonly contentHash: string
    readonly lines: number
}

export interface RpcSourceCatalogue {
    readonly catalogueVersion: number
    /**
     * What this catalogue describes, and the only thing a viewer may show it against.
     *
     * A value drawn beside source that is not the source that is running is worse than no value at
     * all: it is a number somebody will act on, positioned by a line that means something else. So
     * every consumer compares this first, and a mismatch disables the overlay rather than
     * approximating it.
     */
    readonly semanticRevisionId: string
    readonly sourceBundleHash: string
    readonly files: readonly RpcSourceFile[]
    readonly components: { readonly [componentType: string]: readonly RpcSourceBinding[] }
}

export const SOURCE_CATALOGUE_VERSION = 1

/** What a diagnostic request says it expects to be looking at. */
export interface RpcActiveSourceIdentity {
    readonly componentType: string
    readonly semanticRevisionId: string
    readonly sourceBundleHash: string
    /** The activation this identity belongs to, so data from an old one is never drawn on a new one. */
    readonly activationEpoch: string
}

/**
 * What a node will do, said out loud so a client never assumes.
 *
 * Every later phase's flag is here and false, which is the point of listing them: a viewer that
 * finds `exactPause` absent cannot tell "this node cannot" from "this protocol version had not
 * thought of it", and one that finds it `false` can.
 */
export interface RpcDiagnosticsCapabilities {
    readonly protocolVersion: number

    readonly sourceAvailable: boolean
    readonly sourceLinkedProps: boolean
    readonly sourceLinkedState: boolean
    readonly diagnosticVariants: boolean

    readonly valueProbes: boolean
    readonly statementHits: boolean
    readonly branchOutcomes: boolean
    readonly orderedTrace: boolean

    readonly tracepoints: boolean
    readonly safeBoundaryPause: boolean
    readonly exactPause: boolean
    readonly stepping: boolean

    readonly limits: {
        readonly maxSessions: number
        readonly maxProbesPerSession: number
        readonly maxValueBytes: number
        readonly maxTraceEvents: number
    }
}

export const DIAGNOSTICS_PROTOCOL_VERSION = 1

/**
 * What this node is actually wired for.
 *
 * Derived from what the host handed the service rather than declared, which is the only way this
 * stays true: a capability set written as a constant drifts the moment a phase lands, and it drifts
 * in the direction that costs - advertising something nobody built. A viewer is entitled to plan
 * around every `true` here.
 */
export interface RpcDiagnosticsSupport {
    readonly sourceAvailable: boolean
    /**
     * This node can prove a diagnostic variant and swap it in over a state-preserving handoff.
     *
     * Needs an ownership store, fences and a coordinator wired by the host, so it is a fact about
     * the deployment and not about the package - two nodes running the same build can honestly
     * answer differently.
     */
    readonly variantActivation?: boolean
    /** Probes have somewhere to write, so what they observe can be read back rather than only fire. */
    readonly probeSink?: { readonly maxProbesPerSession: number; readonly maxValueBytes: number; readonly maxTraceEvents: number }
    /**
     * This node can stop a component between units of work: a barrier, and a supervisor to hold it.
     *
     * Independent of `variantActivation`, because they are different powers. A node may be able to
     * stop what it is running without being able to replace it, and a viewer offered a pause control
     * needs to know which of the two it has.
     */
    readonly safeBoundaryPause?: boolean
}

export const capabilitiesFor = (support: RpcDiagnosticsSupport): RpcDiagnosticsCapabilities => {
    const probes = support.probeSink !== undefined
    return {
        protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
        sourceAvailable: support.sourceAvailable,
        sourceLinkedProps: true,
        sourceLinkedState: true,
        diagnosticVariants: support.variantActivation === true,
        // A probe that fires into nothing is not an observable probe. These follow the sink rather
        // than the transformer: generating a value probe is not the same as being able to say what
        // it saw, and a viewer told `valueProbes` would ask for values.
        valueProbes: probes,
        statementHits: probes,
        branchOutcomes: probes,
        orderedTrace: probes,
        // A tracepoint is a probe compiled into a variant, so it needs both halves: somewhere to
        // write and the means to put it in the artifact. A node that can only read a sink cannot
        // install one, and saying otherwise would have a viewer offer a control that does nothing.
        tracepoints: probes && support.variantActivation === true,
        // A pause needs a supervisor holding a real barrier. Advertised from that rather than from
        // the package's ability to describe one.
        safeBoundaryPause: support.safeBoundaryPause === true,
        exactPause: false,
        stepping: false,
        limits: {
            // One session, because nothing arbitrates two: a second observer would union its regions
            // into the first one's plan and quietly change what the first was watching.
            maxSessions: probes ? 1 : 0,
            maxProbesPerSession: support.probeSink?.maxProbesPerSession ?? 0,
            maxValueBytes: support.probeSink?.maxValueBytes ?? 0,
            maxTraceEvents: support.probeSink?.maxTraceEvents ?? 0
        }
    }
}

/** What a node with source linking and nothing else can claim. The first phase, still honest. */
export const phaseOneCapabilities = (sourceAvailable: boolean): RpcDiagnosticsCapabilities => capabilitiesFor({ sourceAvailable })

/**
 * Why a viewer must not overlay live values on this document, or nothing when it may.
 *
 * The whole of acceptance criteria 1 and 4 in one function, and it answers with a **sentence**
 * rather than a boolean on purpose: a viewer that finds out it may not overlay has to tell somebody
 * why, and "the file you are looking at is not the file that is running" is a different problem from
 * "this node is running a revision this catalogue does not describe".
 */
export const overlayRefusal = (
    catalogue: RpcSourceCatalogue,
    identity: RpcActiveSourceIdentity,
    file: { readonly fileId: string; readonly contentHash: string }
): string | undefined => {
    if (catalogue.semanticRevisionId !== identity.semanticRevisionId)
        return `this catalogue describes revision ${catalogue.semanticRevisionId.slice(0, 12)} and ${identity.componentType} is running ${identity.semanticRevisionId.slice(0, 12)}`
    const known = catalogue.files.find((one) => one.fileId === file.fileId)
    if (!known) return `${file.fileId} is not a file revision ${catalogue.semanticRevisionId.slice(0, 12)} was built from`
    if (known.contentHash !== file.contentHash)
        return `${file.fileId} has been edited since revision ${catalogue.semanticRevisionId.slice(0, 12)} was built, so its line numbers no longer name what is running`
    return undefined
}

/** The bindings for one component, empty where the catalogue does not describe it. */
export const bindingsOf = (catalogue: RpcSourceCatalogue, componentType: string): readonly RpcSourceBinding[] => catalogue.components[componentType] ?? []

/** The bindings that fall on one line, which is what a viewer asks per rendered row. */
export const bindingsOnLine = (bindings: readonly RpcSourceBinding[], fileId: string, line: number): readonly RpcSourceBinding[] =>
    bindings.filter((binding) => binding.fileId === fileId && binding.spans.some((span) => span.startLine <= line && line <= span.endLine))
