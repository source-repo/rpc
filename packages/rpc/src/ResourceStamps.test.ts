import test from 'ava'
import { RpcResourceStamps } from './RPC/ResourceStamps.js'

/**
 * A name for the state of a whole resource, and the promises it must not make.
 *
 * `packages/conformance` asks whether a real backend moves one on a write and leaves it alone on a
 * read. What is here is the half a backend cannot demonstrate: that a resource nobody can write has
 * no stamp at all, which is what keeps a node from publishing a number that never moves.
 */

test('a resource nobody claimed has no stamp', (t) => {
    const stamps = new RpcResourceStamps('run1')
    t.is(stamps.of(['customers']), undefined)
    // Which is the failure this shape exists to prevent: a deployment that wires the registry into
    // its read service and forgets the write service publishes nothing, rather than a token that
    // stays the same however much the database moves. A node doing that would be worse than one
    // publishing no stamp at all, because a reader would believe it.
    stamps.moved(['customers'])
    t.is(stamps.of(['customers']), undefined, 'and writing to it does not conjure one either')
})

test('a claimed resource has a stamp from the moment the node is up', (t) => {
    // Not from the first write. A stamp that appeared later would be absent exactly while a reader
    // was forming the belief that this resource has none.
    const stamps = new RpcResourceStamps('run1')
    stamps.claim(['customers'])
    t.is(typeof stamps.of(['customers']), 'string')
    t.is(stamps.of(['customers']), stamps.of(['customers']), 'and reading it twice is the same state')
})

test('a write moves it and nothing else does', (t) => {
    const stamps = new RpcResourceStamps('run1')
    stamps.claim(['customers'])
    stamps.claim(['orders'])
    const before = stamps.of(['customers'])!
    stamps.moved(['customers'])
    t.not(stamps.of(['customers']), before)
    t.is(stamps.of(['orders']), `run1.0`, 'a write to one resource says nothing about another')
})

test('claiming twice does not lose what a resource has already been through', (t) => {
    // A node re-reads its catalogue while it is running - `refresh()` is an @rpc method precisely so
    // an operator can ask after a migration - and a claim that reset the counter would tell every
    // caching reader that the resource had gone back to a state it was in before.
    const stamps = new RpcResourceStamps('run1')
    stamps.claim(['customers'])
    stamps.moved(['customers'])
    const after = stamps.of(['customers'])
    stamps.claim(['customers'])
    t.is(stamps.of(['customers']), after)
})

test('a restart cannot produce a stamp a caller has already seen', (t) => {
    // The counters start again at zero, so without something naming this run the third write after a
    // restart answers a token somebody was already holding - which is the one way an opaque stamp
    // can quietly claim two different states are the same.
    const first = new RpcResourceStamps('run1')
    const second = new RpcResourceStamps('run2')
    for (const stamps of [first, second]) stamps.claim(['customers'])
    t.not(first.of(['customers']), second.of(['customers']))
    first.moved(['customers'])
    second.moved(['customers'])
    t.not(first.of(['customers']), second.of(['customers']))
})

test('two runs of a process do not share a name by accident', (t) => {
    // The default has to differ per instance, since that is what a node gets when it supplies
    // nothing. Cheap to assert and expensive to discover otherwise.
    const made = new Set(Array.from({ length: 50 }, () => new RpcResourceStamps()).map((stamps) => (stamps.claim(['t']), stamps.of(['t']))))
    t.is(made.size, 50)
})

test('a resource is named by its segments, not by a string that could be forged', (t) => {
    const stamps = new RpcResourceStamps('run1')
    stamps.claim(['a b'])
    // The separator cannot occur in a segment, so no clever name makes two different resources one.
    t.is(stamps.of(['a', 'b']), undefined)
    t.is(typeof stamps.of(['a b']), 'string')
})
