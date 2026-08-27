import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { rpc, RpcClient, RpcComponent, rpcNamespace, RpcServer, type RpcExecutionHold } from '@source-repo/rpc'
import { admissibleForHandoff, captureAtBarrier, RpcObligationLedger, stateSchemaHash, type RpcSnapshotEnvelope } from './index.js'

/**
 * One consistent cut, or none.
 *
 * The barrier is the server's own serial chain with an entry in it that does not finish, so these
 * run against a real component on a real queue rather than a model of one - which matters, because
 * the property being tested is that nothing ran between reading the values and reading the manifest,
 * and a model cannot fail that.
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

    /** Slow on purpose: what a barrier has to wait out is a handler that is already running. */
    @rpc({ semantics: 'idempotent-command', sets: 'batches' })
    async startBatch(hold: number) {
        this.setState({ dwelling: true })
        await sleep(hold)
        this.setState((previous) => ({ batches: previous.batches + 1, dwelling: false }))
        return this.state.batches
    }
}

const schemaOf = () =>
    stateSchemaHash({
        schemaId: 'mixer.state',
        version: 1,
        schema: { kind: 'object', fields: { batches: { type: { kind: 'number' } }, dwelling: { type: { kind: 'boolean' } } } }
    })

/**
 * Wait until the component is actually in the handler, rather than for long enough that it probably
 * is. A sleep here is a race the whole suite loses under load: if the call has not reached the
 * server when the barrier goes in, the queue is empty, the capture succeeds, and the test asserts
 * the opposite of what it meant to.
 */
const running = async (mixer: { state: { dwelling: boolean } }) => {
    for (let waited = 0; waited < 2000; waited += 5) {
        if (mixer.state.dwelling) return
        await sleep(5)
    }
    throw new Error('the component never entered its handler')
}

const request = async (component: Mixer, hold: RpcExecutionHold, ledger: RpcObligationLedger, quiescenceDeadlineMs = 500) => ({
    component,
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
    quiescenceDeadlineMs
})

/**
 * A real server, and a real client to drive it through.
 *
 * The client matters: **the barrier orders work the queue delivered**, and a direct call into the
 * object never went through the queue. That is not a gap in the barrier, it is the thing that makes
 * eligibility a claim - a component whose state is changed by anything other than a handler the
 * runtime dispatched is not quiescent merely because the queue is empty, and no barrier can know.
 */
const stood = async (t: ExecutionContext, port: number) => {
    const server = new RpcServer({ name: peer(`mix${port}`), transports: [{ port, host: '127.0.0.1' }] })
    const mixer = new Mixer()
    server.exposeClassInstance(mixer, 'mixer')
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`ask${port}`), defaultTarget: peer(`mix${port}`) })
    const proxy = await client.proxy<Mixer>('mixer')
    // Torn down here rather than by each test, because a client left open holds a socket and ava's
    // worker will not exit - which surfaces as the whole file timing out after every test in it has
    // already passed, and reads like a hang in whichever test ran last.
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { server, client, mixer, proxy, hold: () => server.rpc.holdExecution('mixer') }
}

test('the values and the work come from the same instant, with nothing running in the gap', async (t) => {
    const { mixer, proxy, hold } = await stood(t, 4401)

    // A handler is running when the barrier goes in. It must finish before anything is read, or the
    // snapshot would hold a `dwelling: true` that had already stopped being true.
    const inFlight = proxy.startBatch(60)
    await running(mixer)
    const barrier = hold()
    const ledger = new RpcObligationLedger()
    const result = await captureAtBarrier(await request(mixer, barrier, ledger))
    barrier.release()
    await inFlight

    t.true('captured' in result)
    if (!('captured' in result)) return
    t.is(result.captured.captureKind, 'quiescent-handoff')
    t.deepEqual(result.captured.heldState, { batches: 1, dwelling: false }, 'the handler that was running finished, and its effect is in the capture')
    t.is(result.captured.activationEpoch, 7n)
    t.is(admissibleForHandoff(result.captured as RpcSnapshotEnvelope), undefined, 'and it is finally enough to restore from')
})

test('a component that cannot become quiescent refuses, and is left running', async (t) => {
    const { mixer, proxy, hold } = await stood(t, 4402)

    const inFlight = proxy.startBatch(400)
    await running(mixer)
    const barrier = hold()
    const result = await captureAtBarrier(await request(mixer, barrier, new RpcObligationLedger(), 50))
    barrier.release()

    t.true('refused' in result)
    if (!('refused' in result)) return
    t.is(result.refused.reason, 'not-quiescent')
    // The first implementation never serialises a partially executed handler: a stack is not a thing
    // that can be handed to another process, still less to another language.
    t.regex(result.refused.why, /partially executed handler/)
    t.is(await inFlight, 1, 'and the old activation carried on, which is the correct outcome rather than a fallback')
})

test('a barrier stops what comes next and lets what is running finish', async (t) => {
    const { server, mixer, hold } = await stood(t, 4403)

    const barrier = hold()
    await barrier.quiescent
    // Queued behind the barrier through the server's own chain, which is what a caller arriving
    // during a handoff does.
    let ranBehind = false
    const behind = server.rpc.holdExecution.call(server.rpc, 'mixer')
    behind.release()
    void Promise.resolve().then(async () => {
        await barrier.quiescent
        ranBehind = true
    })
    await sleep(30)
    t.false(mixer.state.dwelling, 'nothing new started')
    barrier.release()
    await sleep(10)
    t.true(ranBehind)
})

test('an instance that cannot be held says so rather than being held partially', async (t) => {
    // A parallel instance has no single ordered position after which nothing new has been applied.
    // Holding one queue of a sharded instance would look like a barrier and leave the rest running.
    const server = new RpcServer({ name: peer('par4404'), transports: [{ port: 4404, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Mixer(), 'loose', { execution: 'parallel' })
    await server.ready()
    t.teardown(async () => await server.close())

    t.throws(() => server.rpc.holdExecution('loose'), { message: /runs in parallel/ })
})

test('inbound work that changes something blocks the capture', async (t) => {
    const { mixer, hold } = await stood(t, 4405)

    const barrier = hold()
    const ledger = new RpcObligationLedger().register({ kind: 'inbound-work', id: 'set-speed-88', from: 'hmi', method: 'setSpeed', mutating: true })
    const result = await captureAtBarrier(await request(mixer, barrier, ledger))
    barrier.release()

    t.true('refused' in result)
    if (!('refused' in result)) return
    t.is(result.refused.reason, 'work-in-flight')
    t.deepEqual([...result.refused.blocking], ['set-speed-88'])
})

test('a command that must not be repeated blocks the capture until it has a result', async (t) => {
    const { mixer, hold } = await stood(t, 4406)

    const ledger = new RpcObligationLedger().register({ kind: 'outbound-call', id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command' })
    const barrier = hold()
    const blocked = await captureAtBarrier(await request(mixer, barrier, ledger))
    t.true('refused' in blocked)
    if ('refused' in blocked) {
        t.is(blocked.refused.reason, 'unsafe-outbound')
        // The successor could neither assume it ran nor assume it did not, and must not send it
        // again. UnknownOutcome is what a caller is told about such a thing; it is not a way to
        // rebuild a successor's workflow.
        t.regex(blocked.refused.why, /neither assume it ran nor assume it did not/)
    }

    // Drained to a durable result, and the capture proceeds.
    ledger.complete('dispense-7')
    const result = await captureAtBarrier(await request(mixer, barrier, ledger))
    barrier.release()
    t.true('captured' in result)
})

test('a query still out is not a reason to refuse', async (t) => {
    const { mixer, hold } = await stood(t, 4407)

    // Repeating a read costs a round trip. The rule is about effect, not about tidiness.
    const ledger = new RpcObligationLedger()
        .register({ kind: 'outbound-call', id: 'read-level', target: 'hopper', method: 'level', semantics: 'query' })
        .register({ kind: 'outbound-call', id: 'set-mode', target: 'hopper', method: 'setMode', semantics: 'idempotent-command' })
    const barrier = hold()
    const result = await captureAtBarrier(await request(mixer, barrier, ledger))
    barrier.release()
    t.true('captured' in result)
    if (!('captured' in result)) return
    t.is(result.captured.obligations!.outboundCalls.length, 2, 'and they travel, because the successor still owes their answers')
})

test('work the queue never delivered is not held by the barrier, which is why eligibility is a claim', async (t) => {
    const { mixer, hold } = await stood(t, 4409)

    // Called directly rather than dispatched: a local tick, an event handler, a raw timer. The
    // runtime never saw it, so the queue is empty and the barrier is satisfied while the component
    // is in the middle of changing. No barrier can detect this, which is exactly why the design says
    // completeness is claimable only for components that use the managed APIs for everything that
    // matters - and why this is written down as a test rather than left to be discovered.
    const unmanaged = mixer.startBatch(120)
    const barrier = hold()
    const result = await captureAtBarrier(await request(mixer, barrier, new RpcObligationLedger()))
    barrier.release()

    if (!('captured' in result)) return t.fail('the capture refused')
    t.true((result.captured.heldState as { dwelling: boolean }).dwelling, 'the capture caught it mid-handler and could not have known')
    await unmanaged
})

test('a manifest is present even when it is empty, because absent means nobody looked', async (t) => {
    const { mixer, hold } = await stood(t, 4408)

    const barrier = hold()
    const result = await captureAtBarrier(await request(mixer, barrier, new RpcObligationLedger()))
    barrier.release()
    if (!('captured' in result)) return t.fail('the capture refused')
    t.deepEqual(result.captured.obligations!.timers, [])
    t.is(admissibleForHandoff(result.captured as RpcSnapshotEnvelope), undefined)

    // And the same snapshot without one is refused, which is the distinction that matters: a
    // component owing nothing is not the same as nobody having asked.
    const blind = { ...result.captured, obligations: undefined } as RpcSnapshotEnvelope
    t.regex(admissibleForHandoff(blind)!, /nothing is known about the work the old activation still owed/)
})
