import test, { type ExecutionContext } from 'ava'
import { fileURLToPath } from 'node:url'
import { RpcWorkerHost } from '@source-repo/rpc'
import { capabilitiesFor, RpcPauseSupervisor, RpcProbeSink } from './index.js'

/**
 * Stopping a component on a line rather than between calls.
 *
 * The supervisor is the same one that drives a safe-boundary stop; what differs is the mechanism it
 * was handed. Given a barrier it can only stop what has not started, and given the gate of a
 * worker-hosted component it stops the logic *between two statements of a handler* - so the kind of
 * pause is a property of the mechanism, and these check that a supervisor cannot claim one while
 * producing the other.
 *
 * The worker is `@source-repo/rpc`'s test fixture, which gates between its own statements the way an
 * instrumented build's probes would.
 */

const workerModule = fileURLToPath(new URL('../../rpc/dist/RPC/fixture/ovenWorker.js', import.meta.url))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Oven {
    bake(target: number): Promise<{ setpoint: number; batches: number }>
    soak(ms: number): Promise<number>
    ungated(): Promise<number>
}

const stood = async (t: ExecutionContext, options: { expiryAction?: 'resume' | 'stopped'; maxPauseMs?: number; maxWaitForPauseMs?: number } = {}) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 10_000 })
    t.teardown(async () => {
        await host.close()
    })
    const oven = await host.callable<Oven>()
    const pauses = new RpcPauseSupervisor({
        componentId: 'oven3',
        semanticRevisionId: 'rev-7',
        activationEpoch: 'epoch-1',
        // The whole wiring: the supervisor drives the gate of the thread the logic runs on.
        gate: host.gate,
        expiryAction: options.expiryAction ?? 'resume',
        maxPauseMs: options.maxPauseMs ?? 5_000,
        ...(options.maxWaitForPauseMs !== undefined ? { maxWaitForPauseMs: options.maxWaitForPauseMs } : {})
    })
    return { host, oven, pauses }
}

test('a component is stopped inside a handler, and says that is where it stopped', async (t) => {
    const { oven, pauses } = await stood(t)

    // A handler that gates over a span, so the request lands while it is still running. Asking for
    // a pause after issuing a call is otherwise a race against another thread - the request only
    // affects gates reached after it, which is the mechanism being honest rather than flaky.
    const soaking = oven.soak(400)
    await sleep(20)
    const paused = await pauses.requested('breakpoint:oven.ts:24:9')

    t.truthy(paused)
    t.is(paused?.kind, 'exact', 'not a safe boundary: the handler is part-way through, not finished')
    t.is(paused?.probeId, 'breakpoint:oven.ts:24:9')
    t.true(pauses.state !== undefined)

    // The supervisor's thread is demonstrably alive while the component's is not.
    let ticks = 0
    const ticking = setInterval(() => ticks++, 5)
    await sleep(60)
    clearInterval(ticking)
    t.true(ticks > 3, `the supervisor ran ${ticks} times while the component was stopped`)

    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    t.false('why' in pauses.continueExecution(lease.leaseId))
    t.true((await soaking) > 0, 'and the handler finished the work it had begun')
})

test('resuming continues the same handler: the batch is counted once', async (t) => {
    const { oven, pauses } = await stood(t)

    // Requested first: `requested` sets the flag synchronously before it starts waiting, so the
    // handler meets it at its very first gate rather than racing it.
    const paused = pauses.requested('breakpoint:1')
    const baking = oven.bake(420)
    t.truthy(await paused)
    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    pauses.continueExecution(lease.leaseId)

    // Counted once, not twice: an exact pause that re-ran the handler would have baked two batches,
    // which is the failure this mode has to be incapable of.
    t.deepEqual(await baking, { setpoint: 300, batches: 1 })
    t.deepEqual(await oven.bake(100), { setpoint: 100, batches: 2 })
})

test('resuming an exact pause still needs the lease', async (t) => {
    const { oven, pauses } = await stood(t)
    const paused = pauses.requested('breakpoint:1')
    const baking = oven.bake(200)
    t.truthy(await paused)

    const refused = pauses.continueExecution('lease-that-is-not-held')
    t.true('why' in refused)
    t.truthy(pauses.state, 'and it is still stopped, on a line, until somebody who may say so says so')

    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    pauses.continueExecution(lease.leaseId)
    await baking
})

test('an exact pause nobody ends is ended by its deadline, like any other', async (t) => {
    const { oven, pauses } = await stood(t, { maxPauseMs: 40 })
    const paused = pauses.requested('breakpoint:1')
    const baking = oven.bake(200)
    t.truthy(await paused)

    await sleep(60)
    t.is(pauses.sweep(), 'resume')
    t.falsy(pauses.state)
    t.deepEqual(await baking, { setpoint: 200, batches: 1 }, 'and the component ran on')
})

test('a request that never parks is withdrawn rather than left standing', async (t) => {
    const { host, oven, pauses } = await stood(t, { maxWaitForPauseMs: 40 })
    // Nothing is running and nothing will be, so no gate is reached within the wait.
    await host.gate.untilRunning(50)

    const outcome = await pauses.requested('breakpoint:1')
    t.is(outcome, undefined, 'it did not stop, and says so rather than reporting a pause that has not happened')
    t.falsy(pauses.state)
    t.false(host.gate.requested, 'and the request is withdrawn: a component that parked later with nobody watching would be worse')

    t.deepEqual(await oven.bake(150), { setpoint: 150, batches: 1 }, 'so the next call runs straight through')
})

test('a supervisor has exactly one mechanism, so it cannot claim a stop it did not make', (t) => {
    const both = () =>
        new RpcPauseSupervisor({
            componentId: 'oven3',
            semanticRevisionId: 'rev-7',
            activationEpoch: 'epoch-1',
            hold: () => ({ quiescent: Promise.resolve(), waiting: () => 0, release: () => undefined }),
            gate: { request: () => undefined, release: () => undefined, paused: false, untilPaused: async () => true },
            expiryAction: 'resume'
        })
    t.throws(both, { message: /exactly one mechanism/ })

    const neither = () => new RpcPauseSupervisor({ componentId: 'oven3', semanticRevisionId: 'rev-7', activationEpoch: 'epoch-1', expiryAction: 'resume' })
    t.throws(neither, { message: /it cannot stop anything/ })
})

test('a node advertises the stop it can actually make, and not the other one', async (t) => {
    const { pauses } = await stood(t)
    t.is(pauses.kind, 'exact')

    const exact = capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true, exactPause: true })
    t.true(exact.exactPause)
    t.true(exact.safeBoundaryPause, 'an exact stop is a safe boundary reached the hard way, and both are true')

    const barrierOnly = capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true })
    t.true(barrierOnly.safeBoundaryPause)
    t.false(barrierOnly.exactPause, 'a barrier can only stop what has not started')
    t.false(exact.stepping, 'and stepping is a predicate over frames that nothing evaluates yet')
})

test('the sink asks, and what it asks stops a line rather than a call', async (t) => {
    const { oven, pauses } = await stood(t)
    // The whole path: a probe with a stop policy captures, the sink asks, the supervisor parks the
    // logic thread. Nothing between the probe and the pause knows which mechanism is underneath.
    let asked: ReturnType<RpcPauseSupervisor['requested']> | undefined
    const sink = new RpcProbeSink({
        tracepoints: { 'breakpoint:1': { stop: true } },
        onStop: (probeId) => {
            asked = pauses.requested(probeId)
        }
    })

    const soaking = oven.soak(400)
    await sleep(20)
    sink.receiver.tracepoint('breakpoint:1', true, { clamped: 300 })

    const paused = await asked
    t.is(paused?.kind, 'exact', 'the probe asked, and what it got was a stop on a line')
    t.is(paused?.probeId, 'breakpoint:1')

    const lease = pauses.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)
    pauses.continueExecution(lease.leaseId)
    t.true((await soaking) > 0)
})
