import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { rpc, RpcClient, RpcComponent, rpcNamespace, RpcServer, type RpcExecutionHold } from '@source-repo/rpc'
import { captureAtBarrier, dispatchOn, RpcActivationFence, RpcManagedRuntime, stateSchemaHash, type RpcObligationLedger } from './index.js'

/**
 * What the runtime holds, and what it cannot see.
 *
 * These run against a real server on a real queue, because the property under test is that a managed
 * timer lands *in* the chain rather than beside it - and a fake dispatch that calls its argument
 * would pass every one of them while proving nothing. The two components below are the same
 * component written the two ways: one that does its waiting through the runtime, and one that calls
 * `setInterval` and is therefore not eligible for online change however green its tests are.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface MixerProps { label: string; [key: string]: unknown }
interface MixerState { batches: number; dwelling: boolean; [key: string]: unknown }

@rpcNamespace('mixer', { execution: 'serial' })
class Mixer extends RpcComponent<MixerProps, MixerState> {
    constructor() {
        super({ label: 'Mixer 1' }, { batches: 0, dwelling: false })
    }

    /** Called from a timer callback rather than remotely: the point is which chain it runs on. */
    finishDwell() {
        this.setState((previous) => ({ batches: previous.batches + 1, dwelling: false }))
    }

    @rpc({ semantics: 'idempotent-command', sets: 'dwelling' })
    async startBatch(hold: number) {
        this.setState({ dwelling: true })
        await sleep(hold)
        return this.state.dwelling
    }
}

/** The same component, writing to itself from a timer nobody dispatched. */
@rpcNamespace('drifter', { execution: 'serial' })
class Drifter extends RpcComponent<MixerProps, MixerState> {
    private ticking?: ReturnType<typeof setInterval>

    constructor() {
        super({ label: 'Drifter' }, { batches: 0, dwelling: false })
    }

    start(everyMs: number) {
        this.ticking = setInterval(() => this.setState((previous) => ({ batches: previous.batches + 1 })), everyMs)
        this.ticking.unref?.()
    }

    stop() {
        if (this.ticking) clearInterval(this.ticking)
    }
}

const schemaOf = () =>
    stateSchemaHash({
        schemaId: 'mixer.state',
        version: 1,
        schema: { kind: 'object', fields: { batches: { type: { kind: 'number' } }, dwelling: { type: { kind: 'boolean' } } } }
    })

const request = async (component: object, hold: RpcExecutionHold, ledger: RpcObligationLedger, extra: Record<string, unknown> = {}) => ({
    component: component as { props: MixerProps; state: MixerState },
    hold,
    ledger,
    componentType: 'mixer',
    componentId: 'mixer1',
    sourceRevision: 'rev-1',
    stateSchemaId: 'mixer.state',
    stateVersion: 1,
    stateSchemaHash: await schemaOf(),
    activationEpoch: 7n,
    logicalTime: 1200n,
    lastAppliedInputSequence: 9000n,
    lastCommittedOutputSequence: 8999n,
    quiescenceDeadlineMs: 500,
    ...extra
})

const stood = async <T extends object>(t: ExecutionContext, port: number, path: string, make: () => T) => {
    const server = new RpcServer({ name: peer(`srv${port}`), transports: [{ port, host: '127.0.0.1' }] })
    const component = make()
    server.exposeClassInstance(component, path)
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`srv${port}`) })
    const proxy = await client.proxy<T>(path)
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { server, component, proxy, hold: () => server.rpc.holdExecution(path) }
}

/** A clock a test can advance, since these assert on remaining time rather than wait it out. */
const counting = (start = 1000n) => {
    let at = start
    return { now: () => at, advance: (by: bigint) => (at += by) }
}

test('a managed timer that comes due while a barrier is held queues behind it rather than writing through it', async (t) => {
    const { component, server, hold } = await stood(t, 4601, 'mixer', () => new Mixer())
    // Dispatched onto the mixer's own chain, which is the whole property under test.
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    runtime.setTimer({ id: 'mix-dwell', afterMs: 30, policy: 'preserve-remaining' }, () => component.finishDwell())
    const barrier = hold()
    await sleep(80) // well past due: the handle has fired and its callback is queued behind the barrier

    t.is(component.state.batches, 0, 'the callback did not run: it is behind the barrier, where a call would be')
    const result = await captureAtBarrier(await request(component, barrier, runtime.ledger))
    t.true('captured' in result)
    if (!('captured' in result)) return
    t.is(result.captured.obligations?.timers.length, 1, 'and it is still outstanding, because it has not run')
    t.is(result.captured.obligations?.timers[0]?.id, 'mix-dwell')
    t.is(result.captured.heldState.batches, 0)
})

test('a timer struck off the moment its handle fired would hand over a manifest that says nothing is pending', async (t) => {
    const { component, server } = await stood(t, 4604, 'mixer', () => new Mixer())
    const clock = counting()
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: clock.now })
    t.teardown(() => runtime.close())

    runtime.setTimer({ id: 'mix-dwell', afterMs: 10, policy: 'preserve-remaining' }, () => component.finishDwell())
    const barrier = server.rpc.holdExecution('mixer')
    await sleep(50)
    t.truthy(runtime.ledger.at('mix-dwell'), 'held: the work it represents has not happened yet')

    barrier.release()
    for (let waited = 0; waited < 1000 && runtime.ledger.at('mix-dwell'); waited += 5) await sleep(5)
    t.falsy(runtime.ledger.at('mix-dwell'), 'and gone once it actually ran')
    t.is(component.state.batches, 1)
})

test('a fenced activation does not run the timer that was queued behind its own replacement', async (t) => {
    const { component, server } = await stood(t, 4605, 'mixer', () => new Mixer())
    const fence = new RpcActivationFence('mixer1', 'a', 3n)
    fence.open()
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now, fence })
    t.teardown(() => runtime.close())

    runtime.setTimer({ id: 'mix-dwell', afterMs: 10, policy: 'preserve-remaining' }, () => component.finishDwell())
    const barrier = server.rpc.holdExecution('mixer')
    await sleep(40)
    fence.close() // the swap committed while the callback sat in the queue
    barrier.release()
    await sleep(40)

    t.is(component.state.batches, 0, 'the successor owns this plant now, and nobody knows what it has already done')
    t.truthy(runtime.ledger.at('mix-dwell'), 'and the obligation stays, because it is what the successor was handed')
})

test('re-arming replaces, so one id never names two handles', async (t) => {
    const { component, server } = await stood(t, 4606, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    runtime.setTimer({ id: 'mix-dwell', afterMs: 10, policy: 'preserve-remaining' }, () => component.finishDwell())
    runtime.setTimer({ id: 'mix-dwell', afterMs: 20, policy: 'preserve-remaining' }, () => component.finishDwell())
    await sleep(80)

    t.is(component.state.batches, 1, 'one timer fired, not two')
    t.is(runtime.ledger.size, 0)
})

test('clearing a timer takes it off the books; closing does not', async (t) => {
    const { component, server } = await stood(t, 4607, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })

    runtime.setTimer({ id: 'mix-dwell', afterMs: 10, policy: 'preserve-remaining' }, () => component.finishDwell())
    runtime.setTimer({ id: 'watchdog', afterMs: 10, policy: 'refuse-if-overdue' }, () => component.finishDwell())
    runtime.clearTimer('mix-dwell')
    t.falsy(runtime.ledger.at('mix-dwell'), 'disarmed, so nobody owes anything for it')

    runtime.close()
    await sleep(40)
    t.is(component.state.batches, 0, 'a closed runtime does not fire')
    t.truthy(runtime.ledger.at('watchdog'), 'and what it was holding is exactly what the successor is asked about')
    t.throws(() => runtime.setTimer({ id: 'later', afterMs: 10, policy: 'restart' }, () => undefined), undefined, 'a retired activation may not arm new work')
})

test("a timer's remaining time is measured from the capture, not from when it was armed", async (t) => {
    const { component, server } = await stood(t, 4608, 'mixer', () => new Mixer())
    const clock = counting(1_000n)
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: clock.now })
    t.teardown(() => runtime.close())

    runtime.setTimer({ id: 'mix-dwell', afterMs: 5_000, policy: 'preserve-remaining' }, () => component.finishDwell())
    runtime.clearTimer('mix-dwell')
    runtime.ledger.register({ kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 6_000n, capturedAt: 1_000n, policy: 'preserve-remaining' })
    clock.advance(3_000n) // three seconds of the five have gone by

    const barrier = server.rpc.holdExecution('mixer')
    const result = await captureAtBarrier(await request(component, barrier, runtime.ledger, { monotonic: clock.now }))
    barrier.release()

    t.true('captured' in result)
    if (!('captured' in result)) return
    const timer = result.captured.obligations?.timers[0]
    t.is(timer?.dueAt, 6_000n)
    t.is(timer?.capturedAt, 4_000n, 'two seconds left, which is what preserve-remaining has to mean')
})

test('a call is on the books from before it is sent until after it is answered', async (t) => {
    const { server } = await stood(t, 4609, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    let seen: string | undefined
    const answer = await runtime.call({ id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command', idempotencyKey: 'batch-19/dispense' }, async () => {
        // Read from inside the send, which is the window a register-afterwards API leaves empty.
        seen = runtime.ledger.at('dispense-7')?.kind
        return 'poured'
    })

    t.is(answer, 'poured')
    t.is(seen, 'outbound-call', 'the command was in the plant and on the books at the same time')
    t.is(runtime.ledger.size, 0, 'and it left when the answer came back')
})

test('a non-repeatable command that may have run stays outstanding, and only evidence discharges it', async (t) => {
    const { component, server } = await stood(t, 4610, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    const lost = Object.assign(new Error('the link went while the request was out'), { code: 'UnknownOutcome' })
    await t.throwsAsync(runtime.call({ id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command' }, () => Promise.reject(lost)))
    t.truthy(runtime.ledger.at('dispense-7'), 'nobody knows whether the hopper dispensed, and the ledger is where that fact lives')

    const barrier = server.rpc.holdExecution('mixer')
    const refused = await captureAtBarrier(await request(component, barrier, runtime.ledger))
    t.true('refused' in refused)
    if ('refused' in refused) t.is(refused.refused.reason, 'unsafe-outbound')

    runtime.discharge('dispense-7') // a reconciliation read established what happened
    const second = await captureAtBarrier(await request(component, barrier, runtime.ledger))
    barrier.release()
    t.true('captured' in second)
})

test('a definite failure is a discharged obligation: it certainly did not run', async (t) => {
    const { server } = await stood(t, 4611, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    const refused = Object.assign(new Error('the instance is not there'), { code: 'OwnershipChanged' })
    await t.throwsAsync(runtime.call({ id: 'dispense-8', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command' }, () => Promise.reject(refused)))
    t.is(runtime.ledger.size, 0)
})

test('an inbound handler clears itself even when it throws', async (t) => {
    const { server } = await stood(t, 4612, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    await t.throwsAsync(runtime.handling({ id: 'start-19', from: 'line', method: 'startBatch', mutating: true }, () => Promise.reject(new Error('the valve did not open'))))
    t.is(runtime.ledger.size, 0, 'a handler that failed is not a handler that is still running')
})

test('a subscription keeps its position, so a re-established feed continues rather than resets', async (t) => {
    const { server } = await stood(t, 4613, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    runtime.subscribed({ id: 'alarms', event: 'alarm' })
    runtime.acknowledged('alarms', 4_100n)
    runtime.leased({ id: 'hopper', issuer: 'hopper-manager', expiresAt: 9_000n, issuerSupportsLogicalOwner: true })
    runtime.renewed('hopper', 12_000n)
    runtime.advanced('batches', 19n)

    const manifest = runtime.manifest()
    t.is(manifest.subscriptions[0]?.lastAcknowledgedSequence, 4_100n)
    t.is(manifest.leases[0]?.expiresAt, 12_000n)
    t.is(manifest.sequences[0]?.position, 19n)

    runtime.unsubscribed('alarms')
    runtime.released('hopper')
    t.is(runtime.manifest().subscriptions.length, 0)
    t.is(runtime.manifest().leases.length, 0)
})

test('a component written to from outside the runtime is detected while it is held, and refused', async (t) => {
    const { component, server } = await stood(t, 4614, 'drifter', () => new Drifter())
    component.start(10)
    t.teardown(() => component.stop())
    const runtime = new RpcManagedRuntime({ componentId: 'drifter1', dispatch: dispatchOn(server.rpc, 'drifter'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    const barrier = server.rpc.holdExecution('drifter')
    const result = await captureAtBarrier(await request(component, barrier, runtime.ledger, { settleMs: 60 }))
    barrier.release()

    t.true('refused' in result)
    if (!('refused' in result)) return
    t.is(result.refused.reason, 'unmanaged-mutation')
    t.regex(result.refused.why, /outside the runtime/)
})

test('registered work that is still running explains the movement better than "something wrote to it"', async (t) => {
    const { component, server } = await stood(t, 4618, 'drifter', () => new Drifter())
    component.start(10)
    t.teardown(() => component.stop())
    const runtime = new RpcManagedRuntime({ componentId: 'drifter1', dispatch: dispatchOn(server.rpc, 'drifter'), monotonic: counting().now })
    t.teardown(() => runtime.close())
    runtime.ledger.register({ kind: 'inbound-work', id: 'start-19', from: 'line', method: 'startBatch', mutating: true })

    const barrier = server.rpc.holdExecution('drifter')
    const result = await captureAtBarrier(await request(component, barrier, runtime.ledger, { settleMs: 40 }))
    barrier.release()

    t.true('refused' in result)
    // Both are true of this component. Reporting the anonymous one would send somebody looking for a
    // stray timer when the manifest already names the handler that never finished.
    if ('refused' in result) t.is(result.refused.reason, 'work-in-flight')
})

test('and without a settle window nothing is watched, which is the limit rather than a bug', async (t) => {
    const { component, server } = await stood(t, 4615, 'drifter', () => new Drifter())
    component.start(10)
    t.teardown(() => component.stop())
    const runtime = new RpcManagedRuntime({ componentId: 'drifter1', dispatch: dispatchOn(server.rpc, 'drifter'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    const barrier = server.rpc.holdExecution('drifter')
    const result = await captureAtBarrier(await request(component, barrier, runtime.ledger))
    barrier.release()

    // The capture succeeds and is internally consistent - and the snapshot is of a component that
    // was already moving on. This is what `serialisedHandlers` in a revision manifest is a claim
    // about, and why it is a claim rather than a check.
    t.true('captured' in result)
})

test('a component the runtime cannot watch refuses to be claimed as watched', async (t) => {
    const { server } = await stood(t, 4616, 'mixer', () => new Mixer())
    const runtime = new RpcManagedRuntime({ componentId: 'mixer1', dispatch: dispatchOn(server.rpc, 'mixer'), monotonic: counting().now })
    t.teardown(() => runtime.close())

    const barrier = server.rpc.holdExecution('mixer')
    // Not an RpcComponent: perfectly capturable, and there is no counter behind it to watch.
    await t.throwsAsync(captureAtBarrier(await request({ props: {}, state: { batches: 0 } }, barrier, runtime.ledger, { settleMs: 10 })), { message: /no revision counter to watch/ })
    barrier.release()
})

test('work put in order behind a barrier is counted as waiting, and a parallel instance has no chain to put it on', async (t) => {
    const { server } = await stood(t, 4617, 'mixer', () => new Mixer())
    const barrier = server.rpc.holdExecution('mixer')
    let ran = false
    const queued = server.rpc.runInOrder('mixer', () => {
        ran = true
    })
    await sleep(20)

    t.false(ran, 'behind the barrier, where a call would be')
    t.is(barrier.waiting(), 1, 'and counted, because it runs the moment the barrier lifts')
    barrier.release()
    await queued
    t.true(ran)

    server.exposeClassInstance(new Mixer(), 'loose', { execution: 'parallel' })
    t.throws(() => server.rpc.runInOrder('loose', () => undefined), { message: /in parallel/ })
})
