import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { rpc, RpcClient, RpcComponent, rpcNamespace, RpcServer } from '@source-repo/rpc'
import { capabilitiesFor, RpcPauseSupervisor, RpcProbeSink, type RpcPauseExpiryAction } from './index.js'

/**
 * Stopping a component between units of work, on a real queue.
 *
 * The property that makes this mode survivable is not that it stops - anything can stop something -
 * but *where*: the handler that was running when the probe fired runs to its end under ordinary
 * semantics, and the component stops before the next one. So these run against a real server with
 * real calls in flight, because a barrier that let a handler finish is indistinguishable from one
 * that did not until there is a handler to finish.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface OvenState extends Record<string, unknown> {
    batches: number
    inHandler: boolean
}

@rpcNamespace('oven', { execution: 'serial' })
class Oven extends RpcComponent<{ label: string; [key: string]: unknown }, OvenState> {
    constructor() {
        super({ label: 'Oven 3' }, { batches: 0, inHandler: false })
    }

    /** Slow on purpose: the point is that this finishes rather than being cut in half. */
    @rpc({ semantics: 'idempotent-command', sets: 'batches' })
    async bake(hold: number) {
        this.setState({ inHandler: true })
        await sleep(hold)
        this.setState((previous) => ({ batches: previous.batches + 1, inHandler: false }))
        return this.state.batches
    }
}

const stood = async (t: ExecutionContext, port: number, expiryAction: RpcPauseExpiryAction = 'resume', maxPauseMs = 5_000, onTerminate?: () => void) => {
    const server = new RpcServer({ name: peer(`oven${port}`), transports: [{ port, host: '127.0.0.1' }] })
    const oven = new Oven()
    server.exposeClassInstance(oven, 'oven')
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`oven${port}`) })
    const proxy = await client.proxy<Oven>('oven')
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const pauses = new RpcPauseSupervisor({
        componentId: 'oven3',
        semanticRevisionId: 'rev-7',
        activationEpoch: 'epoch-1',
        hold: () => server.rpc.holdExecution('oven'),
        expiryAction,
        maxPauseMs,
        ...(onTerminate ? { onTerminate } : {})
    })
    return { server, oven, proxy, pauses }
}

/** Wait until the component is actually inside its handler, rather than for long enough that it is. */
const running = async (oven: Oven) => {
    for (let waited = 0; waited < 2_000; waited += 5) {
        if (oven.state.inHandler) return
        await sleep(5)
    }
    throw new Error('the component never entered its handler')
}

test('the handler that was running finishes, and the component stops before the next one', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4801)

    const first = proxy.bake(60)
    await running(oven)
    // The probe fires mid-handler and asks for a pause. Nothing is interrupted.
    const paused = pauses.requested('breakpoint:oven.ts:12:9')

    t.is(await first, 1, 'the handler ran to its end under ordinary semantics')
    const state = await paused
    t.truthy(state, 'it reached quiescence and stopped')
    t.is(state?.kind, 'safe-boundary')
    t.is(state?.probeId, 'breakpoint:oven.ts:12:9')
    t.false(oven.state.inHandler, 'and the component is between units of work, not inside one')

    const next = proxy.bake(5)
    await sleep(60)
    t.is(oven.state.batches, 1, 'the next call is waiting rather than running')
    t.is(pauses.state?.waiting, 0, 'the count was taken when it stopped; what queued after is behind the barrier')

    const lease = pauses.acquire('session-1', 10_000)
    t.false('why' in lease)
    if ('why' in lease) return
    t.false('why' in pauses.continueExecution(lease.leaseId))
    t.is(await next, 2, 'and it runs when it is let go')
})

test('resuming needs the lease, because it is an act somebody has to be named for', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4802)
    const first = proxy.bake(20)
    await running(oven)
    await pauses.requested('breakpoint:1')
    await first

    const refused = pauses.continueExecution('lease-that-is-not-held')
    t.true('why' in refused)
    if ('why' in refused) t.regex(refused.why, /does not hold its debugger control/)
    t.truthy(pauses.state, 'and it is still paused')

    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    t.false('why' in pauses.continueExecution(lease.leaseId))
    t.falsy(pauses.state)
})

test('one controller at a time, and control passes explicitly and is recorded', async (t) => {
    const { pauses } = await stood(t, 4803)
    const first = pauses.acquire('session-1', 10_000)
    if ('why' in first) return t.fail(first.why)

    const second = pauses.acquire('session-2', 10_000)
    t.true('why' in second)
    if ('why' in second) t.regex(second.why, /transferred explicitly, never taken/)

    const moved = pauses.transfer(first.leaseId, 'session-2')
    t.false('why' in moved)
    if ('why' in moved) return
    t.is(moved.sessionId, 'session-2')
    t.deepEqual(
        pauses.transfers.map((one) => `${one.from}->${one.to}`),
        ['session-1->session-2'],
        'and the handover is in the record rather than only in the outcome'
    )
})

test('a pause nobody ends is ended by its deadline, and the component runs again', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4804, 'resume', 40)
    const first = proxy.bake(20)
    await running(oven)
    await pauses.requested('breakpoint:1')
    await first

    const next = proxy.bake(5)
    await sleep(60)
    t.is(pauses.sweep(), 'resume', 'the deadline passed and the declared action was applied')
    t.falsy(pauses.state)
    t.is(await next, 2, 'and what was waiting behind the barrier ran')
})

test('a stopped policy keeps it stopped and stops pretending anybody owns it', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4805, 'stopped', 40)
    const first = proxy.bake(20)
    await running(oven)
    await pauses.requested('breakpoint:1')
    await first
    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)

    await sleep(60)
    t.is(pauses.sweep(), 'stopped')
    t.truthy(pauses.state, 'still stopped, because that is what the policy said')
    t.is(pauses.state?.controllerLeaseId, undefined, 'and no longer anybody’s: somebody has to come and decide')
})

test('a terminate policy needs something to terminate with, and refuses to be configured without it', async (t) => {
    const { server } = await stood(t, 4806)
    t.throws(
        () =>
            new RpcPauseSupervisor({
                componentId: 'oven3',
                semanticRevisionId: 'rev-7',
                activationEpoch: 'epoch-1',
                hold: () => server.rpc.holdExecution('oven'),
                expiryAction: 'terminate'
            }),
        { message: /belong to the deployment/ }
    )
})

test('a terminate policy calls what it was given, once the deadline has passed', async (t) => {
    let terminated = 0
    const { oven, proxy, pauses } = await stood(t, 4807, 'terminate', 40, () => {
        terminated++
    })
    const first = proxy.bake(20)
    await running(oven)
    await pauses.requested('breakpoint:1')
    await first

    await sleep(60)
    t.is(pauses.sweep(), 'terminate')
    t.is(terminated, 1)
    t.falsy(pauses.state, 'and the barrier is not left holding a component nobody is going to come back to')
})

test('a second probe while paused is the same pause, not a second one', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4808)
    const first = proxy.bake(20)
    await running(oven)
    const one = await pauses.requested('breakpoint:1')
    await first

    const two = await pauses.requested('breakpoint:2')
    t.is(two?.pauseId, one?.pauseId, 'the component is already stopped; the second probe has not run and will not until it is resumed')
    t.is(two?.probeId, 'breakpoint:1')
})

test('a command queued through a pause runs once, because nothing here retries anything', async (t) => {
    const { oven, proxy, pauses } = await stood(t, 4809)
    const first = proxy.bake(20)
    await running(oven)
    await pauses.requested('breakpoint:1')
    await first

    // A non-repeatable command arrives while the component is stopped. It waits, and the debugger
    // does nothing to it: no retry, no replay, no answering on its behalf. The design's seventh
    // acceptance criterion is a property of what a pause does *not* do.
    const dispensed = proxy.bake(5)
    await sleep(60)
    t.is(oven.state.batches, 1, 'it has not run')

    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    pauses.continueExecution(lease.leaseId)

    t.is(await dispensed, 2)
    await sleep(40)
    t.is(oven.state.batches, 2, 'exactly once, having been paused between arriving and running')
})

test('a stop policy is a map entry rather than a rebuild, and the capture still happens', (t) => {
    const asked: string[] = []
    const sink = new RpcProbeSink({ tracepoints: { 'breakpoint:1': { stop: true, messageTemplate: 'stopping at {clamped}' } }, onStop: (probeId) => asked.push(probeId) })

    sink.receiver.tracepoint('breakpoint:1', true, { clamped: 305 })

    t.deepEqual(asked, ['breakpoint:1'], 'the sink asked for a pause')
    const capture = sink.drainCaptures()[0]
    t.true(capture?.stopRequested, 'and the capture says it was the one that asked')
    t.is(capture?.message, 'stopping at 305', 'having captured first, so the reason is there when the pause is')
})

test('a sink whose supervisor throws does not make the component the casualty', (t) => {
    const sink = new RpcProbeSink({
        tracepoints: { 'breakpoint:1': { stop: true } },
        onStop: () => {
            throw new Error('the supervisor is having a bad day')
        }
    })
    t.notThrows(() => sink.receiver.tracepoint('breakpoint:1', true, { clamped: 1 }))
    t.is(sink.drainCaptures().length, 1)
})

test('a node advertises a pause only where something can actually hold one', (t) => {
    t.false(capabilitiesFor({ sourceAvailable: true, probeSink: { maxProbesPerSession: 1, maxValueBytes: 1, maxTraceEvents: 1 } }).safeBoundaryPause)
    t.true(capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true }).safeBoundaryPause)
    t.false(capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true }).exactPause, 'and stopping between units of work is not stopping on a line')
})
