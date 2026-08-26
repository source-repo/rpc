import test from 'ava'
import { RpcDataCache, type RpcDataAnswer } from './Cache.js'
import type { RpcQuestion } from './Key.js'

/**
 * The pull half, behaving.
 *
 * Everything here runs without a network, because the cache is *given* how to ask rather than
 * opening anything - which is the same property that lets a Node service use it, and is why these
 * are the rules rather than a mock of them.
 */

/** A component channel, as far as this package is concerned: an epoch, a revision and a status. */
const channel = (epoch = 'e1', revision = 0, status: 'initializing' | 'live' | 'stale' | 'closed' = 'live') => {
    const listeners = new Set<() => void>()
    let at = { epoch, revision, status }
    return {
        getSnapshot: () => at,
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        publish: (next: Partial<typeof at>) => {
            at = { ...at, ...next }
            for (const listener of [...listeners]) listener()
        }
    }
}

/** A peer that answers, and counts what it was asked. */
const peer = (epoch = 'e1', revision = 0) => {
    const asked: RpcQuestion[] = []
    const state = { epoch, revision, rows: ['a'] }
    return {
        asked,
        state,
        ask: async (question: RpcQuestion): Promise<RpcDataAnswer> => {
            asked.push(question)
            return { data: [...state.rows], ids: [...state.rows], total: state.rows.length, epoch: state.epoch, revision: state.revision }
        }
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const tags: RpcQuestion = { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['state', 'tags'] }
const orders: RpcQuestion = { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['orders'] }
const heldIds = (cache: RpcDataCache, question: RpcQuestion) => cache.queryClient.getQueryData<RpcDataAnswer>(cache.key(question) as unknown as readonly unknown[])?.ids

test('a period tick over a confirmed-current answer asks for nothing at all', async (t) => {
    // The whole reason this replaces a polling loop. A five second period against a quiet plant
    // becomes free: the publisher has said nothing since the page was drawn, so there is nothing on
    // the far side to fetch, and on the link this library was written for the request that is never
    // made is worth more than any amount of caching the one that is.
    const source = channel('e1', 7)
    const link = peer('e1', 7)
    const cache = new RpcDataCache({ ask: link.ask })
    cache.observe(tags.target, tags.namespace, source)
    const watch = cache.watch(tags, { periodMs: 20 })

    await wait(140)
    t.is(link.asked.length, 1, 'one request, and then six ticks that cost nothing')
    t.is(watch.getSnapshot().freshness, 'current')
    watch.close()
    cache.close()
})

test('when the publisher says something, the next tick asks', async (t) => {
    const source = channel('e1', 7)
    const link = peer('e1', 7)
    const cache = new RpcDataCache({ ask: link.ask })
    cache.observe(tags.target, tags.namespace, source)
    const watch = cache.watch(tags, { periodMs: 20 })
    await wait(60)
    t.is(link.asked.length, 1)

    link.state.revision = 8
    link.state.rows = ['a', 'b']
    source.publish({ revision: 8 })
    // Marked, not fetched: the publisher's rate is the publisher's, and a component committing sixty
    // times a second must not become sixty requests a second from every console watching it.
    t.is(link.asked.length, 1, 'the publish itself asks for nothing')
    t.is(watch.getSnapshot().freshness, 'possibly-changed')

    await wait(80)
    t.is(link.asked.length, 2, 'the tick after it does')
    t.is(watch.getSnapshot().freshness, 'current')
    t.deepEqual(watch.getSnapshot().data?.ids, ['a', 'b'])
    watch.close()
    cache.close()
})

test('a revision move leaves a declared resource alone', async (t) => {
    // The exclusion that has to be structural. Relational, Document and Queue bump their revision on
    // *reads* and on a metrics timer - wire the rule to their resources and every answer invalidates
    // itself, which is a poll with no period against the peers least able to afford one.
    const source = channel('e1', 7)
    const link = peer('e1', 7)
    const cache = new RpcDataCache({ ask: link.ask, unknownStaleMs: 60_000 })
    cache.observe(orders.target, orders.namespace, source)

    await cache.fetch(orders)
    await cache.fetch(tags)
    t.is(link.asked.length, 2)

    source.publish({ revision: 8 })
    await cache.fetch(orders)
    t.is(link.asked.length, 2, 'a table behind the component is not what the revision spoke about')

    await cache.fetch(tags)
    t.is(link.asked.length, 3, 'the state the revision does describe is asked again')
    cache.close()
})

test('a restart takes the declared resources with it', async (t) => {
    // The asymmetry, and it is the right way round. A component that came back is a process that was
    // restarted: a store-backed one may have reconnected to a different database, replayed a queue,
    // or been pointed somewhere else entirely. Nothing it said in a previous life survives.
    const source = channel('e1', 7)
    const link = peer('e1', 7)
    const cache = new RpcDataCache({ ask: link.ask, unknownStaleMs: 60_000 })
    cache.observe(orders.target, orders.namespace, source)
    await cache.fetch(orders)
    await cache.fetch(tags)
    t.is(link.asked.length, 2)

    link.state.epoch = 'e2'
    link.state.revision = 0
    source.publish({ epoch: 'e2', revision: 0 })
    await wait(10)

    await cache.fetch(orders)
    await cache.fetch(tags)
    t.is(link.asked.length, 4, 'both were asked again')
    cache.close()
})

test('an answer that arrives late carrying an older revision does not land', async (t) => {
    // Two requests for one key and the second answered first, which a network where one peer is
    // reached over MQTT will do. Without the rule the first answer lands last, and the cache ends up
    // holding the older page reported `current` on a test that was never really made.
    const source = channel('e1', 12)
    let answer: RpcDataAnswer = { data: ['new'], ids: ['new'], total: 1, epoch: 'e1', revision: 12 }
    const cache = new RpcDataCache({ ask: async () => answer })
    cache.observe(tags.target, tags.namespace, source)
    const key = cache.key(tags) as unknown as readonly unknown[]

    await cache.fetch(tags)
    t.deepEqual(heldIds(cache, tags), ['new'])

    answer = { data: ['old'], ids: ['old'], total: 1, epoch: 'e1', revision: 11 }
    await cache.queryClient.refetchQueries({ queryKey: key })
    t.deepEqual(heldIds(cache, tags), ['new'], 'the older answer had nothing to add')

    // A restart always wins, whatever the revision says - the numbering starts over.
    answer = { data: ['after'], ids: ['after'], total: 1, epoch: 'e2', revision: 0 }
    await cache.queryClient.refetchQueries({ queryKey: key })
    t.deepEqual(heldIds(cache, tags), ['after'])
    cache.close()
})

test('a settled call re-asks what it claims to have touched, and nothing else', async (t) => {
    const link = peer()
    const cache = new RpcDataCache({ ask: link.ask, unknownStaleMs: 60_000 })
    const zones: RpcQuestion = { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['state', 'zones'] }
    const alarms: RpcQuestion = { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['state', 'alarms'] }
    for (const question of [zones, alarms, orders]) await cache.fetch(question)

    // `sets: 'zones.top.setpoint'` reaches into `state.zones` and says nothing whatsoever about the
    // alarms beside it. What this replaces is a counter the console kept that re-asked every
    // collection in the pane after any successful edit.
    t.is(cache.settled({ target: 'oven3', namespace: 'oven', sets: 'zones.top.setpoint' }), 1)
    // An action offered on a row names its resource structurally - the button lives on that
    // resource's own action list - which is how a declared resource gets the same narrowing.
    t.is(cache.settled({ target: 'oven3', namespace: 'oven', resource: ['orders'] }), 1)
    cache.close()
})

test('a call that declares nothing invalidates nothing', async (t) => {
    // The degradation is the point rather than a gap. `sets` declares intent, is optional, and
    // carries no compatibility rule - so a method that says nothing must cost nothing, and what
    // still covers that case is the revision compare, which is a fact rather than a claim.
    const link = peer()
    const cache = new RpcDataCache({ ask: link.ask })
    await cache.fetch(tags)
    t.is(cache.settled({ target: 'oven3', namespace: 'oven' }), 0)
    t.is(cache.settled({ target: 'oven3', namespace: 'oven', sets: '' }), 0)
    cache.close()
})

test('two callers asking at once ask once', async (t) => {
    const link = peer()
    const cache = new RpcDataCache({ ask: link.ask })
    const [one, two] = await Promise.all([cache.fetch(tags), cache.fetch({ ...tags, params: {} })])
    t.is(link.asked.length, 1, 'stampede protection, which the cache does by construction')
    t.is(one, two)
    cache.close()
})

test('nothing is asked while nobody is looking', async (t) => {
    const listeners = new Set<(active: boolean) => void>()
    let active = false
    const activity = {
        get active() {
            return active
        },
        subscribe: (onChange: (active: boolean) => void) => {
            listeners.add(onChange)
            return () => {
                listeners.delete(onChange)
            }
        }
    }
    const link = peer()
    const cache = new RpcDataCache({ ask: link.ask })
    const watch = cache.watch(tags, { periodMs: 20, activity })

    await wait(60)
    t.is(link.asked.length, 0, 'a console left open over a weekend should not spend a link on it')

    active = true
    for (const listener of [...listeners]) listener(true)
    await wait(20)
    t.is(link.asked.length, 1, 'and coming back asks immediately rather than waiting out a period')
    watch.close()
    cache.close()
})

test('the freshness of an answer nobody is watching is unknown, and says so', async (t) => {
    const link = peer('e1', 7)
    const cache = new RpcDataCache({ ask: link.ask })
    await cache.fetch(tags)
    t.is(cache.freshness(tags), 'unknown', 'no channel open: the signal is silently absent, and that is a state')

    cache.observe(tags.target, tags.namespace, channel('e1', 7))
    t.is(cache.freshness(tags), 'current')
    cache.close()
})
