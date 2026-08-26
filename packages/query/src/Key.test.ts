import test from 'ava'
import { pathsOverlap, revisionGoverns, rpcComponentKey, rpcPeerKey, rpcQueryKey } from './Key.js'
import { freshnessOf, supersedes } from './Freshness.js'
import { isTerminalRefusal, repeatable, rpcQueryOptions, RpcDeadlinePassed } from './Options.js'

/**
 * The judgements this package makes before any network is involved.
 *
 * All of it is pure, and all of it is the part that cannot be borrowed: which two questions are one
 * question, what an answer's freshness is, and whether a failed call may be sent again.
 */

const question = { target: 'oven3', namespace: 'oven', method: 'getList' as const, resource: ['state', 'tags'] }

test('two callers asking the same question ask one question', (t) => {
    // Built in different orders and with the absent option spelled both ways. On this link the cost
    // of getting it wrong is not an extra entry in a map, it is a page fetched twice.
    const one = rpcQueryKey({ ...question, params: { pagination: { page: 0, pageSize: 50 }, filter: undefined } })
    const two = rpcQueryKey({ ...question, params: { filter: undefined, pagination: { pageSize: 50, page: 0 } } })
    const three = rpcQueryKey({ ...question, params: { pagination: { page: 0, pageSize: 50 } } })
    t.deepEqual(one, two)
    t.deepEqual(one, three)
    // And a caller passing nothing asks the same thing as one passing an empty object.
    t.deepEqual(rpcQueryKey(question), rpcQueryKey({ ...question, params: {} }))
})

test('a different page, filter, verb, component or peer is a different question', (t) => {
    const base = rpcQueryKey({ ...question, params: { pagination: { page: 0, pageSize: 50 } } })
    const differs = (key: readonly unknown[]) => t.notDeepEqual(key, base)
    differs(rpcQueryKey({ ...question, params: { pagination: { page: 1, pageSize: 50 } } }))
    differs(rpcQueryKey({ ...question, params: { pagination: { page: 0, pageSize: 50 }, filter: { field: 'quality', op: 'eq', operand: 'bad' } } }))
    differs(rpcQueryKey({ ...question, method: 'getManyReference', params: { pagination: { page: 0, pageSize: 50 } } }))
    differs(rpcQueryKey({ ...question, namespace: 'kiln', params: { pagination: { page: 0, pageSize: 50 } } }))
    differs(rpcQueryKey({ ...question, target: 'oven4', params: { pagination: { page: 0, pageSize: 50 } } }))
    differs(rpcQueryKey({ ...question, resource: ['state', 'alarms'], params: { pagination: { page: 0, pageSize: 50 } } }))
})

test('the coarse end of the key is a scope somebody needs', (t) => {
    const key = rpcQueryKey(question)
    t.deepEqual(key.slice(0, 2), rpcPeerKey('oven3'))
    t.deepEqual(key.slice(0, 3), rpcComponentKey('oven3', 'oven'))
    t.deepEqual(key[3], ['state', 'tags'], 'the resource stays segments, so the governing rule can read the first one')
})

test('a declared resource is excluded structurally, not by policy', (t) => {
    // The reason it cannot be guidance: Relational, Document and Queue bump their revision on
    // *reads* and on a metrics timer. Wire the invalidation rule to their resources and every
    // answer invalidates itself - a poll with no period, against the peers least able to afford one.
    t.true(revisionGoverns(['state', 'tags']))
    t.true(revisionGoverns(['props', 'limits']))
    t.false(revisionGoverns(['orders']), 'a table lives behind the component, not inside it')
    t.false(revisionGoverns(['deadLetters']))
    t.false(revisionGoverns([]))
})

const live = (epoch: string, revision: number) => ({ epoch, revision, status: 'live' as const })

test('a page drawn at the revision the channel holds is confirmed current', (t) => {
    t.is(freshnessOf({ epoch: 'e1', revision: 12 }, live('e1', 12), true), 'current')
    // Ahead of the channel, which happens whenever an answer overtakes the snapshot carrying its
    // revision. It is the newest thing known, and the test runs again the moment anything newer is.
    t.is(freshnessOf({ epoch: 'e1', revision: 13 }, live('e1', 12), true), 'current')
    t.is(freshnessOf({ epoch: 'e1', revision: 11 }, live('e1', 12), true), 'possibly-changed')
})

test('unknown is a state of its own, and never dressed up as caution', (t) => {
    // Nothing watching. The console does this routinely: a component whose state is only a record
    // has no typed leaves, so it opens no subscription and there is nothing to compare against.
    t.is(freshnessOf({ epoch: 'e1', revision: 12 }, undefined, true), 'unknown')
    // A resource the revision does not govern, whatever the channel says.
    t.is(freshnessOf({ epoch: 'e1', revision: 12 }, live('e1', 12), false), 'unknown')
    // An initializing channel carries the empty epoch. Reading that as a restart would report every
    // entry changed for exactly as long as the first snapshot takes to arrive.
    t.is(freshnessOf({ epoch: 'e1', revision: 12 }, { epoch: '', revision: -1, status: 'initializing' }, true), 'unknown')
})

test('a feed going quiet weakens current, and cannot weaken what is already known', (t) => {
    // "Still true at 14:19" stops being sayable the moment the feed stops speaking...
    t.is(freshnessOf({ epoch: 'e1', revision: 12 }, { epoch: 'e1', revision: 12, status: 'stale' }, true), 'unknown')
    // ...but going quiet afterwards does not un-hear what it already said.
    t.is(freshnessOf({ epoch: 'e1', revision: 11 }, { epoch: 'e1', revision: 12, status: 'stale' }, true), 'possibly-changed')
    t.is(freshnessOf({ epoch: 'e1', revision: 11 }, { epoch: 'e1', revision: 12, status: 'closed' }, true), 'possibly-changed')
})

test('a restart is not an update', (t) => {
    t.is(freshnessOf({ epoch: 'e1', revision: 999 }, live('e2', 0), true), 'possibly-changed')
})

test('a late answer carrying an older revision does not supersede what is held', (t) => {
    t.true(supersedes({ epoch: 'e1', revision: 12 }, undefined))
    t.true(supersedes({ epoch: 'e1', revision: 12 }, { epoch: 'e1', revision: 11 }))
    t.true(supersedes({ epoch: 'e1', revision: 12 }, { epoch: 'e1', revision: 12 }), 'the same revision twice is the same data')
    t.false(supersedes({ epoch: 'e1', revision: 11 }, { epoch: 'e1', revision: 12 }))
    t.true(supersedes({ epoch: 'e2', revision: 0 }, { epoch: 'e1', revision: 12 }), 'a restart is the newest thing there is')
})

test('two paths overlap when one reaches into the other', (t) => {
    t.true(pathsOverlap(['state', 'tags'], ['state', 'tags']))
    t.true(pathsOverlap(['state', 'zones'], ['state', 'zones', 'top', 'setpoint']), 'a sets claim finer than the resource')
    t.true(pathsOverlap(['state', 'zones', 'top'], ['state', 'zones']), 'and coarser than it')
    t.false(pathsOverlap(['state', 'tags'], ['state', 'alarms']))
    t.false(pathsOverlap(['orders'], ['state', 'tags']))
})

test('nothing is retried unless the method said what it does', (t) => {
    // Undeclared means undeclared. The alternative is that the first author who forgets the
    // annotation gets automatic retries on `dispense()`, and finds out how many by counting what
    // came out of the machine.
    t.false(repeatable(undefined))
    t.false(repeatable('non-repeatable-command'))
    t.true(repeatable('query'))
    t.true(repeatable('idempotent-command'))
})

test('a refusal is not a failure, and asking again only gets it again', (t) => {
    for (const code of ['Forbidden', 'Unauthorized', 'ClassNotFound', 'MethodNotFound', 'InvalidParams', 'IncompatibleVersion', 'Superseded', 'OwnershipChanged', 'NotInControl'])
        t.true(isTerminalRefusal(Object.assign(new Error(code), { code })), code)
    // Busy means the mailbox was full and the call certainly did not run, which is the one refusal
    // worth waiting out.
    t.false(isTerminalRefusal(Object.assign(new Error('Busy'), { code: 'Busy' })))
    t.false(isTerminalRefusal(Object.assign(new Error('gone'), { code: 'TransportError' })))
    t.false(isTerminalRefusal(new Error('something')))
})

test('the retry rule reads the semantics, the refusal and the deadline in that order', (t) => {
    const ordinary = new Error('link dropped')
    t.false(rpcQueryOptions(async () => 1, {}).retry(0, ordinary), 'undeclared')
    t.false(rpcQueryOptions(async () => 1, { semantics: 'non-repeatable-command' }).retry(0, ordinary))
    t.true(rpcQueryOptions(async () => 1, { semantics: 'query' }).retry(0, ordinary))
    t.true(rpcQueryOptions(async () => 1, { semantics: 'query', attempts: 2 }).retry(1, ordinary))
    t.false(rpcQueryOptions(async () => 1, { semantics: 'query', attempts: 2 }).retry(2, ordinary), 'and then it stops')
    t.false(rpcQueryOptions(async () => 1, { semantics: 'query' }).retry(0, Object.assign(new Error('no'), { code: 'Forbidden' })))
    t.false(rpcQueryOptions(async () => 1, { semantics: 'query' }).retry(0, new RpcDeadlinePassed()), 'a passed deadline is not one more failure')
})

test('a deadline is a budget across attempts, not a timeout on each of them', async (t) => {
    const seen: (number | undefined)[] = []
    const signal = new AbortController().signal
    const options = rpcQueryOptions(
        async (attempt) => {
            seen.push(attempt.deadlineMs)
            throw new Error('nope')
        },
        { semantics: 'query', deadlineMs: 60 }
    )
    await t.throwsAsync(options.queryFn({ signal }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    await t.throwsAsync(options.queryFn({ signal }))
    t.is(seen.length, 2)
    t.true(seen[0]! <= 60 && seen[0]! > 50, 'the first attempt has the whole budget')
    t.true(seen[1]! < 40, `the second has what is left of it, not another ${60}`)

    // And when there is nothing left, the request is not issued at all: three attempts under a
    // "sixty millisecond deadline" that each restart the clock is a caller waiting three times what
    // it asked for, which is the arithmetic that killed command parking arriving by another door.
    await new Promise((resolve) => setTimeout(resolve, 40))
    await t.throwsAsync(options.queryFn({ signal }), { instanceOf: RpcDeadlinePassed })
    t.is(seen.length, 2, 'nothing was sent')
})

test('no deadline is not a deadline of zero', async (t) => {
    // `ttl: 0` means *no deadline* on this wire, so an exhausted budget arriving as a zero would
    // turn a request nobody is waiting for into one that waits for ever.
    const seen: (number | undefined)[] = []
    const options = rpcQueryOptions(async (attempt) => {
        seen.push(attempt.deadlineMs)
        return 1
    }, {})
    await options.queryFn({ signal: new AbortController().signal })
    t.deepEqual(seen, [undefined])
})
