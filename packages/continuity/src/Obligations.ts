import { RpcSnapshotRefused } from './Envelope.js'

/**
 * What a component has accepted, scheduled, awaited or promised - as opposed to what it knows.
 *
 * Held state is the values. Obligations are the *work*: a timer that will fire, a command still out
 * there, a lease somebody is relying on. A handoff that carried the first and dropped the second
 * would produce a successor that looked right and had quietly forgotten what it owed.
 *
 * **Every obligation has a stable semantic id**, independent of any language object or function
 * pointer. That is the whole reason this is a ledger rather than a scan of the runtime: a timer is
 * `mix-dwell`, not a `Timeout` handle, because the successor is a different process - possibly in a
 * different language - and has to be able to say whether it knows how to resume that.
 *
 * And the distinction the manifest exists to preserve: **what the runtime observed** (timer
 * `mix-dwell` is active, due in 40 seconds) is separate from **what the target declares** (what
 * continuing, restarting or firing `mix-dwell` means). The first is a fact and the second is a
 * reviewed policy, and a design that let one stand in for the other would be inventing plant
 * behaviour at handoff time.
 */

/** Which clock a deadline is measured against. There is no default: they are not interchangeable. */
export type RpcClockKind = 'simulation' | 'monotonic' | 'wall'

/**
 * What happens to a timer when the process holding it is replaced.
 *
 * **There is no default policy**, and that is a decision rather than an omission. Every one of these
 * is right for something and catastrophic for something else - a dwell timer that restarts has
 * doubled a bake, and a watchdog that preserves its deadline through a two-minute handoff fires the
 * moment the successor comes up. Nobody can pick between them without knowing what the timer is for,
 * so the component's author picks, or the handoff refuses.
 */
export type RpcTimerPolicy =
    /** Handoff time counts against it: it fires when it would have fired. */
    | 'preserve-deadline'
    /** Effectively paused for the handoff: it fires after the time it had left. */
    | 'preserve-remaining'
    /** Begin its declared duration again. */
    | 'restart'
    /** Deliver it immediately once the successor is authoritative. */
    | 'fire-on-activation'
    /** Abort the handoff if its deadline passed while the handoff was being prepared. */
    | 'refuse-if-overdue'

export interface RpcTimerObligation {
    readonly kind: 'timer'
    readonly id: string
    readonly clock: RpcClockKind
    readonly dueAt: bigint
    readonly capturedAt: bigint
    readonly policy: RpcTimerPolicy
    readonly periodic?: {
        readonly interval: bigint
        /** What a tick missed during the handoff means. Same argument as the policy above. */
        readonly missedTickPolicy: 'skip' | 'coalesce' | 'catch-up'
    }
}

export interface RpcOutboundCallObligation {
    readonly kind: 'outbound-call'
    readonly id: string
    readonly target: string
    readonly method: string
    /**
     * What repeating it costs. The one field capture rules on: a `non-repeatable-command` still in
     * flight has no safe disposition, so it drains to a durable result or the handoff refuses.
     */
    readonly semantics?: 'query' | 'idempotent-command' | 'non-repeatable-command'
    /** The key that would make a second attempt the same command, where the caller named one. */
    readonly idempotencyKey?: string
}

export interface RpcInboundWorkObligation {
    readonly kind: 'inbound-work'
    readonly id: string
    readonly from: string
    readonly method: string
    /** Whether it changes anything. A state-mutating handler must complete before capture. */
    readonly mutating: boolean
}

export interface RpcSubscriptionObligation {
    readonly kind: 'subscription'
    readonly id: string
    readonly event: string
    /** Where the subscriber had got to, so a re-established feed continues rather than resets. */
    readonly lastAcknowledgedSequence?: bigint
}

export interface RpcPublicationObligation {
    readonly kind: 'publication'
    readonly id: string
    readonly event: string
    readonly sequence: bigint
}

export interface RpcLeaseObligation {
    readonly kind: 'lease'
    readonly id: string
    readonly issuer: string
    readonly expiresAt: bigint
    /**
     * Whether the issuer knows how to keep a lease for a *logical* component rather than a process.
     *
     * Declared by whoever registered it, because only they have talked to the issuer. A lease whose
     * issuer does not support it cannot be carried across, and pretending otherwise would hand the
     * successor an authority the issuer does not believe it has.
     */
    readonly issuerSupportsLogicalOwner: boolean
}

export interface RpcSequenceObligation {
    readonly kind: 'sequence'
    readonly id: string
    readonly position: bigint
}

export interface RpcWatchdogObligation {
    readonly kind: 'watchdog'
    readonly id: string
    readonly dueAt: bigint
    readonly policy: RpcTimerPolicy
}

export type RpcObligation =
    | RpcTimerObligation
    | RpcOutboundCallObligation
    | RpcInboundWorkObligation
    | RpcSubscriptionObligation
    | RpcPublicationObligation
    | RpcLeaseObligation
    | RpcSequenceObligation
    | RpcWatchdogObligation

/** The manifest, grouped as the design groups it, so a reader of a snapshot finds what they expect. */
export interface RpcObligations {
    readonly timers: readonly RpcTimerObligation[]
    readonly outboundCalls: readonly RpcOutboundCallObligation[]
    readonly inboundWork: readonly RpcInboundWorkObligation[]
    readonly subscriptions: readonly RpcSubscriptionObligation[]
    readonly pendingPublications: readonly RpcPublicationObligation[]
    readonly leases: readonly RpcLeaseObligation[]
    readonly sequences: readonly RpcSequenceObligation[]
    readonly watchdogs: readonly RpcWatchdogObligation[]
}

const EMPTY: RpcObligations = Object.freeze({
    timers: [],
    outboundCalls: [],
    inboundWork: [],
    subscriptions: [],
    pendingPublications: [],
    leases: [],
    sequences: [],
    watchdogs: []
})

/**
 * What one component's runtime is currently holding.
 *
 * **The ledger is complete only for work that went through it**, and no amount of care here changes
 * that. A raw `setTimeout`, a socket, a promise nobody registered - the runtime cannot see any of
 * them, and a manifest that quietly omitted them would be worse than none, because the successor
 * would be told it had assumed everything. So eligibility is a claim the component's author makes,
 * `manifest()` describes what was registered, and a component that does handoff-relevant work
 * outside these APIs is not eligible however green its tests are.
 */
export class RpcObligationLedger {
    private readonly held = new Map<string, RpcObligation>()

    /**
     * Record one. Registering the same id twice with a different shape is refused.
     *
     * Because an id is what the successor's restore declarations are matched against: two different
     * things under one name means the target declares it can restore one of them and is handed the
     * other.
     */
    register(obligation: RpcObligation): this {
        if (!obligation.id) throw new RpcSnapshotRefused(`a ${obligation.kind} obligation needs a stable id; the successor matches its restore declarations against it`, 'id')
        const held = this.held.get(obligation.id)
        if (held && held.kind !== obligation.kind)
            throw new RpcSnapshotRefused(`${obligation.id} is already registered as a ${held.kind}; one id naming two different things is how a target comes to restore the wrong one`, 'id')
        this.held.set(obligation.id, obligation)
        return this
    }

    /** It is done, so it is not the successor's to assume. Silent for an id that was never here. */
    complete(id: string): this {
        this.held.delete(id)
        return this
    }

    at(id: string): RpcObligation | undefined {
        return this.held.get(id)
    }

    get size(): number {
        return this.held.size
    }

    /**
     * Everything outstanding, grouped.
     *
     * Sorted by id within each group, so two captures of the same runtime state produce the same
     * manifest - which is what lets a snapshot hash mean anything.
     */
    manifest(): RpcObligations {
        const all = [...this.held.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const of = <K extends RpcObligation['kind']>(kind: K) => all.filter((one): one is Extract<RpcObligation, { kind: K }> => one.kind === kind)
        return {
            ...EMPTY,
            timers: of('timer'),
            outboundCalls: of('outbound-call'),
            inboundWork: of('inbound-work'),
            subscriptions: of('subscription'),
            pendingPublications: of('publication'),
            leases: of('lease'),
            sequences: of('sequence'),
            watchdogs: of('watchdog')
        }
    }
}

/** Every obligation in a manifest, flattened - what a restore plan walks. */
export const allObligations = (obligations: RpcObligations): readonly RpcObligation[] => [
    ...obligations.timers,
    ...obligations.outboundCalls,
    ...obligations.inboundWork,
    ...obligations.subscriptions,
    ...obligations.pendingPublications,
    ...obligations.leases,
    ...obligations.sequences,
    ...obligations.watchdogs
]
