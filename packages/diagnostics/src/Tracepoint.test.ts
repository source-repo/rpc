import test from 'ava'
import { capabilitiesFor, RpcDiagnostics, RpcProbeSink, RpcSessionRegistry, type RpcDiagnosticsPermission, type RpcObservationRequest, type RpcSourceCatalogue, type RpcTracepointCapture } from './index.js'

/**
 * What a tracepoint does when it is hit, and who is allowed to install one.
 *
 * The condition has already been checked at build time - it is the transformer that refuses a
 * condition that could call something. What is left for the runtime is the part a rebuild should not
 * be needed for: how many hits to skip, what the message reads as, and making sure a capture goes to
 * the session that was permitted to take it and to nobody else.
 */

const REVISION = 'rev-7'

const catalogue: RpcSourceCatalogue = {
    catalogueVersion: 1,
    semanticRevisionId: REVISION,
    sourceBundleHash: 'sha256-bundle',
    files: [{ fileId: 'oven.ts', contentHash: 'sha256-oven', lines: 40 }],
    components: { oven: [] }
}

const request = (overrides: Partial<RpcObservationRequest> = {}): RpcObservationRequest => ({
    componentId: 'oven3',
    expectedSemanticRevisionId: REVISION,
    sourceFileId: 'oven.ts',
    visibleSpan: { startLine: 1, startColumn: 1, endLine: 20, endColumn: 1 },
    modes: ['live-values'],
    requestedTtlMs: 60_000,
    ...overrides
})

const TRACEPOINT = 'breakpoint:oven.ts:4:9'

test('a tracepoint counts every hit and captures only where its condition held', (t) => {
    const sink = new RpcProbeSink()
    const probe = sink.receiver

    probe.tracepoint(TRACEPOINT, false, { clamped: 180 })
    probe.tracepoint(TRACEPOINT, false, { clamped: 190 })
    probe.tracepoint(TRACEPOINT, true, { clamped: 305 })

    const captures = sink.drainCaptures()
    t.is(captures.length, 1, 'one capture, from the hit where the condition held')
    t.is(captures[0]?.captured.clamped?.text, '305')
    t.is(sink.table().latest[TRACEPOINT]?.executionCount, 3, 'and all three hits are counted')
    t.is(sink.table().latest[TRACEPOINT]?.conditionResult, true)
})

test('a line that ran and never matched is an answer, and is distinguishable from one never reached', (t) => {
    const sink = new RpcProbeSink()
    for (let hit = 0; hit < 4_000; hit++) sink.receiver.tracepoint(TRACEPOINT, false, { clamped: 100 })

    t.is(sink.drainCaptures().length, 0)
    t.is(sink.table().latest[TRACEPOINT]?.executionCount, 4_000, 'this line ran four thousand times and never matched')
    t.false('breakpoint:never' in sink.table().latest, 'which is a different thing from a probe that never fired')
})

test('a hit count skips the early hits and counts them anyway', (t) => {
    const sink = new RpcProbeSink({ tracepoints: { [TRACEPOINT]: { hitCount: 3 } } })
    for (const value of [1, 2, 3, 4]) sink.receiver.tracepoint(TRACEPOINT, true, { value })

    const captures = sink.drainCaptures()
    t.deepEqual(
        captures.map((capture) => capture.hit),
        [3, 4],
        'capturing begins at the third hit'
    )
    t.is(sink.table().latest[TRACEPOINT]?.executionCount, 4)
})

test('a message reads what was captured, and says so when a placeholder names nothing', (t) => {
    const sink = new RpcProbeSink({ tracepoints: { [TRACEPOINT]: { messageTemplate: 'clamped {clamped} of {target}, mode {mode}' } } })
    sink.receiver.tracepoint(TRACEPOINT, true, { clamped: 300, target: 420 })

    t.is(sink.drainCaptures()[0]?.message, 'clamped 300 of 420, mode {mode}', 'an unfilled placeholder is left as written rather than becoming undefined')
})

test('a message template is not a way around a classification', (t) => {
    const sink = new RpcProbeSink({ withheld: new Set([TRACEPOINT]), tracepoints: { [TRACEPOINT]: { messageTemplate: 'token is {token}' } } })
    sink.receiver.tracepoint(TRACEPOINT, true, { token: 'hunter2' })

    const capture = sink.drainCaptures()[0]
    t.false(capture?.message?.includes('hunter2'))
    t.regex(capture?.message ?? '', /classified beside its declaration/)
    t.is(capture?.captured.token?.text, '')
})

test('captures are bounded, and what the bound discarded is counted', (t) => {
    const sink = new RpcProbeSink({ maxCaptures: 3 })
    for (let hit = 0; hit < 10; hit++) sink.receiver.tracepoint(TRACEPOINT, true, { hit })

    const captures = sink.drainCaptures()
    t.is(captures.length, 3)
    t.is(sink.discarded, 7)
    t.is(captures[2]?.captured.hit?.text, '9', 'and what it kept is the most recent')
})

test('a tracepoint that throws while capturing cannot become the component’s fault', (t) => {
    const sink = new RpcProbeSink()
    const hostile = {
        get boom(): string {
            throw new Error('no')
        }
    }
    // The getter throws when the value is rendered, which is inside the sink and on the component's
    // stack. Nothing about that may reach the program being watched.
    t.notThrows(() => sink.receiver.tracepoint(TRACEPOINT, true, { held: hostile }))
    const capture = sink.drainCaptures()[0]
    t.truthy(capture, 'the capture still happened')
    t.truthy(capture?.captured.held?.unrepresentable, 'and says what it could not render')
})

const registryWith = (holds: readonly RpcDiagnosticsPermission[], capabilities = capabilitiesFor({ sourceAvailable: true, variantActivation: true, probeSink: { maxProbesPerSession: 500, maxValueBytes: 64, maxTraceEvents: 100 } })) =>
    new RpcSessionRegistry({
        capabilities,
        activeRevision: () => REVISION,
        authorise: (permission: RpcDiagnosticsPermission) => holds.includes(permission),
        now: () => 1_000,
        newSessionId: () => 'session-1'
    })

test('installing a tracepoint is its own permission, separate from watching a value', async (t) => {
    const watching = registryWith(['view-active-source', 'request-probes'])
    const outcome = await watching.start(request({ tracepointIds: [TRACEPOINT] }), {})

    t.true('session' in outcome)
    if (!('session' in outcome)) return
    t.deepEqual(outcome.session.tracepointIds, [], 'watching values did not come with installing code')
    t.regex(outcome.session.degraded.find((one) => one.mode === 'breakpoints')?.why ?? '', /does not hold create-tracepoints/)
    t.deepEqual(outcome.session.modes, ['live-values'], 'and the rest of the session is served as asked')
})

test('a node that cannot compile a tracepoint says so rather than accepting one it will ignore', async (t) => {
    const withoutVariants = capabilitiesFor({ sourceAvailable: true, probeSink: { maxProbesPerSession: 500, maxValueBytes: 64, maxTraceEvents: 100 } })
    t.false(withoutVariants.tracepoints, 'a sink with no way to change the artifact cannot install one')

    const registry = registryWith(['view-active-source', 'request-probes', 'create-tracepoints'], withoutVariants)
    const outcome = await registry.start(request({ tracepointIds: [TRACEPOINT] }), {})
    t.true('session' in outcome)
    if ('session' in outcome) t.regex(outcome.session.degraded.find((one) => one.mode === 'breakpoints')?.why ?? '', /advertises tracepoints as false/)
})

test('a capture reaches the session that installed the tracepoint, and no other', async (t) => {
    const sink = new RpcProbeSink()
    const service = new RpcDiagnostics({
        catalogue,
        sink,
        support: { variantActivation: true },
        authorise: (permission: RpcDiagnosticsPermission) => ['view-active-source', 'request-probes', 'create-tracepoints'].includes(permission)
    })
    const captured: { sessionId: string; captures: readonly RpcTracepointCapture[] }[] = []
    service.on('tracepoint', (event) => captured.push(event as { sessionId: string; captures: readonly RpcTracepointCapture[] }))

    const session = await service.startSession(request({ tracepointIds: [TRACEPOINT] }))
    t.deepEqual(session.tracepointIds, [TRACEPOINT])

    sink.receiver.tracepoint(TRACEPOINT, true, { clamped: 305 })
    sink.receiver.tracepoint('breakpoint:somebody-elses', true, { secret: 1 })
    service.publish()

    t.is(captured.length, 1)
    t.is(captured[0]?.sessionId, session.sessionId)
    t.deepEqual(
        captured[0]?.captures.map((capture) => capture.probeId),
        [TRACEPOINT],
        'a capture from a tracepoint this session did not install is not its to see'
    )
})
