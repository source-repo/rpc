import test from 'ava'
import { matchQuality, merge, searchAcross, searchFilter, type SearchAnswer, type SearchTarget } from './index.js'

const target = (peer: string, namespace: string, resource: string, representation = 'name'): SearchTarget => ({
    peer,
    namespace,
    resource: [resource],
    representation
})

const answering = (rows: { readonly [where: string]: readonly string[] }) => {
    const asked: string[] = []
    const ask = async (one: SearchTarget): Promise<SearchAnswer> => {
        const where = `${one.peer}.${one.namespace}.${one.resource.join('.')}`
        asked.push(where)
        const names = rows[where] ?? []
        return { ids: names.map((_, at) => `${where}#${at}`), rows: names.map((name) => ({ [one.representation]: name })) }
    }
    return { ask, asked }
}

test('one clause, against the field the resource nominated', (t) => {
    t.deepEqual(searchFilter('acme', 'name'), { field: 'name', op: 'contains', operand: 'acme' })
    // Not a sweep across every field: an object-valued field does not match a string meaningfully,
    // and scanning every column of every table is a query nobody sized.
    t.is(searchFilter('  ', 'name'), undefined)
    t.deepEqual(searchFilter('  acme ', 'name'), { field: 'name', op: 'contains', operand: 'acme' })
})

test('how well a name matched is a claim about two strings, not about relevance', (t) => {
    t.is(matchQuality('Acme', 'acme'), 'exact')
    t.is(matchQuality('Acme Ltd', 'acme'), 'prefix')
    t.is(matchQuality('The Acme Ltd', 'acme'), 'contains')
})

test('results are ordered by that, then by name, and never by arrival', async (t) => {
    const { ask } = answering({
        'a.shop.customers': ['The Acme Group', 'Acme'],
        'b.plant.tags': ['Acme Ltd']
    })
    const found = await searchAcross([target('a', 'shop', 'customers'), target('b', 'plant', 'tags')], 'acme', ask)

    t.deepEqual(
        found.hits.map((hit) => hit.name),
        ['Acme', 'Acme Ltd', 'The Acme Group'],
        'exact, then prefix, then contains - and alphabetical within each'
    )
    // Arrival order is a fact about the network. Ordering by it would make the same query answer
    // differently each time, and a list that reshuffles under a cursor is worse than an arbitrary one.
    t.deepEqual(
        found.hits.map((hit) => hit.at.peer),
        ['a', 'b', 'a']
    )
    t.is(found.asked, 2)
})

test('a hit carries where it is, which is what makes it followable', async (t) => {
    const { ask } = answering({ 'devserver.shop.customers': ['Acme Ltd'] })
    const found = await searchAcross([target('devserver', 'shop', 'customers')], 'acme', ask)

    // A locator rather than a link: the browser resolves it to a page, the CLI prints it, MCP
    // follows it. A URL would have been one consumer's answer imposed on the others.
    t.deepEqual(found.hits[0].at, { peer: 'devserver', namespace: 'shop', resource: ['customers'], id: 'devserver.shop.customers#0' })
})

test('a peer that cannot answer is a refusal, and the rest still answer', async (t) => {
    const { ask } = answering({ 'up.shop.customers': ['Acme Ltd'] })
    const flaky = async (one: SearchTarget) => {
        if (one.peer === 'down') throw new Error('no route to peer')
        return ask(one)
    }

    const found = await searchAcross([target('up', 'shop', 'customers'), target('down', 'plant', 'tags')], 'acme', flaky)
    // One machine rebooting is the ordinary state of a network with more than three on it. A search
    // that threw would answer nothing at all because of it.
    t.is(found.hits.length, 1)
    t.is(found.refused.length, 1)
    t.is(found.refused[0].target.peer, 'down')
    t.regex(found.refused[0].reason, /no route/)
    t.is(found.asked, 2, 'and it still says how many were asked, so empty and unreachable differ')
})

test('the total counts what matched, not what was returned', (t) => {
    const many = Array.from({ length: 12 }, (_, at) => ({
        at: { peer: 'a', namespace: 'n', resource: ['r'], id: String(at) },
        name: `thing ${String(at).padStart(2, '0')}`,
        match: 'contains' as const
    }))
    const merged = merge(many, 5)
    t.is(merged.hits.length, 5)
    // A search that quietly truncated would let a reader conclude a thing is not there when it is
    // one row past the cap.
    t.is(merged.total, 12)
})

test('nothing typed asks nobody', async (t) => {
    const { ask, asked } = answering({ 'a.n.r': ['Acme'] })
    const found = await searchAcross([target('a', 'n', 'r')], '   ', ask)
    t.is(found.asked, 0)
    t.deepEqual(asked, [], 'a box somebody has cleared is not a question for the whole network')
})

test('never more targets in flight than the bound allows', async (t) => {
    let inFlight = 0
    let worst = 0
    const slow = async (): Promise<SearchAnswer> => {
        inFlight += 1
        worst = Math.max(worst, inFlight)
        await new Promise((settle) => setTimeout(settle, 5))
        inFlight -= 1
        return { ids: [], rows: [] }
    }

    const many = Array.from({ length: 20 }, (_, at) => target('p', 'n', `r${at}`))
    await searchAcross(many, 'acme', slow, { concurrency: 3 })
    // The bound is the point of the package: five peers serving forty resources each is two hundred
    // questions, and issuing them together makes one person's keystroke everybody else's outage.
    t.is(worst, 3)
})
