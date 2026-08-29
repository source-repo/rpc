import type { RpcDiagnosticsCapabilities, RpcSourceSpan } from './Catalogue.js'

/**
 * Who may watch what, for how long, and what happens when the node cannot do what was asked.
 *
 * A session is where the design's separate concerns meet: an authority model that is *not* the
 * component's own, a revision check that must happen before anything is drawn, a fallback rule for
 * a node that cannot do everything asked of it, and a deadline so that a viewer which goes away does
 * not leave a plant instrumented forever.
 *
 * **Diagnostics permissions are their own set**, and that is the design's first rule here rather
 * than an implementation detail. Being allowed to see a component's props is not being allowed to
 * see its locals; being allowed to see its locals is not being allowed to *change the artifact* by
 * activating an instrumented build. Twelve distinct permissions exist because twelve distinct
 * conversations exist, and collapsing them into "can debug" is how somebody ends up authorised for
 * the last of them by having been granted the first.
 */

/** The design's permission set, unabridged. A host maps these onto whatever it uses for identity. */
export type RpcDiagnosticsPermission =
    | 'view-active-source'
    | 'read-source-text'
    | 'view-props-and-state'
    | 'view-sensitive-state'
    | 'request-probes'
    | 'view-execution-paths'
    | 'create-tracepoints'
    | 'activate-variants'
    | 'create-safe-boundary-breakpoints'
    | 'create-exact-breakpoints'
    | 'control-paused-activation'
    | 'retain-recordings'

export type RpcObservationMode = 'live-values' | 'execution-hits' | 'branch-outcomes' | 'ordered-trace' | 'breakpoints'

/**
 * Which permission each mode needs, and each is a different question.
 *
 * An ordered trace is a *recording* - it keeps what happened rather than what is true now, which is
 * why it answers to `retain-recordings` rather than to the permission that lets somebody watch a
 * value change in front of them. The distinction matters where a value is a production quantity or
 * a person's name: watching is transient, and a trace is a copy.
 */
const permissionForMode: { readonly [mode in RpcObservationMode]: RpcDiagnosticsPermission } = {
    'live-values': 'request-probes',
    'execution-hits': 'view-execution-paths',
    'branch-outcomes': 'view-execution-paths',
    'ordered-trace': 'retain-recordings',
    breakpoints: 'create-safe-boundary-breakpoints'
}

/** Which capability each mode needs from the node, so an unsupported mode is dropped rather than faked. */
const capabilityForMode: { readonly [mode in RpcObservationMode]: keyof RpcDiagnosticsCapabilities } = {
    'live-values': 'valueProbes',
    'execution-hits': 'statementHits',
    'branch-outcomes': 'branchOutcomes',
    'ordered-trace': 'orderedTrace',
    breakpoints: 'safeBoundaryPause'
}

export interface RpcObservationRequest {
    readonly componentId: string
    /**
     * What the viewer believes is running, checked before anything is planned.
     *
     * The design's first failure row: a viewer whose editor holds a different revision must be
     * refused and told which revision is active. Drawing a value positioned by a line from another
     * revision is worse than drawing nothing, and it is worse in the direction of somebody acting.
     */
    readonly expectedSemanticRevisionId: string
    readonly sourceFileId: string
    readonly visibleSpan: RpcSourceSpan
    readonly modes: readonly RpcObservationMode[]
    /**
     * Tracepoints to install, by probe id, once the variant carrying them is active.
     *
     * A separate permission from watching, because a tracepoint is code compiled into the artifact
     * that runs inside the component - `create-tracepoints` rather than `request-probes`. Asking for
     * one without holding it degrades the session rather than failing it, like every other mode.
     */
    readonly tracepointIds?: readonly string[]
    readonly requestedTtlMs: number
}

/** A mode that was asked for and is not being served, with the reason a viewer has to show. */
export interface RpcDegradedMode {
    readonly mode: RpcObservationMode
    readonly why: string
}

/** The immutable half: what a session *is*. Published as props, so a viewer watches rather than polls. */
export interface RpcObservationSession {
    readonly sessionId: string
    readonly componentId: string
    readonly semanticRevisionId: string
    readonly sourceFileId: string
    readonly visibleSpan: RpcSourceSpan
    /** What is actually being served. Never wider than what was asked for. */
    readonly modes: readonly RpcObservationMode[]
    /** What was asked for and refused, and why. Absent from `modes`, present here. */
    readonly degraded: readonly RpcDegradedMode[]
    readonly startedAt: string
    readonly expiresAt: number
    /** The instrumented build this session is being served by, once one is activated. */
    readonly activeVariantId?: string
    /** The tracepoints this session was granted. Empty where it asked for none or held none. */
    readonly tracepointIds: readonly string[]
}

/** The moving half: how a session is *doing*. State, because every field of it changes. */
export interface RpcObservationSessionState {
    readonly sessionId: string
    readonly health: 'observing' | 'degraded' | 'expired' | 'stopped'
    /** Samples published to this session so far. */
    readonly samples: number
    /** Samples the sink dropped. Published because a trace with an invisible hole is a lie. */
    readonly dropped: number
    readonly lastPublishedAt?: string
    readonly expiresAt: number
}

export interface RpcSessionRefusal {
    readonly why: string
    /** The permission that was missing, where one was. A viewer shows a different thing for these. */
    readonly missingPermission?: RpcDiagnosticsPermission
}

export type RpcSessionOutcome = { readonly session: RpcObservationSession } | { readonly refused: RpcSessionRefusal }

export interface RpcSessionRegistryOptions {
    readonly capabilities: RpcDiagnosticsCapabilities
    /** The revision this node is actually running, read rather than taken from the request. */
    readonly activeRevision: () => string
    /**
     * Whether this caller holds a diagnostics permission.
     *
     * Supplied by the host, because only the host knows what an identity means. **There is no
     * default**: a registry with no authoriser refuses every session rather than serving one, since
     * the alternative is a package deciding on a deployment's behalf that watching a plant's locals
     * needs no permission at all.
     */
    readonly authorise: (permission: RpcDiagnosticsPermission, caller: unknown) => boolean | Promise<boolean>
    /** The longest a session may live without being renewed. A viewer that goes away stops costing. */
    readonly maxTtlMs?: number
    readonly now?: () => number
    readonly newSessionId?: () => string
}

const DEFAULT_MAX_TTL_MS = 300_000

/**
 * The sessions one node is serving.
 *
 * Bounded by the advertised `maxSessions`, and the bound is a design decision rather than a resource
 * limit: two observers would union their regions into one probe plan, and the second would silently
 * change what the first was watching. Until something arbitrates that, one session is the honest
 * number and the capability says so.
 */
export class RpcSessionRegistry {
    private readonly sessions = new Map<string, RpcObservationSession>()
    private readonly health = new Map<string, RpcObservationSessionState>()
    private readonly maxTtlMs: number
    private readonly now: () => number
    private readonly newSessionId: () => string
    private counter = 0

    constructor(private readonly options: RpcSessionRegistryOptions) {
        this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS
        this.now = options.now ?? Date.now
        this.newSessionId = options.newSessionId ?? (() => `session-${++this.counter}`)
    }

    get open(): readonly RpcObservationSession[] {
        return [...this.sessions.values()]
    }

    /** Both halves, keyed by id, in the shape the service publishes them. */
    snapshot(): { readonly sessions: { [id: string]: RpcObservationSession }; readonly health: { [id: string]: RpcObservationSessionState } } {
        return { sessions: Object.fromEntries(this.sessions), health: Object.fromEntries(this.health) }
    }

    async start(request: RpcObservationRequest, caller: unknown): Promise<RpcSessionOutcome> {
        this.sweep()

        // Identity before anything else: a viewer that cannot see which revision is running has no
        // business being told what its values are.
        if (!(await this.options.authorise('view-active-source', caller)))
            return { refused: { why: 'this caller may not view the active source identity of this node', missingPermission: 'view-active-source' } }

        const active = this.options.activeRevision()
        if (request.expectedSemanticRevisionId !== active)
            return {
                refused: {
                    why: `${request.componentId} is running ${active} and this request expects ${request.expectedSemanticRevisionId}: the editor is showing a different revision, and a value positioned by its line numbers would sit beside a declaration that is not the one it came from`
                }
            }

        if (this.sessions.size >= this.options.capabilities.limits.maxSessions)
            return {
                refused: {
                    why: `this node serves ${this.options.capabilities.limits.maxSessions} observation session${this.options.capabilities.limits.maxSessions === 1 ? '' : 's'} at a time and that many are open: a second observer would union its regions into the first one's probe plan and silently change what the first was watching`
                }
            }

        const granted: RpcObservationMode[] = []
        const degraded: RpcDegradedMode[] = []
        for (const mode of request.modes) {
            if (!this.options.capabilities[capabilityForMode[mode]]) {
                // The design's fallback rule: a node that cannot do this serves what it can rather
                // than refusing the session, and says what it dropped.
                degraded.push({ mode, why: `this node does not support ${mode}: it advertises ${capabilityForMode[mode]} as false` })
                continue
            }
            if (!(await this.options.authorise(permissionForMode[mode], caller))) {
                degraded.push({ mode, why: `this caller does not hold ${permissionForMode[mode]}, which ${mode} requires` })
                continue
            }
            granted.push(mode)
        }

        // Falling back to nothing is not a fallback. A session serving no mode would report itself
        // healthy while showing an empty screen, and the viewer could not tell that from a component
        // that had simply not run yet.
        if (!granted.length)
            return {
                refused: {
                    why: `none of ${request.modes.join(', ')} can be served here: ${degraded.map((one) => one.why).join('; ')}`,
                    missingPermission: degraded.every((one) => /does not hold/.test(one.why)) ? permissionForMode[request.modes[0]!] : undefined
                }
            }

        // A tracepoint is compiled into the artifact and runs inside the component, so it answers
        // to its own permission and to the node's own capability rather than to either alone.
        const tracepointIds: string[] = []
        if (request.tracepointIds?.length) {
            if (!this.options.capabilities.tracepoints) degraded.push({ mode: 'breakpoints', why: 'this node does not compile tracepoints: it advertises tracepoints as false' })
            else if (!(await this.options.authorise('create-tracepoints', caller)))
                degraded.push({ mode: 'breakpoints', why: 'this caller does not hold create-tracepoints, which compiles a condition into the artifact and runs it inside the component' })
            else tracepointIds.push(...request.tracepointIds)
        }

        const startedAt = this.now()
        const session: RpcObservationSession = {
            sessionId: this.newSessionId(),
            componentId: request.componentId,
            semanticRevisionId: active,
            sourceFileId: request.sourceFileId,
            visibleSpan: request.visibleSpan,
            modes: granted,
            degraded,
            tracepointIds,
            startedAt: new Date(startedAt).toISOString(),
            expiresAt: startedAt + Math.min(Math.max(1, request.requestedTtlMs), this.maxTtlMs)
        }
        this.sessions.set(session.sessionId, session)
        this.health.set(session.sessionId, { sessionId: session.sessionId, health: degraded.length ? 'degraded' : 'observing', samples: 0, dropped: 0, expiresAt: session.expiresAt })
        return { session }
    }

    /**
     * Move the viewport, or renew the deadline.
     *
     * The modes cannot change here, and that is deliberate: what a session is allowed to do was
     * decided against a caller's permissions when it started, and letting an update widen it would
     * make the authorisation a formality that happened once. A viewer that wants more starts a
     * session that asks for more.
     */
    async update(sessionId: string, update: { readonly visibleSpan?: RpcSourceSpan; readonly renewTtlMs?: number }): Promise<RpcSessionOutcome> {
        this.sweep()
        const held = this.sessions.get(sessionId)
        if (!held) return { refused: { why: `${sessionId} is not an open session on this node: it was stopped, it expired, or it was never here` } }
        const next: RpcObservationSession = {
            ...held,
            visibleSpan: update.visibleSpan ?? held.visibleSpan,
            expiresAt: update.renewTtlMs === undefined ? held.expiresAt : this.now() + Math.min(Math.max(1, update.renewTtlMs), this.maxTtlMs)
        }
        this.sessions.set(sessionId, next)
        const health = this.health.get(sessionId)
        if (health) this.health.set(sessionId, { ...health, expiresAt: next.expiresAt })
        return { session: next }
    }

    /** Idempotent, because a viewer that disconnected and reconnected will stop a session twice. */
    stop(sessionId: string): void {
        this.sessions.delete(sessionId)
        const health = this.health.get(sessionId)
        if (health) this.health.set(sessionId, { ...health, health: 'stopped' })
    }

    /** Record what was published, so a viewer reads its own freshness rather than inferring it. */
    published(sessionId: string, samples: number, dropped: number): void {
        const health = this.health.get(sessionId)
        if (!health) return
        this.health.set(sessionId, { ...health, samples: health.samples + samples, dropped, lastPublishedAt: new Date(this.now()).toISOString() })
    }

    /**
     * Expire what has run out, which is the answer to a viewer that went away.
     *
     * A disconnect is not distinguishable from a slow client at this level, so a deadline is what
     * ends a session rather than a socket - and the deadline is what stops a plant being left
     * instrumented because somebody closed a laptop.
     */
    sweep(): readonly string[] {
        const at = this.now()
        const expired: string[] = []
        for (const [id, session] of this.sessions)
            if (session.expiresAt <= at) {
                expired.push(id)
                this.sessions.delete(id)
                const health = this.health.get(id)
                if (health) this.health.set(id, { ...health, health: 'expired' })
            }
        return expired
    }
}
