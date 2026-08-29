import test from 'ava'
import { capabilitiesFor, RpcDiagnostics, RpcProbeSink, RpcSessionRegistry, type RpcDiagnosticsPermission, type RpcObservationRequest, type RpcSourceCatalogue } from './index.js'

/**
 * Who may watch what, what happens when a node cannot do it, and how what was seen gets out.
 *
 * The transport half is deliberately unglamorous - a table, a counter and one event - and these test
 * the properties that make it safe rather than the plumbing: that a caller is refused per permission
 * rather than in bulk, that an unsupported mode degrades instead of failing the session, that a
 * classified value never reaches the buffer at all, and that a viewer can always see what was
 * dropped.
 */

const REVISION = 'rev-7'
const span = { startLine: 4, startColumn: 1, endLine: 9, endColumn: 1 }

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
    visibleSpan: span,
    modes: ['live-values', 'execution-hits'],
    requestedTtlMs: 60_000,
    ...overrides
})

const wired = capabilitiesFor({ sourceAvailable: true, variantActivation: true, probeSink: { maxProbesPerSession: 500, maxValueBytes: 64, maxTraceEvents: 100 } })

const registryWith = (holds: readonly RpcDiagnosticsPermission[], capabilities = wired, now = () => 1_000) =>
    new RpcSessionRegistry({
        capabilities,
        activeRevision: () => REVISION,
        authorise: (permission: RpcDiagnosticsPermission) => holds.includes(permission),
        now,
        newSessionId: () => 'session-1'
    })

test('a viewer whose editor holds another revision is refused, and told which one is running', async (t) => {
    const registry = registryWith(['view-active-source', 'request-probes', 'view-execution-paths'])
    const outcome = await registry.start(request({ expectedSemanticRevisionId: 'rev-6' }), {})

    t.true('refused' in outcome)
    if (!('refused' in outcome)) return
    t.regex(outcome.refused.why, /is running rev-7 and this request expects rev-6/)
})

test('permissions are asked for one at a time, so a caller gets what it holds and no more', async (t) => {
    // Allowed to watch values, not to watch execution paths. The design keeps those apart.
    const registry = registryWith(['view-active-source', 'request-probes'])
    const outcome = await registry.start(request(), {})

    t.true('session' in outcome)
    if (!('session' in outcome)) return
    t.deepEqual(outcome.session.modes, ['live-values'])
    t.is(outcome.session.degraded.length, 1)
    t.regex(outcome.session.degraded[0]!.why, /does not hold view-execution-paths/)
})

test('a caller who may not even see the active revision is refused before anything else is decided', async (t) => {
    const registry = registryWith([])
    const outcome = await registry.start(request(), {})

    t.true('refused' in outcome)
    if (!('refused' in outcome)) return
    t.is(outcome.refused.missingPermission, 'view-active-source')
})

test('a mode the node cannot serve degrades the session rather than failing it', async (t) => {
    const withoutTrace = capabilitiesFor({ sourceAvailable: true, probeSink: { maxProbesPerSession: 500, maxValueBytes: 64, maxTraceEvents: 0 } })
    const registry = registryWith(['view-active-source', 'request-probes', 'retain-recordings'], { ...withoutTrace, orderedTrace: false })
    const outcome = await registry.start(request({ modes: ['live-values', 'ordered-trace'] }), {})

    t.true('session' in outcome)
    if (!('session' in outcome)) return
    t.deepEqual(outcome.session.modes, ['live-values'], 'what it can serve, it serves')
    t.regex(outcome.session.degraded[0]!.why, /advertises orderedTrace as false/)
})

test('falling back to nothing is not a fallback, so a session that could serve no mode refuses', async (t) => {
    const registry = registryWith(['view-active-source'])
    const outcome = await registry.start(request({ modes: ['live-values'] }), {})

    t.true('refused' in outcome)
    if (!('refused' in outcome)) return
    t.regex(outcome.refused.why, /none of live-values can be served here/)
})

test('a second observer is refused, because it would change what the first was watching', async (t) => {
    const registry = registryWith(['view-active-source', 'request-probes', 'view-execution-paths'])
    t.true('session' in (await registry.start(request(), {})))

    const second = await registry.start(request(), {})
    t.true('refused' in second)
    if ('refused' in second) t.regex(second.refused.why, /silently change what the first was watching/)
})

test('an update moves the viewport and renews the deadline, and cannot widen what was granted', async (t) => {
    let clock = 1_000
    const registry = registryWith(['view-active-source', 'request-probes'], wired, () => clock)
    const started = await registry.start(request({ modes: ['live-values', 'execution-hits'], requestedTtlMs: 5_000 }), {})
    t.true('session' in started)
    if (!('session' in started)) return
    t.is(started.session.expiresAt, 6_000)

    clock = 3_000
    const moved = await registry.update('session-1', { visibleSpan: { ...span, startLine: 20 }, renewTtlMs: 5_000 })
    t.true('session' in moved)
    if (!('session' in moved)) return
    t.is(moved.session.visibleSpan.startLine, 20)
    t.is(moved.session.expiresAt, 8_000, 'renewed from now rather than extended from before')
    t.deepEqual(moved.session.modes, ['live-values'], 'and the modes are what they were granted at the start')
})

test('a deadline is what ends a session, because a disconnect looks like a slow viewer', async (t) => {
    let clock = 1_000
    const registry = registryWith(['view-active-source', 'request-probes'], wired, () => clock)
    t.true('session' in (await registry.start(request({ modes: ['live-values'], requestedTtlMs: 2_000 }), {})))

    clock = 3_001
    t.deepEqual(registry.sweep(), ['session-1'])
    t.is(registry.snapshot().health['session-1']?.health, 'expired')
    t.is(registry.open.length, 0, 'and a plant is no longer instrumented for somebody who went away')
})

test('a ttl longer than the node allows is clamped rather than honoured', async (t) => {
    const registry = registryWith(['view-active-source', 'request-probes'], wired, () => 1_000)
    const outcome = await registry.start(request({ modes: ['live-values'], requestedTtlMs: 86_400_000 }), {})
    t.true('session' in outcome)
    if ('session' in outcome) t.is(outcome.session.expiresAt, 301_000, 'the node decides how long it will stay instrumented')
})

test('a value on a classified field is never captured, and the probe still shows that it ran', (t) => {
    const sink = new RpcProbeSink({ withheld: new Set(['value:oven.ts:12:9']) })
    const probe = sink.receiver

    t.is(probe.value('value:oven.ts:12:9', 'hunter2'), 'hunter2', 'the program still gets its value')
    const sample = sink.table().latest['value:oven.ts:12:9']
    t.is(sample?.value?.text, '', 'and the buffer never held it')
    t.regex(sample?.value?.unrepresentable ?? '', /classified beside its declaration/)
    t.is(sample?.executionCount, 1, 'the execution path is still visible')
})

test('the table is sized by probes rather than by how often they fired', (t) => {
    const sink = new RpcProbeSink({ maxSamples: 4 })
    const probe = sink.receiver
    for (let tick = 0; tick < 50; tick++) probe.value('value:1', tick)

    const table = sink.table()
    t.is(Object.keys(table.latest).length, 1, 'one probe, one row, whatever the rate')
    t.is(table.latest['value:1']?.value?.text, '49', 'and it holds the latest')
    t.is(table.latest['value:1']?.executionCount, 50)
    t.is(table.dropped, 46, 'the ring dropped the rest and says how many')
})

const standing = (sink: RpcProbeSink, holds: readonly RpcDiagnosticsPermission[]) =>
    new RpcDiagnostics({
        catalogue,
        sink,
        authorise: (permission) => holds.includes(permission),
        maxSessionTtlMs: 60_000
    })

test('a node with no sink and no authoriser refuses sessions rather than defaulting to open', async (t) => {
    const bare = new RpcDiagnostics({ catalogue })
    t.false(bare.props.valueProbes, 'and says so in its capabilities rather than only when asked')
    await t.throwsAsync(bare.startSession(request()), { message: /cannot decide on a deployment/ })
})

test('what the probes saw reaches a viewer as state, with the drops beside it', async (t) => {
    const sink = new RpcProbeSink({ maxSamples: 3 })
    const service = standing(sink, ['view-active-source', 'request-probes', 'view-execution-paths'])
    const session = await service.startSession(request())

    t.deepEqual(session.modes, ['live-values', 'execution-hits'])
    t.is(service.props.sessions[session.sessionId]?.componentId, 'oven3', 'the session itself is a prop, so a viewer watches it')

    const probe = sink.receiver
    probe.entry('function-entry:1')
    probe.value('value:1', 210)
    probe.value('value:1', 214)
    probe.statement('statement:1')
    probe.statement('statement:1')

    service.publish()

    t.is(service.state.latest['value:1']?.value?.text, '214')
    t.is(service.state.latest['statement:1']?.executionCount, 2)
    t.is(service.state.dropped, 2, 'the ring dropped two and the count is published beside the values')
    t.is(service.state.sessions[session.sessionId]?.health, 'observing')
    t.truthy(service.state.sessions[session.sessionId]?.lastPublishedAt)
})

test('an ordered trace is an event and only for a session that asked to keep one', async (t) => {
    const sink = new RpcProbeSink()
    const watching = standing(sink, ['view-active-source', 'request-probes'])
    const chunks: unknown[] = []
    watching.on('trace', (chunk) => chunks.push(chunk))

    await watching.startSession(request({ modes: ['live-values'] }))
    sink.receiver.value('value:1', 1)
    watching.publish()
    t.is(chunks.length, 0, 'watching a value is not keeping a recording of it')

    const recording = standing(new RpcProbeSink(), ['view-active-source', 'request-probes', 'retain-recordings'])
    const recorded: { sessionId: string; samples: readonly { probeId: string }[] }[] = []
    recording.on('trace', (chunk) => recorded.push(chunk as { sessionId: string; samples: readonly { probeId: string }[] }))
    const session = await recording.startSession(request({ modes: ['live-values', 'ordered-trace'] }))
    t.true(session.modes.includes('ordered-trace'))
})

test('publishing costs the same whether the component ticked once or ten thousand times', (t) => {
    const sink = new RpcProbeSink({ maxSamples: 10 })
    const service = standing(sink, ['view-active-source', 'request-probes'])
    const probe = sink.receiver
    for (let tick = 0; tick < 10_000; tick++) probe.statement('statement:1')

    service.publish()
    t.is(Object.keys(service.state.latest).length, 1)
    t.is(service.state.latest['statement:1']?.executionCount, 10_000)
    t.is(service.state.written, 10_000)
})
