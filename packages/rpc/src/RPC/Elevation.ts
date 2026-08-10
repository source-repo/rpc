/**
 * A peer saying, continuously and unprompted, that it can currently do something dangerous.
 *
 * This is the half of a development-access design that comes *first*, before any mechanism for
 * granting such access exists - because it is the half that tells you whether the rest is working.
 * Today the question "is anything on this network unlocked right now" has no answer at all, and a
 * gate nobody can see the state of is a gate nobody can audit.
 *
 * **It is an announcement, not a permission.** Nothing here decides anything: `authorize()`, the
 * grants document and the capability's own allow-list do that, and they do it whether or not this
 * is declared. What this adds is that the *posture* travels - so a console watching a plant can say
 * "oven-3 can create containers" without calling anything, and can keep saying it until it stops
 * being true.
 *
 * **Asked of the instance rather than remembered by the host**, the way `dataResources()` is. A host
 * that composes a capability in gets the announcement whether or not anyone remembered to declare
 * it, which matters because the failure mode this exists to catch is precisely somebody forgetting.
 *
 * The most important field is `until`, and the most important case is its absence. An elevation
 * with no expiry is the taped-over key: it was opened for a reason, the reason passed, and nobody
 * came back. A viewer should show that as worse than a bounded one rather than as the same thing.
 */
export interface RpcElevation {
    /** What can be done - `docker.create`, `sql.patch`. A name a person reads, not a permission id. */
    readonly capability: string
    /** Why it is open, for whoever finds it open later and has to decide whether it should be. */
    readonly reason?: string
    /** When it was opened. Absent means the host has always been this way, which is a fact too. */
    readonly since?: number
    /**
     * When it closes by itself, in epoch milliseconds.
     *
     * **Absent means never**, and that is the case worth drawing attention to rather than hiding: an
     * elevation that nothing will end is one somebody has to remember to end, and the whole reason
     * this exists is that people do not.
     */
    readonly until?: number
    /** Who opened it, where that is known. A grant id, a person, a deployment. */
    readonly grantedBy?: string
}

/**
 * A component that is itself an elevation - composing it into a host is what makes the host able to
 * do the dangerous thing, so the host announces it by having done so.
 */
export interface RpcElevated {
    elevation(): RpcElevation | undefined
}

export const declaresElevation = (instance: object): instance is RpcElevated => typeof (instance as RpcElevated).elevation === 'function'

/**
 * Elevations that have not lapsed, newest first.
 *
 * A lapsed one is dropped rather than reported as expired, because the posture is what is true now
 * and a viewer asking "what can this peer do" is not asking what it could do yesterday. The audit
 * trail is where history belongs; this is a live fact.
 */
export const currentElevations = (all: readonly RpcElevation[], now = Date.now()): RpcElevation[] =>
    all.filter((one) => one.until === undefined || one.until > now).sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
