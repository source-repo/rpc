import { allObligations, handOver, type RpcHandoffRecord, type RpcHandoffRequest, type RpcObligations, type RpcRestoreDeclaration, type RpcTimerPolicy } from '@source-repo/continuity'
import { admissibleVariant, type RpcApprovedRevision, type RpcDerivativeEvidence, type RpcDiagnosticVariantManifest } from './Variant.js'

/**
 * Putting an instrumented copy of a component in place of the component, and taking it back out.
 *
 * The diagnostics design's section 16 says how, and every step of it already exists in
 * `@source-repo/continuity`: start the variant as a shadow with its output fenced, reach the normal
 * quiescence barrier, capture, restore the identical state schema without migration, re-establish
 * obligations under the ordinary rules, swap ownership and epoch atomically. This file is the
 * mapping and the two things the mapping needs that a general handoff does not.
 *
 * **The variant is proved admissible before the plant is touched at all.** The design says to build
 * and validate while the base activation is still running, and the reason is visible in the order of
 * this function: a variant that could never be activated costs nothing, because the component is
 * never quiesced for it. A handoff refused at the barrier has already stopped a plant.
 *
 * **A diagnostic handoff is the one where blanket `assumed` is a conclusion rather than an
 * assumption.** Everywhere else, a successor that says nothing about an obligation is refused,
 * because a different revision cannot be presumed to know what `mix-dwell` was for. Here the
 * successor was *proved* to be the same program plus probes - that is exactly what
 * `admissibleVariant` established - so it knows every obligation by the same id, and saying so is
 * reporting the proof rather than hoping. What no proof can settle is what a timer should do about
 * the handoff window, which is why the policy is still asked for.
 */

/** Why a variant was not activated, before anything about the plant changed. */
export interface RpcActivationRefused {
    readonly why: string
    /** True when nothing was attempted: the component was never quiesced and never held. */
    readonly beforeTheBarrier: boolean
}

export type RpcVariantActivationOutcome = { readonly activated: RpcHandoffRecord } | { readonly abandoned: RpcHandoffRecord } | { readonly refused: RpcActivationRefused }

export interface RpcVariantActivationRequest<State> {
    readonly manifest: RpcDiagnosticVariantManifest
    /** What the node approved and is running, held by the node rather than supplied by the artifact. */
    readonly approved: RpcApprovedRevision
    readonly evidence: RpcDerivativeEvidence
    /**
     * What the incumbent is currently holding, read before the handoff is prepared.
     *
     * Used to build the restore declarations. An obligation taken on between here and the barrier is
     * deliberately not covered: `planRestore` re-runs against the snapshot actually captured and
     * refuses on anything undeclared, which is the design's *final validation is repeated against
     * the barrier snapshot* doing exactly what it is for.
     */
    readonly obligations: RpcObligations
    /**
     * What every timer does about the handoff window. Required, and there is no default here either.
     *
     * Being the same program settles that the successor *knows* the timer. It settles nothing about
     * whether a dwell should resume with the time it had left or fire when it would have fired, and
     * a diagnostic swap that quietly picked one would be changing plant behaviour in order to watch
     * plant behaviour.
     */
    readonly timerPolicy: RpcTimerPolicy
    /**
     * Whether the activation is currently paused at a breakpoint.
     *
     * Refused, per the design: an exact-paused activation is not quiescent, so it cannot reach a
     * barrier and cannot be replaced. It must resume first. Nothing can set this yet - `exactPause`
     * is advertised `false` - and the rule is encoded now because the alternative is discovering it
     * when the first pause exists and a handoff hangs on a barrier that can never be reached.
     */
    readonly paused?: boolean
    /** Everything the coordinator needs that is the caller's: fences, buffer, capture, restore. */
    readonly handoff: Omit<RpcHandoffRequest<State>, 'declarations'>
}

/**
 * Every obligation, assumed unchanged, with the stated policy on the timers.
 *
 * Exported because it is the argument as much as the code: this is what "the successor is the same
 * program" entitles a caller to declare, and a caller building the same list by hand for a
 * *different* revision would be making a claim nothing supports.
 */
export const declarationsForVariant = (obligations: RpcObligations, timerPolicy: RpcTimerPolicy): readonly RpcRestoreDeclaration[] =>
    allObligations(obligations).map((obligation) =>
        obligation.kind === 'timer' || obligation.kind === 'watchdog' ? { id: obligation.id, resolution: 'assumed' as const, timerPolicy } : { id: obligation.id, resolution: 'assumed' as const }
    )

const swap = async <State>(request: RpcVariantActivationRequest<State>, admissible: () => Promise<string | undefined>): Promise<RpcVariantActivationOutcome> => {
    if (request.paused)
        return {
            refused: {
                why: `${request.approved.componentId} is paused at a breakpoint, and a paused activation is not quiescent: it cannot reach a barrier, so it cannot be replaced until it resumes`,
                beforeTheBarrier: true
            }
        }

    const refusal = await admissible()
    if (refusal) return { refused: { why: refusal, beforeTheBarrier: true } }

    const outcome = await handOver<State>({ ...request.handoff, declarations: declarationsForVariant(request.obligations, request.timerPolicy) })
    return 'activated' in outcome ? { activated: outcome.activated } : { abandoned: outcome.abandoned }
}

/**
 * Swap the instrumented copy in.
 *
 * The whole of the diagnostics-specific part is the check that runs first. What follows is an
 * ordinary handoff, and that is the point: instrumenting a component is not a special way of
 * replacing it, it is the ordinary way of replacing it with something that was proved to be the same
 * program.
 */
export const activateDiagnosticVariant = <State>(request: RpcVariantActivationRequest<State>): Promise<RpcVariantActivationOutcome> =>
    swap(request, () => admissibleVariant(request.manifest, request.approved, request.evidence))

/**
 * Swap the approved artifact back in.
 *
 * **The same protocol, run the other way**, as the design says - not a rollback, and not a special
 * path. The check that differs is which artifact is arriving: going in, a variant has to be proved a
 * derivative of what is running; coming out, what arrives has to be the approved artifact itself,
 * and the proof that matters is that its hash is the one the node approved.
 *
 * State crosses back the same way it crossed in, because the schema never changed - which is the
 * property that makes removing instrumentation as unremarkable as adding it, and the reason a
 * session can be closed at a safe boundary without anybody deciding what to do about the values the
 * component has accumulated while it was being watched.
 */
export const deactivateDiagnosticVariant = <State>(request: RpcVariantActivationRequest<State> & { readonly returningArtifactHash: string }): Promise<RpcVariantActivationOutcome> =>
    swap(request, async () =>
        request.returningArtifactHash === request.approved.artifactHash
            ? undefined
            : `${request.approved.componentId} would be handed back an artifact that is not the one it approved: removing instrumentation restores the approved build, and anything else is a deployment wearing a debugger's clothes`
    )
