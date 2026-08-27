import test, { type ExecutionContext } from 'ava'
import { randomUUID } from 'node:crypto'
import { rpc, RpcClient, RpcComponent, rpcNamespace, RpcServer } from '@source-repo/rpc'
import {
    captureAtBarrier,
    fencedAt,
    handOver,
    MemoryOwnershipStore,
    RpcActivationDirectory,
    RpcActivationFence,
    RpcFenceRefused,
    RpcInputBuffer,
    RpcObligationLedger,
    stateSchemaHash,
    type RpcActivationOwner,
    type RpcHandoffRequest,
    type RpcRestoreDeclaration,
    type RpcSnapshotEnvelope
} from './index.js'

/**
 * A replacement, end to end, against real servers.
 *
 * The point of standing two of them up rather than modelling the protocol is that the properties
 * being checked are about *what a caller sees*: the same logical name before and after, no
 * observable trace of a preparation that failed, and an act from the retired activation refused
 * where it lands rather than where it was produced. None of those can fail against a mock.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface MixerProps { label: string; [key: string]: unknown }
interface MixerState { batches: number; dwelling: boolean; [key: string]: unknown }

@rpcNamespace('mixer', { execution: 'serial' })
class Mixer extends RpcComponent<MixerProps, MixerState> {
    constructor(label: string) {
        super({ label }, { batches: 0, dwelling: false })
    }

    /** What a successor's managed runtime does with a restored snapshot. Not part of the contract. */
    take(state: MixerState) {
        this.setState(state)
    }

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
 * A pause the test controls, placed where the handoff's window actually is.
 *
 * `opened` resolves when the coordinator has reached the gate, so a test acts inside the window
 * rather than after a sleep that is either too short to be reliable or too long to be quick.
 */
const deferred = () => {
    let open!: () => void
    let reached!: () => void
    const held = new Promise<void>((resolve) => (open = resolve))
    const opened = new Promise<void>((resolve) => (reached = resolve))
    return {
        opened,
        open,
        gate: () => {
            reached()
            return held
        }
    }
}

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

const ownerOf = (activationId: string, epoch: bigint, revisionId = 'rev-1'): RpcActivationOwner => ({ componentId: 'mixer1', activationId, revisionId, epoch })

/**
 * Two activations of one logical component: A serving, B prepared and fenced.
 *
 * B is a separate server on a separate port with its own instance of the component, which is what a
 * replacement actually is - not the same object with new methods bolted on.
 */
const plant = async (t: ExecutionContext, portA: number, portB: number) => {
    const serverA = new RpcServer({ name: peer(`a${portA}`), transports: [{ port: portA, host: '127.0.0.1' }] })
    const mixerA = new Mixer('Mixer 1 (rev-1)')
    serverA.exposeClassInstance(mixerA, 'mixer')
    await serverA.ready()

    const serverB = new RpcServer({ name: peer(`b${portB}`), transports: [{ port: portB, host: '127.0.0.1' }] })
    const mixerB = new Mixer('Mixer 1 (rev-2)')
    serverB.exposeClassInstance(mixerB, 'mixer')
    await serverB.ready()

    const client = new RpcClient(`http://localhost:${portA}`, { name: peer(`ask${portA}`), defaultTarget: peer(`a${portA}`) })
    const proxyA = await client.proxy<Mixer>('mixer')

    const store = new MemoryOwnershipStore()
    await store.compareAndSwap(undefined, ownerOf('a', 0n))
    const directory = new RpcActivationDirectory(store)
    directory.register('a', { peer: peer(`a${portA}`), instance: 'mixer' })
    directory.register('b', { peer: peer(`b${portB}`), instance: 'mixer' })

    const fenceA = new RpcActivationFence('mixer1', 'a', 0n)
    fenceA.open()
    const fenceB = new RpcActivationFence('mixer1', 'b', 1n)

    t.teardown(async () => {
        await client.close()
        await serverA.close()
        await serverB.close()
    })
    return { serverA, serverB, mixerA, mixerB, client, proxyA, store, directory, fenceA, fenceB }
}

/** Everything `handOver` needs, with the two hooks a test wants to vary left to the caller. */
const handoff = async (
    stand: Awaited<ReturnType<typeof plant>>,
    over: {
        declarations?: readonly RpcRestoreDeclaration[]
        restore?: RpcHandoffRequest<MixerState>['restore']
        buffer?: RpcInputBuffer<unknown>
        delivered?: [unknown, bigint][]
        returned?: [unknown, bigint][]
        /** Held open inside `restore`, which is where the buffering window actually is. */
        gate?: () => Promise<void>
        ledger?: RpcObligationLedger
    } = {}
) => {
    const hold = stand.serverA.rpc.holdExecution('mixer')
    const buffer = over.buffer ?? new RpcInputBuffer<unknown>(9000n, 'at-least-once-deduplicated')
    const delivered = over.delivered ?? []
    const returned = over.returned ?? []
    let restored: RpcSnapshotEnvelope<MixerState> | undefined
    const outcome = await handOver<MixerState>({
        componentId: 'mixer1',
        store: stand.store,
        successor: { activationId: 'b', revisionId: 'rev-2' },
        incumbentFence: stand.fenceA,
        successorFence: stand.fenceB,
        buffer,
        declarations: over.declarations ?? [],
        clock: { now: 0n },
        capture: async () =>
            captureAtBarrier<MixerProps, MixerState>({
                component: stand.mixerA,
                hold,
                ledger: over.ledger ?? new RpcObligationLedger(),
                componentType: 'mixer',
                componentId: 'mixer1',
                sourceRevision: 'rev-1',
                stateSchemaId: 'mixer.state',
                stateVersion: 1,
                stateSchemaHash: await schemaOf(),
                activationEpoch: 0n,
                logicalTime: 1200n,
                lastAppliedInputSequence: 9000n,
                lastCommittedOutputSequence: 8999n,
                quiescenceDeadlineMs: 300
            }),
        releaseBarrier: () => hold.release(),
        restore:
            over.restore ??
            (async (snapshot) => {
                await over.gate?.()
                restored = snapshot
                stand.mixerB.take(snapshot.heldState)
                return undefined
            }),
        deliver: (input, sequence) => void delivered.push([input, sequence]),
        returnToIncumbent: (input, sequence) => void returned.push([input, sequence])
    })
    return { outcome, buffer, delivered, returned, restored, hold }
}

test('callers keep the same logical address across a replacement', async (t) => {
    const stand = await plant(t, 4501, 4502)
    await stand.proxyA.startBatch(1)

    // What a caller holds is a resolution of one name. Nothing about the name changes; what changes
    // is which process it resolves to, and that is the whole of the routing indirection.
    const before = (await stand.directory.resolve('mixer1'))!
    t.is(before.address.peer, peer('a4501'))
    t.is(before.revisionId, 'rev-1')

    const { outcome } = await handoff(stand)
    t.true('activated' in outcome)

    const after = (await stand.directory.resolve('mixer1'))!
    t.is(after.componentId, before.componentId, 'the same logical component')
    t.is(after.address.peer, peer('b4502'), 'and a different process answering for it')
    t.is(after.revisionId, 'rev-2')
    t.regex((await stand.directory.stale(before))!, /handed over since/, 'and the resolution the caller was holding says so rather than pointing at a retired process')
})

test('a preparation that fails leaves the incumbent exactly as it was', async (t) => {
    const stand = await plant(t, 4503, 4504)
    await stand.proxyA.startBatch(1)
    const buffer = new RpcInputBuffer<unknown>(9000n, 'exactly-once')

    const { outcome, returned } = await handoff(stand, {
        buffer,
        restore: async () => 'the successor could not open its connection to the hopper'
    })

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.classification, 'refused')
    t.is(outcome.abandoned.reachedStage, 'restore')

    // Every observable thing about A is where it was: still the owner, still authoritative, still
    // answering, and the barrier is gone rather than left holding the component shut.
    t.is((await stand.store.read('mixer1'))!.activationId, 'a')
    t.true(stand.fenceA.authoritative)
    t.false(stand.fenceB.authoritative)
    t.is((await stand.directory.resolve('mixer1'))!.address.peer, peer('a4503'))
    t.is(await stand.proxyA.startBatch(1), 2, 'and it took the next command as though nothing had been attempted')
    t.deepEqual(returned, [], 'nothing was buffered, so nothing came back')
})

test('what was buffered goes back to the incumbent when the handoff is abandoned', async (t) => {
    const stand = await plant(t, 4505, 4506)
    const buffer = new RpcInputBuffer<unknown>(9000n, 'exactly-once')
    const returned: [unknown, bigint][] = []

    // The inputs land in the window, as a caller's command would.
    const gate = deferred()
    const running = handoff(stand, { buffer, returned, restore: async () => { await gate.gate(); return 'not ready' } })
    await gate.opened
    buffer.accept('open valve 3')
    buffer.accept('close valve 3')
    gate.open()
    await running

    // A failed change and a lossy one are different things, and only the second cannot be recovered.
    t.deepEqual(returned, [
        ['open valve 3', 9001n],
        ['close valve 3', 9002n]
    ])
})

test('at most one epoch may act, and the retired one cannot act even before it hears', async (t) => {
    const stand = await plant(t, 4507, 4508)
    const inFlight = stand.fenceA.stamp({ open: 'valve-3' })
    t.deepEqual(await fencedAt(stand.store, inFlight), { open: 'valve-3' }, 'authoritative when it was produced')

    const { outcome } = await handoff(stand)
    t.true('activated' in outcome)

    // The local half: A stops willingly, immediately, because it was told.
    const local = t.throws(() => stand.fenceA.stamp({ open: 'valve-3' }), { instanceOf: RpcFenceRefused })
    t.regex(local!.message, /has been fenced at epoch 0/)

    // The half that matters: the act A produced while it was still correct arrives late at the sink
    // and is refused there. Nothing about this requires A to have been reachable, which is the whole
    // point - a partitioned A is exactly the one that never heard.
    const stale = await t.throwsAsync(fencedAt(stand.store, inFlight), { instanceOf: RpcFenceRefused })
    t.regex(stale!.message, /has since been replaced/)
    t.is(stale!.currentEpoch, 1n)
})

test('the successor is opened only after the incumbent is fenced, never alongside it', async (t) => {
    const stand = await plant(t, 4509, 4510)

    // Sampling before and after would not catch this: both orders leave exactly one authoritative
    // activation at both instants, and the wrong one passes every other test in this file. What has
    // to be observed is the moment of the transition, so each fence records what the other looked
    // like as it was called.
    const seen: string[] = []
    const watch = (fence: RpcActivationFence, who: string, other: RpcActivationFence) => {
        const opened = fence.open.bind(fence)
        const closed = fence.close.bind(fence)
        fence.open = () => {
            seen.push(`open ${who} while other is ${other.authoritative ? 'authoritative' : 'not'}`)
            opened()
        }
        fence.close = () => {
            seen.push(`close ${who}`)
            closed()
        }
    }
    watch(stand.fenceA, 'a', stand.fenceB)
    watch(stand.fenceB, 'b', stand.fenceA)

    t.deepEqual([stand.fenceA.authoritative, stand.fenceB.authoritative], [true, false])
    await handoff(stand)

    // The other order leaves a window in which two activations are both authoritative. It is short,
    // and it is long enough: it is exactly when both processes are running and reachable.
    t.deepEqual(seen, ['close a', 'open b while other is not'])
    t.deepEqual([stand.fenceA.authoritative, stand.fenceB.authoritative], [false, true])
    t.true(stand.fenceA.retired, 'and retired rather than merely idle, so it cannot be reopened')
})

test('the successor is given exactly the sequence following the barrier, in order', async (t) => {
    const stand = await plant(t, 4511, 4512)
    const buffer = new RpcInputBuffer<unknown>(9000n, 'at-least-once-deduplicated')
    const delivered: [unknown, bigint][] = []

    const gate = deferred()
    const running = handoff(stand, { buffer, delivered, gate: gate.gate })
    await gate.opened
    for (const input of ['one', 'two', 'three']) buffer.accept(input)
    gate.open()
    const { outcome } = await running

    t.true('activated' in outcome)
    if (!('activated' in outcome)) return
    // 9000 is the barrier's `lastAppliedInputSequence`. The successor starts at 9001 because that is
    // what the snapshot says A had not yet applied - the position is a fact about the cut, not a
    // counter the buffer chose.
    t.is(outcome.activated.barrierSequence, 9000n)
    t.deepEqual(delivered, [
        ['one', 9001n],
        ['two', 9002n],
        ['three', 9003n]
    ])
    t.is(outcome.activated.releasedThrough, 9003n)
    t.is(outcome.activated.bufferedInputs, 3)
})

test('a capture that cannot be taken blocks the handoff temporarily rather than refusing it', async (t) => {
    const stand = await plant(t, 4513, 4514)
    // A handler that outlasts the quiescence deadline. The plant is busy, which is a different
    // situation from the revisions disagreeing, and an operator who cannot tell them apart will
    // retry both when only one is worth retrying.
    const inFlight = stand.proxyA.startBatch(500)
    await running(stand.mixerA)
    const { outcome } = await handoff(stand)

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.classification, 'temporarily-blocked')
    t.is(outcome.abandoned.reachedStage, 'capture')
    t.regex(outcome.abandoned.why, /partially executed handler/)
    t.is(await inFlight, 1, 'and the incumbent carried on, which is the correct outcome rather than a fallback')
    t.is((await stand.store.read('mixer1'))!.activationId, 'a')
})

test('a handoff that loses the ownership race changes neither routing nor authority', async (t) => {
    const stand = await plant(t, 4515, 4516)
    // Somebody else completed a handoff while this one was preparing. The coordinator read the
    // incumbent at the start and is now working from an answer that has expired.
    const gate = deferred()
    const running = handoff(stand, { gate: gate.gate })
    await gate.opened
    await stand.store.compareAndSwap(ownerOf('a', 0n), ownerOf('c', 1n))
    gate.open()
    const { outcome } = await running

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.reachedStage, 'activate')
    t.regex(outcome.abandoned.why, /reload the owner and decide again/)
    t.false(stand.fenceB.authoritative, 'and B never became authoritative')
    t.is((await stand.store.read('mixer1'))!.activationId, 'c')
})

test('a successor whose fence does not name the epoch it will get fences nothing', async (t) => {
    const stand = await plant(t, 4517, 4518)
    const wrong = { ...stand, fenceB: new RpcActivationFence('mixer1', 'b', 7n) }
    const { outcome } = await handoff(wrong)
    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.reachedStage, 'prepare')
    t.regex(outcome.abandoned.why, /fences nothing/)
})

test('a failure after the commit point is reported as one, and does not restore the stale snapshot', async (t) => {
    const stand = await plant(t, 4519, 4520)
    const buffer = new RpcInputBuffer<unknown>(9000n, 'exactly-once')
    const gate = deferred()
    const running = handoff(stand, { buffer, gate: gate.gate })
    await gate.opened
    buffer.accept('one')
    // Released out from under the coordinator, which is a stand-in for whatever goes wrong between
    // the swap and the delivery. What matters is not this particular cause but that the answer is
    // never "put A back".
    await buffer.release(() => {})
    gate.open()
    const { outcome } = await running

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.classification, 'failed-after-commit')
    t.is(outcome.abandoned.committedEpoch, 1n, 'B holds the epoch, and holding it is not undone by this having failed')
    t.regex(outcome.abandoned.why, /Recover forward/)
    t.is((await stand.store.read('mixer1'))!.activationId, 'b')
    t.true(stand.fenceB.authoritative)
    t.true(stand.fenceA.retired, 'and A is not quietly reinstated, because nobody knows what B already did')
})

test('the record says what was agreed, and says so differently when something was not carried across', async (t) => {
    const stand = await plant(t, 4521, 4522)
    const { outcome } = await handoff(stand)
    t.true('activated' in outcome)
    if (!('activated' in outcome)) return
    t.is(outcome.activated.classification, 'activated')
    t.is(outcome.activated.from.activationId, 'a')
    t.is(outcome.activated.to.revisionId, 'rev-2')
    t.is(outcome.activated.committedEpoch, 1n)
    t.truthy(outcome.activated.snapshotId)
    t.regex(outcome.activated.why, /every obligation assumed unchanged/)
})

test('the successor restores the values the barrier caught, not the ones it had before', async (t) => {
    const stand = await plant(t, 4523, 4524)
    await stand.proxyA.startBatch(1)
    await stand.proxyA.startBatch(1)
    t.is(stand.mixerB.state.batches, 0, 'B was prepared with nothing')

    const { outcome, restored } = await handoff(stand)
    t.true('activated' in outcome)
    t.is(restored!.heldState.batches, 2)
    t.is(stand.mixerB.state.batches, 2)
    t.is(restored!.captureKind, 'quiescent-handoff')
})

test('an obligation the successor says nothing about stops the handoff before ownership moves', async (t) => {
    const stand = await plant(t, 4525, 4526)
    const ledger = new RpcObligationLedger()
    ledger.register({ kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 5_000n, capturedAt: 1_000n, policy: 'preserve-remaining' })

    // The successor declares nothing. Silence is not a claim, and this is the guard that turns that
    // rule into a handoff that does not happen rather than a plant handed to a program that does not
    // know it is holding a deadline.
    const { outcome } = await handoff(stand, { ledger, declarations: [] })

    t.true('abandoned' in outcome)
    if (!('abandoned' in outcome)) return
    t.is(outcome.abandoned.classification, 'refused')
    t.is(outcome.abandoned.reachedStage, 'restore')
    t.regex(outcome.abandoned.why, /silence is not a claim/)
    t.is(outcome.abandoned.dispositions.find((entry) => entry.id === 'mix-dwell')!.resolution, 'unhonourable', 'and the record says which obligation it was')
    t.is((await stand.store.read('mixer1'))!.activationId, 'a')
    t.false(stand.fenceB.authoritative)

    // Declared, and the same handoff goes through.
    const again = await handoff(stand, { ledger, declarations: [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' }] })
    t.true('activated' in again.outcome)
})

test('a timer carried across a handoff by policy is recorded as a consequence, not as nothing', async (t) => {
    const stand = await plant(t, 4527, 4528)
    const ledger = new RpcObligationLedger()
    ledger.register({ kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 5_000n, capturedAt: 1_000n, policy: 'preserve-remaining' })

    // Restarting the dwell is a legitimate decision and an observable one: the bake is longer than
    // it would have been. The classification is what makes that visible to whoever signs the change
    // off, rather than leaving it in a field nobody reads.
    const { outcome } = await handoff(stand, { ledger, declarations: [{ id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'restart' }] })
    t.true('activated' in outcome)
    if (!('activated' in outcome)) return
    t.is(outcome.activated.classification, 'activated-with-recorded-consequences')
    t.is(outcome.activated.dispositions[0].resolution, 'reestablished')
    t.regex(outcome.activated.why, /1 of 1 obligations were not carried across unchanged/)
})
