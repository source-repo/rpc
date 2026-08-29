import { componentHost, digestText, rpc, RpcComponent, rpcNamespace, type ExposeOptions } from '@source-repo/rpc'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { bindingsOf, capabilitiesFor, type RpcActiveSourceIdentity, type RpcDiagnosticsCapabilities, type RpcDiagnosticsSupport, type RpcSourceBinding, type RpcSourceCatalogue, type RpcSourceSpan } from './Catalogue.js'
import { RpcProbeSink, type RpcProbeSample } from './Probes.js'
import { RpcSessionRegistry, type RpcObservationRequest, type RpcObservationSession, type RpcObservationSessionState, type RpcSessionRegistryOptions } from './Session.js'
import type { RpcDebuggerLease, RpcPauseState, RpcPauseSupervisor } from './Pause.js'
import type { RpcDiagnosticsPermission } from './Session.js'

/**
 * What this node will let somebody see of its own source, and where its values are written down.
 *
 * **A component, because the design says so in the shape of its own contract.** The illustrative
 * `NodeDiagnostics` has `capabilities` and `activeSource` as readonly *properties*, and a readonly
 * property that a viewer watches is what an observable component already is here - so they are
 * props, a viewer subscribes, and a redeploy that changes the running revision reaches every open
 * editor without anybody polling for it.
 *
 * **It serves metadata and never values.** The values a viewer draws come from the component channel
 * it already has, through the permission check that was always there. There is no second data path,
 * which is why there is no second data path to secure.
 */

export interface RpcDiagnosticsProps extends RpcDiagnosticsCapabilities {
    /** Which revision each component is running, so a viewer can refuse to overlay a stale file. */
    readonly components: { readonly [componentType: string]: RpcActiveSourceIdentity }
    /**
     * The immutable half of each open session: what it is, not how it is doing.
     *
     * Props rather than state, because what a session *is* was settled when it started - the modes
     * it was granted, what it was refused and why, the revision it belongs to. A viewer subscribes
     * once and is told when a session appears or goes, without asking.
     */
    readonly sessions: { readonly [sessionId: string]: RpcObservationSession }
    [key: string]: unknown
}

export interface RpcDiagnosticsState {
    /** Source files handed out. A count rather than a log: who asked is the audit layer's business. */
    sourceReads: number
    /** Requests refused for naming a file this node does not serve, or serves and may not disclose. */
    refusals: number
    /** How each open session is doing: health, what it has been sent, what was dropped. */
    sessions: { [sessionId: string]: RpcObservationSessionState }
    /**
     * The latest value each probe saw.
     *
     * A table rather than a stream of hits, because a statement in a loop at a hundred hertz
     * produces six thousand events a minute and one useful fact. This is sized by how many probes
     * there are, never by how often they fire.
     */
    latest: { [probeId: string]: RpcProbeSample }
    /** Samples the sink dropped. Published beside the values so a gap is never mistaken for quiet. */
    dropped: number
    written: number
    /**
     * Where the component is stopped, or absent when it is running.
     *
     * State rather than props: a pause begins and ends, and a viewer watching this is watching the
     * one fact it must never get wrong. It says `safe-boundary` explicitly, because execution
     * stopped *after* a handler rather than on the line the probe is drawn beside, and a screen that
     * implied otherwise would be putting a caret where the component is not.
     */
    pause?: RpcPauseState
    [key: string]: unknown
}

export interface RpcDiagnosticsOptions {
    /** What the build produced. Without one this node advertises no source linking at all. */
    readonly catalogue: RpcSourceCatalogue
    /**
     * Where the files in the catalogue live, so `source()` can read them.
     *
     * Omit it and the node serves bindings and identity but no text, advertising
     * `sourceAvailable: false`. That is the right default for a plant: a binding catalogue says
     * where a value is declared, and the source itself is a different disclosure with a different
     * audience - a viewer that has its own checkout needs only the first.
     */
    readonly sourceRoot?: string
    /** The activation this process is. Changes on restart, which is exactly what it is for. */
    readonly activationEpoch?: string
    /**
     * What else this deployment has wired: variant activation, a probe sink and its bounds.
     *
     * Passed in rather than detected, because both are facts about the host. A node has variant
     * activation when somebody gave it an ownership store, fences and a coordinator; two nodes
     * running this same package can honestly answer differently, and a package that guessed would
     * advertise a capability the deployment never arranged for.
     */
    readonly support?: Omit<RpcDiagnosticsSupport, 'sourceAvailable' | 'probeSink'>
    /**
     * Where this node's probes write, if it has any.
     *
     * The sink and the authoriser go together and neither is enough alone: a sink with nobody to
     * authorise reading it cannot serve a session, and an authoriser with no sink has nothing to
     * authorise access to. **The capability set follows both**, so a node cannot advertise
     * `valueProbes` while lacking the means to say what a probe saw.
     */
    readonly sink?: RpcProbeSink
    /** Whether this caller holds a diagnostics permission. Without it, sessions are refused. */
    readonly authorise?: RpcSessionRegistryOptions['authorise']
    /** The longest a session may live unrenewed. A viewer that closed a laptop stops costing. */
    readonly maxSessionTtlMs?: number
    /**
     * What holds this node's components at a safe boundary, if anything does.
     *
     * Its presence is what makes `safeBoundaryPause` true: a node that cannot take a barrier cannot
     * stop a component, whatever this package can describe.
     */
    readonly pauses?: RpcPauseSupervisor
}

@rpcNamespace('diagnostics')
export class RpcDiagnostics extends RpcComponent<RpcDiagnosticsProps, RpcDiagnosticsState> {
    private readonly catalogue_: RpcSourceCatalogue
    private readonly sourceRoot?: string
    private readonly sink?: RpcProbeSink
    private readonly pauses?: RpcPauseSupervisor
    private readonly authorise?: RpcSessionRegistryOptions['authorise']
    private readonly registry?: RpcSessionRegistry

    constructor(options: RpcDiagnosticsOptions) {
        const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : undefined
        const epoch = options.activationEpoch ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        // Both, or neither. A sink nobody may read cannot serve a session, and an authoriser with
        // nothing behind it authorises access to nothing - so the capability set follows the pair.
        const serving = options.sink !== undefined && options.authorise !== undefined
        const capabilities = capabilitiesFor({
            ...options.support,
            sourceAvailable: sourceRoot !== undefined,
            // Derived from the mechanism the supervisor was given rather than from its presence: a
            // supervisor driving a barrier cannot make an exact stop, and a node that advertised one
            // would be offering a viewer a control that produces something else.
            ...(options.pauses ? { safeBoundaryPause: true, ...(options.pauses.kind === 'exact' ? { exactPause: true, ...(options.pauses.canStep ? { stepping: true } : {}) } : {}) } : {}),
            ...(serving ? { probeSink: { maxProbesPerSession: 500, maxValueBytes: options.sink!.bounds.maxValueBytes, maxTraceEvents: options.sink!.bounds.maxSamples } } : {})
        })
        super(
            {
                ...capabilities,
                components: Object.fromEntries(
                    Object.keys(options.catalogue.components).map((componentType) => [
                        componentType,
                        {
                            componentType,
                            semanticRevisionId: options.catalogue.semanticRevisionId,
                            sourceBundleHash: options.catalogue.sourceBundleHash,
                            activationEpoch: epoch
                        }
                    ])
                ),
                sessions: {}
            },
            { sourceReads: 0, refusals: 0, sessions: {}, latest: {}, dropped: 0, written: 0 }
        )
        this.catalogue_ = options.catalogue
        this.sourceRoot = sourceRoot
        this.sink = options.sink
        this.pauses = options.pauses
        if (options.authorise) this.authorise = options.authorise
        this.registry = serving
            ? new RpcSessionRegistry({
                  capabilities,
                  activeRevision: () => options.catalogue.semanticRevisionId,
                  authorise: options.authorise!,
                  ...(options.maxSessionTtlMs !== undefined ? { maxTtlMs: options.maxSessionTtlMs } : {})
              })
            : undefined
    }

    /**
     * Where one component's props and state are declared.
     *
     * A query, and cheap: this is static metadata computed at build time. It carries no values, so
     * it is not a way around whatever `authorize()` decides about the component itself - what it
     * discloses is the shape of the source, which is the same thing the contract already publishes
     * with line numbers attached.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async bindings(componentType: string): Promise<readonly RpcSourceBinding[]> {
        return bindingsOf(this.catalogue_, componentType)
    }

    /**
     * The whole catalogue: the revision, the bundle hash, and the files it was built from.
     *
     * Asked for rather than carried by the viewer, and that is the point of it being a call. A
     * viewer holding a catalogue from a previous deploy is exactly the case the revision comparison
     * exists to catch, and it can only catch it if the catalogue it compares against came from the
     * node that is running now.
     *
     * Still no values: file names, hashes and positions. What it discloses is the shape of the
     * source, which the contract already publishes without the line numbers.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async catalogue(): Promise<RpcSourceCatalogue> {
        return this.catalogue_
    }

    /** Which revision a component is running. Also in props; here for a caller that is not watching. */
    @rpc({ semantics: 'query', effect: 'observe' })
    async activeSource(componentType: string): Promise<RpcActiveSourceIdentity | undefined> {
        return this.props.components[componentType]
    }

    /**
     * The text of one file this build was made from, with the hash it had when it was.
     *
     * **A separate permission from everything else here**, which is why it is a separate method: a
     * viewer may legitimately be allowed to know that `state.setpoint` is declared at line 34 and
     * not be allowed to read the file that says so. `authorize()` sees the method name and the file
     * being asked for.
     *
     * Only files the catalogue names, resolved against the configured root and checked to stay
     * under it - a file id arrives from the network, and `../../etc/shadow` is the shape of what
     * happens to a path that is merely joined.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async source(fileId: string): Promise<{ readonly fileId: string; readonly text: string; readonly contentHash: string }> {
        if (!this.sourceRoot) {
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error('this node serves no source: it advertises where values are declared, and reading the files is a disclosure it was not configured for')
        }
        const known = this.catalogue_.files.find((file) => file.fileId === fileId)
        if (!known) {
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error(`${fileId} is not a file this build was made from`)
        }
        const path = resolve(join(this.sourceRoot, normalize(known.fileId)))
        const inside = relative(this.sourceRoot, path)
        if (inside.startsWith('..') || isAbsolute(inside)) {
            // Unreachable through a catalogue this node built, and checked anyway: the id arrived
            // over a network, and a path that is merely joined is how a traversal happens.
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error(`${fileId} resolves outside the configured source root`)
        }
        const text = readFileSync(path, 'utf8')
        const contentHash = await digestText(text)
        this.setState((previous) => ({ sourceReads: previous.sourceReads + 1 }))
        // The hash of what was *read*, not what the catalogue recorded. A file edited on the node
        // since the build has to be visible as such rather than silently served under the old hash.
        return { fileId: known.fileId, text, contentHash }
    }

    /**
     * Begin watching. The design's session lifecycle, as far as this phase goes.
     *
     * `program` rather than `operate`, and `non-repeatable-command` rather than idempotent, because
     * of what a session can end up doing: starting one may build and activate an instrumented
     * artifact, which changes the executable running on a plant even though the semantic source is
     * unchanged. A retried "start a session" is a second session, and under this node's advertised
     * limit of one that is a refusal rather than a no-op - which is exactly why it must not be
     * retried silently.
     *
     * The caller is injected rather than claimed: authority here is decided about the authenticated
     * peer, and a `from`-style argument is a claim the caller writes itself.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'program', injectInvocation: true })
    async startSession(request: RpcObservationRequest, invocation?: unknown): Promise<RpcObservationSession> {
        const registry = this.registryOrRefuse()
        const outcome = await registry.start(request, invocation)
        if ('refused' in outcome) {
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error(outcome.refused.why)
        }
        this.publishSessions()
        return outcome.session
    }

    /**
     * Move the viewport, or renew the deadline. Idempotent: the same update lands the same session.
     *
     * What it cannot do is widen the modes, which were decided against this caller's permissions
     * when the session started. An update that could grant a mode would make the authorisation
     * something that happened once, to a request that has since become a different one.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'observe' })
    async updateSession(sessionId: string, update: { readonly visibleSpan?: RpcSourceSpan; readonly renewTtlMs?: number }): Promise<RpcObservationSession> {
        const outcome = await this.registryOrRefuse().update(sessionId, update)
        if ('refused' in outcome) throw new Error(outcome.refused.why)
        this.publishSessions()
        return outcome.session
    }

    /** Stop watching. Idempotent, because a viewer that reconnected will stop the same session twice. */
    @rpc({ semantics: 'idempotent-command', effect: 'observe' })
    async stopSession(sessionId: string): Promise<void> {
        this.registryOrRefuse().stop(sessionId)
        this.publishSessions()
    }

    /**
     * Take control of a paused component, so that resuming it has somebody's name on it.
     *
     * `control-paused-activation` rather than any of the watching permissions: being allowed to see
     * where a component stopped is not being allowed to start it again. One holder at a time, and
     * everyone else authorised may still watch the pause - reading is not controlling.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate', injectInvocation: true })
    async acquireDebuggerControl(sessionId: string, ttlMs: number, invocation?: unknown): Promise<RpcDebuggerLease> {
        const pauses = this.pausesOrRefuse()
        if (!(await this.authorised('control-paused-activation', invocation))) throw new Error('this caller may not control a paused component: watching where one stopped and starting it again are different permissions')
        const outcome = pauses.acquire(sessionId, ttlMs)
        if ('why' in outcome) throw new Error(outcome.why)
        this.publishPause()
        return outcome
    }

    /** Hand control to another session. Explicit and recorded, because two drivers is the failure. */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate', injectInvocation: true })
    async transferDebuggerControl(leaseId: string, toSessionId: string, invocation?: unknown): Promise<RpcDebuggerLease> {
        const pauses = this.pausesOrRefuse()
        if (!(await this.authorised('control-paused-activation', invocation))) throw new Error('this caller may not control a paused component')
        const outcome = pauses.transfer(leaseId, toSessionId)
        if ('why' in outcome) throw new Error(outcome.why)
        this.publishPause()
        return outcome
    }

    /**
     * Let the component go.
     *
     * **Not silently repeatable**, which the design says of every pause and resume command and which
     * is why this is a `non-repeatable-command`: a retry that arrived after a resume would be asking
     * to resume a component that has since stopped again for a different reason, and answering it
     * with a cheerful *already done* would be a debugger deciding on somebody's behalf.
     */
    @rpc({ semantics: 'non-repeatable-command', effect: 'operate', injectInvocation: true })
    async continueExecution(leaseId: string, invocation?: unknown): Promise<RpcPauseState> {
        const pauses = this.pausesOrRefuse()
        if (!(await this.authorised('control-paused-activation', invocation))) throw new Error('this caller may not control a paused component')
        const outcome = pauses.continueExecution(leaseId)
        if ('why' in outcome) throw new Error(outcome.why)
        this.publishPause()
        return outcome
    }

    private async authorised(permission: RpcDiagnosticsPermission, caller: unknown): Promise<boolean> {
        return this.authorise ? Boolean(await this.authorise(permission, caller)) : false
    }

    private pausesOrRefuse(): RpcPauseSupervisor {
        if (!this.pauses) throw new Error('this node cannot stop a component: it was given nothing that can hold one at a safe boundary, and it advertises safeBoundaryPause as false')
        return this.pauses
    }

    /** The pause, into state, with whatever the deadline has just done to it already applied. */
    private publishPause(): void {
        this.setState({ pause: this.pauses?.state })
    }

    private registryOrRefuse(): RpcSessionRegistry {
        if (!this.registry)
            throw new Error(
                'this node serves no observation sessions: it was given no probe sink, or no authoriser. A package cannot decide on a deployment’s behalf that watching a component’s locals needs no permission, so it refuses instead of defaulting.'
            )
        return this.registry
    }

    /**
     * Move what the probes have seen into state, and hand an ordered chunk to whoever asked for one.
     *
     * **Called by the host rather than by a timer in here.** A package that started its own interval
     * would be deciding a plant's publication rate from a library, and the rate is exactly the thing
     * a deployment tunes - a node with a hundred components and a slow link wants something very
     * different from a bench. What this guarantees instead is that publishing is bounded work: a
     * latest-value table sized by the number of probes, never by how often they fired.
     *
     * The trace chunk is an **event**, and only for a session that asked for `ordered-trace`. That is
     * the design's split: the table is what is true now and belongs in state, and a trace is what
     * happened and is a recording somebody had to be permitted to keep.
     */
    publish(): void {
        // The pause deadline first, because everything published below should describe the component
        // as it is *after* an expiry has been applied rather than a moment before.
        const expiry = this.pauses?.sweep()
        if (expiry) this.emit('pauseExpired', { componentId: this.props.components ? Object.keys(this.props.components)[0] : undefined, action: expiry })
        if (!this.sink || !this.registry) {
            if (this.pauses) this.publishPause()
            return
        }
        for (const expired of this.registry.sweep()) void expired
        const table = this.sink.table()
        const tracing = this.registry.open.filter((session) => session.modes.includes('ordered-trace'))
        const chunk = tracing.length ? this.sink.drain() : undefined
        // Captures go to the sessions that installed the tracepoints, and to nobody else: a
        // tracepoint's capture is a value somebody was separately permitted to take.
        const captures = this.sink.drainCaptures()
        for (const session of this.registry.open) this.registry.published(session.sessionId, table.written, table.dropped)
        this.setState({ latest: table.latest, dropped: table.dropped, written: table.written, sessions: this.registry.snapshot().health, pause: this.pauses?.state })
        // Sequenced by the sample sequence numbers it carries, so a subscriber that missed a chunk
        // can see the gap rather than infer one. Emitted after the state commit, so a viewer that
        // reacts to the event and reads state finds the values the chunk belongs with.
        if (chunk?.length) for (const session of tracing) this.emit('trace', { sessionId: session.sessionId, samples: chunk })
        if (captures.length)
            for (const session of this.registry.open) {
                const theirs = captures.filter((capture) => session.tracepointIds.includes(capture.probeId))
                if (theirs.length) this.emit('tracepoint', { sessionId: session.sessionId, captures: theirs, discarded: this.sink.discarded })
            }
        this.publishSessions()
    }

    /** The immutable half of every open session, published where a viewer watches rather than polls. */
    private publishSessions(): void {
        if (!this.registry) return
        componentHost(this).replaceProps({ ...this.props, sessions: this.registry.snapshot().sessions })
    }
}

/**
 * Stand diagnostics up on a server.
 *
 * `parallel`, because reading a file must not hold the node against every other caller - and because
 * nothing here mutates anything a second caller could observe half-done.
 */
export const exposeDiagnostics = (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    options: RpcDiagnosticsOptions,
    name = 'diagnostics'
): RpcDiagnostics => {
    const service = new RpcDiagnostics(options)
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}
