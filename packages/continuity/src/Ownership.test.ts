import test from 'ava'
import {
    addressed,
    admissibleSwap,
    fencedAt,
    fenceRefusal,
    MemoryOwnershipStore,
    RpcActivationDirectory,
    RpcActivationFence,
    RpcFenceRefused,
    RpcInputBuffer,
    type RpcActivationOwner
} from './index.js'

const owner = (activationId: string, epoch: bigint, revisionId = 'rev-1'): RpcActivationOwner => ({ componentId: 'mixer1', activationId, revisionId, epoch })

test('a first activation is a different claim from taking over, and the store can tell them apart', async (t) => {
    const store = new MemoryOwnershipStore()
    t.true('committed' in (await store.compareAndSwap(undefined, owner('a', 0n))))

    // Expecting nothing and finding an owner is a component somebody else already activated - which
    // is exactly the case a "whatever is there" upsert would swallow.
    const second = await store.compareAndSwap(undefined, owner('b', 0n))
    t.true('rejected' in second)
    if (!('rejected' in second)) return
    t.regex(second.why, /already activated as a at epoch 0/)
    t.is(second.rejected?.activationId, 'a', 'and it says what was there, so the next decision needs no second read')
})

test('an epoch succeeds the one before it or it is not a handoff', async (t) => {
    const store = new MemoryOwnershipStore()
    await store.compareAndSwap(undefined, owner('a', 0n))
    // Skipping ahead is a coordinator that has lost its place, and letting it through would leave a
    // gap no sink can distinguish from an epoch it simply has not heard about yet.
    const skipped = await store.compareAndSwap(owner('a', 0n), owner('b', 5n))
    t.true('rejected' in skipped)
    if ('rejected' in skipped) t.regex(skipped.why, /from epoch 0 to 5/)
    t.true('committed' in (await store.compareAndSwap(owner('a', 0n), owner('b', 1n))))
})

test('exactly one of two racing handoffs commits, and the loser is told what beat it', async (t) => {
    const store = new MemoryOwnershipStore()
    await store.compareAndSwap(undefined, owner('a', 0n))
    // Both read the same incumbent, as two coordinators that started at the same moment would.
    const [first, second] = await Promise.all([store.compareAndSwap(owner('a', 0n), owner('b', 1n)), store.compareAndSwap(owner('a', 0n), owner('c', 1n))])
    t.is(['committed' in first, 'committed' in second].filter(Boolean).length, 1)
    const loser = 'rejected' in first ? first : 'rejected' in second ? second : undefined
    t.regex(loser!.why, /reload the owner and decide again/)
})

test('handing a component to the activation already holding it is refused rather than treated as a no-op', async (t) => {
    // It reads as harmless and is not: it would burn an epoch, so every fence a caller is holding
    // breaks for a change that did not happen.
    t.regex(admissibleSwap(owner('a', 3n), owner('a', 3n), owner('a', 4n))!, /already holding it/)
})

test('a store says what it can actually guarantee, because a Map cannot guarantee it', async (t) => {
    // The one field that matters under partition is the one a single-process store must answer
    // `false` to. A coordinator reading `compareAndSwap` and inferring linearizability would produce
    // exactly the reassuring log line a split brain needs to go unnoticed.
    const { linearizable, durable, fencedAtTheSink } = new MemoryOwnershipStore().capabilities
    t.false(linearizable)
    t.false(durable)
    t.false(fencedAtTheSink)
})

test('a shadow activation may not act, and says which of the two reasons it is', async (t) => {
    const fence = new RpcActivationFence('mixer1', 'b', 1n)
    const shadow = t.throws(() => fence.stamp({ open: 'valve-3' }), { instanceOf: RpcFenceRefused })
    t.regex(shadow!.message, /is a shadow activation and may not act/)

    fence.open()
    t.is(fence.stamp({ open: 'valve-3' }).epoch, 1n)

    fence.close()
    const retired = t.throws(() => fence.stamp({ open: 'valve-3' }), { instanceOf: RpcFenceRefused })
    t.regex(retired!.message, /has been fenced at epoch 1/)
})

test('a fenced activation does not come back, because nobody knows what its successor did meanwhile', async (t) => {
    const fence = new RpcActivationFence('mixer1', 'a', 0n)
    fence.open()
    fence.close()
    t.throws(() => fence.open(), { instanceOf: RpcFenceRefused, message: /its successor has already acted/ })
})

test('an act produced before the swap and delivered after it is refused where it lands', async (t) => {
    // The delayed-message half of "at most one epoch may commit". A stamped it while it was
    // authoritative and it was correct then; the sink is the only party still in a position to
    // notice that it is not correct now, and it does not need A to be reachable to do so.
    const store = new MemoryOwnershipStore()
    await store.compareAndSwap(undefined, owner('a', 0n))
    const a = new RpcActivationFence('mixer1', 'a', 0n)
    a.open()
    const inFlight = a.stamp({ setpoint: 300 })

    t.deepEqual(await fencedAt(store, inFlight), { setpoint: 300 })
    await store.compareAndSwap(owner('a', 0n), owner('b', 1n))
    const refused = await t.throwsAsync(fencedAt(store, inFlight), { instanceOf: RpcFenceRefused })
    t.regex(refused!.message, /produced by an activation that has since been replaced/)
    t.is(refused!.currentEpoch, 1n)
})

test('an act from an epoch ahead of the sink is refused too, because a claim is not evidence', async (t) => {
    // The tempting relaxation is `<` rather than `!==`, and it is wrong in the direction that
    // matters: accepting an epoch the sink has not been told about makes the sink's own view of
    // ownership decorative, and a forged or misconfigured activation walks straight through.
    t.regex(fenceRefusal(owner('a', 2n), { componentId: 'mixer1', epoch: 9n, act: null })!, /has not been told about/)
    t.regex(fenceRefusal(undefined, { componentId: 'mixer1', epoch: 0n, act: null })!, /no recorded owner/)
})

test('a resolution has a shelf life, and it is the epoch', async (t) => {
    const store = new MemoryOwnershipStore()
    const directory = new RpcActivationDirectory(store)
    directory.register('a', { peer: 'node-a', instance: 'mixer' })
    directory.register('b', { peer: 'node-b', instance: 'mixer' })
    await store.compareAndSwap(undefined, owner('a', 0n))

    // One logical name throughout: what changes underneath it is which process answers.
    const held = (await directory.resolve('mixer1'))!
    t.is(held.address.peer, 'node-a')
    t.is(await directory.stale(held), undefined)

    await store.compareAndSwap(owner('a', 0n), owner('b', 1n))
    t.is((await directory.resolve('mixer1'))!.address.peer, 'node-b', 'the same logical name, and callers changed nothing')
    t.regex((await directory.stale(held))!, /it has been handed over since/)
})

test('a shadow is addressable without being authoritative, which is what preparation needs', async (t) => {
    // Collapsing registration into ownership would make the shadow unreachable during the very
    // phase that has to restore it and ask whether it is ready.
    const store = new MemoryOwnershipStore()
    const directory = new RpcActivationDirectory(store)
    directory.register('b', { peer: 'node-b', instance: 'mixer' })
    t.deepEqual(directory.addressOf('b'), { peer: 'node-b', instance: 'mixer' })
    t.is(await directory.resolve('mixer1'), undefined, 'registered is not owning')

    await store.compareAndSwap(undefined, owner('a', 0n))
    t.is(await directory.resolve('mixer1'), undefined, 'and an owner nobody can reach resolves to nothing rather than to a stale address')
    t.is(addressed(owner('a', 0n), { peer: 'node-a', instance: 'mixer' }).epoch, 0n)
})

test('deregistering is not fencing, and does not pretend to be', async (t) => {
    const store = new MemoryOwnershipStore()
    const directory = new RpcActivationDirectory(store)
    directory.register('a', { peer: 'node-a', instance: 'mixer' })
    await store.compareAndSwap(undefined, owner('a', 0n))
    directory.deregister('a')
    // The owner record still says a. Removing an address stops new callers finding it and does
    // nothing whatever to one already talking to it - which is why the fence exists separately.
    t.is((await store.read('mixer1'))!.activationId, 'a')
    t.regex((await directory.stale(addressed(owner('a', 0n), { peer: 'node-a', instance: 'mixer' })))!, /no longer registered anywhere/)
})

test('a buffer holds nothing until a barrier says to, and nothing after it has let go', async (t) => {
    const buffer = new RpcInputBuffer<string>(100n, 'at-least-once-deduplicated', 3)
    // A buffer that quietly passed inputs through when it was not buffering would be a second path
    // into the component, invisible exactly when the first is being reasoned about carefully.
    t.like(buffer.accept('early'), { refused: 'not-buffering' })

    buffer.begin()
    t.deepEqual(buffer.accept('one'), { sequence: 101n })
    t.deepEqual(buffer.accept('two'), { sequence: 102n })
    t.deepEqual(buffer.accept('three'), { sequence: 103n })
    t.like(buffer.accept('four'), { refused: 'full' })

    const seen: [string, bigint][] = []
    t.deepEqual(await buffer.release((input, sequence) => void seen.push([input, sequence])), { delivered: 3, through: 103n })
    t.deepEqual(seen, [
        ['one', 101n],
        ['two', 102n],
        ['three', 103n]
    ])
    t.like(buffer.accept('late'), { refused: 'released' })
    t.like(await buffer.release(() => {}), { refused: 'released' }, 'released once, because twice would redeliver a non-repeatable command')
})

test('abandoning a handoff returns what was held rather than dropping it', async (t) => {
    // A failed change and a lossy one are different things, and only the second is unrecoverable.
    const buffer = new RpcInputBuffer<string>(7n, 'exactly-once')
    buffer.begin()
    buffer.accept('a')
    buffer.accept('b')
    const back: string[] = []
    t.deepEqual(await buffer.abandon((input) => void back.push(input)), { returned: 2 })
    t.deepEqual(back, ['a', 'b'])
})
