import test from 'ava'
import { isRefusal, resolveLink, type AspectLink, type AspectLocation, type AspectPlacements, type AspectRef } from './index.js'

/**
 * Following a link without losing the aspect you were reading in.
 *
 * The fixture is one plant object placed in three structures, which is the whole point of the
 * package: a pump appears in the functional aspect under the loop it serves, in the location aspect
 * under the room it stands in, and in the documentation aspect under the manual that describes it.
 * None of those is where the pump *lives*.
 */

const provider = { peer: 'plant', instance: 'assets' }
const pump: AspectRef = { provider, resource: ['equipment'], id: 'P-101' }
const valve: AspectRef = { provider, resource: ['equipment'], id: 'V-204' }
/** In no aspect at all: something the provider knows and no structure places. */
const orphan: AspectRef = { provider, resource: ['equipment'], id: 'X-999' }

const placements: { [aspectId: string]: { [id: string]: string[] } } = {
    functional: { 'P-101': ['fn:loop-12/P-101', 'fn:loop-31/P-101'], 'V-204': ['fn:loop-12/V-204'] },
    location: { 'P-101': ['loc:hall-a/room-3/P-101'], 'V-204': ['loc:hall-a/room-3/V-204'] },
    documentation: { 'V-204': ['doc:manuals/valves/V-204'] }
}

const ancestors: { [occurrenceId: string]: string[] } = {
    'fn:loop-12/P-101': ['fn:root', 'fn:loop-12', 'fn:loop-12/P-101'],
    'fn:loop-31/P-101': ['fn:root', 'fn:loop-31', 'fn:loop-31/P-101'],
    'fn:loop-12/V-204': ['fn:root', 'fn:loop-12', 'fn:loop-12/V-204'],
    'loc:hall-a/room-3/P-101': ['loc:root', 'loc:hall-a', 'loc:hall-a/room-3', 'loc:hall-a/room-3/P-101'],
    'loc:hall-a/room-3/V-204': ['loc:root', 'loc:hall-a', 'loc:hall-a/room-3', 'loc:hall-a/room-3/V-204'],
    'doc:manuals/valves/V-204': ['doc:root', 'doc:manuals', 'doc:manuals/valves', 'doc:manuals/valves/V-204']
}

const structure = (withAncestors = true): AspectPlacements => ({
    placements: (target, aspectId) => placements[aspectId]?.[target.id] ?? [],
    defaultAspectFor: () => 'functional',
    ...(withAncestors ? { ancestorsOf: (occurrenceId: string) => ancestors[occurrenceId] ?? [occurrenceId] } : {})
})

const link = (target: AspectRef, navigation?: AspectLink['navigation']): AspectLink => ({ id: 'l1', target, ...(navigation ? { navigation } : {}) })

const at = (aspectId: string, occurrenceId: string): AspectLocation => ({ target: pump, aspectId, occurrenceId, inherited: false })

test('a link with no opinion keeps the aspect the reader is already in', (t) => {
    const where = resolveLink(link(valve), at('location', 'loc:hall-a/room-3/P-101'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    // The reader is looking at the plant by location. Following a link to the valve should keep
    // them there rather than dropping them into the functional tree, which is a different subject.
    t.is(where.aspectId, 'location')
    t.is(where.occurrenceId, 'loc:hall-a/room-3/V-204')
    t.true(where.inherited)
    t.is(where.fallbackUsed, undefined)
})

test('a link that names an aspect gets it, whatever the reader was reading', (t) => {
    const where = resolveLink(link(valve, { aspect: { id: 'documentation' } }), at('location', 'loc:hall-a/room-3/P-101'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'documentation', 'the link author decided, and that decision wins')
    t.false(where.inherited)
})

test('among several placements, the one nearest where the reader is', (t) => {
    // The pump is in two loops. A reader already inside loop-12 means the loop-12 placement, and
    // "nearest" in a tree is the longest shared ancestry - there is no other measure available.
    const where = resolveLink(link(pump), at('functional', 'fn:loop-12/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.occurrenceId, 'fn:loop-12/P-101')
})

test('an explicit neighbourhood beats the reader’s own position', (t) => {
    const where = resolveLink(link(pump, { near: 'fn:loop-31/P-101' }), at('functional', 'fn:loop-12/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.occurrenceId, 'fn:loop-31/P-101', 'a caller who was explicit is not second-guessed')
})

test('with no ancestry to compare, the provider’s own order decides', (t) => {
    // A provider that cannot answer ancestry cheaply is allowed to say nothing, and the resolver
    // degrades to a stable choice rather than failing or guessing.
    const where = resolveLink(link(pump), at('functional', 'fn:loop-31/P-101'), structure(false))

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.occurrenceId, 'fn:loop-12/P-101')
})

test('an aspect that cannot place the target falls back, and says so', (t) => {
    // The pump has no documentation. Following a link to it from the documentation aspect is not a
    // failure - it is a change of subject, and the reader has to be able to notice.
    const where = resolveLink(link(pump), at('documentation', 'doc:manuals/valves/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'functional', 'the provider’s default aspect')
    t.is(where.fallbackUsed, 'target-default')
    t.false(where.inherited, 'and it does not claim to have kept a context it did not keep')
})

test('a link may insist rather than accept a change of subject', (t) => {
    const where = resolveLink(link(pump, { fallback: 'refuse' }), at('documentation', 'doc:manuals/valves/V-204'), structure())

    t.true(isRefusal(where))
    if (!isRefusal(where)) return
    t.regex(where.refused, /P-101 does not appear in documentation/)
})

test('a link may ask for the object with no structure at all', (t) => {
    const where = resolveLink(link(pump, { fallback: 'canonical' }), at('documentation', 'doc:manuals/valves/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, undefined, 'the object on its own, which is a legitimate way to read one')
    t.is(where.fallbackUsed, 'canonical')
})

test('an object no aspect places resolves to no aspect, rather than to an empty one', (t) => {
    const where = resolveLink(link(orphan), at('functional', 'fn:loop-12/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.occurrenceId, undefined, 'there is nowhere to point at, and inventing one would be a lie')
    // And no aspect either. An earlier version named the default aspect here with no occurrence in
    // it, which reads to a viewer as *show this in that tree* - and there is nothing in that tree to
    // show. Saying the object stands on its own is the true answer and the one a viewer can draw.
    t.is(where.aspectId, undefined)
    t.is(where.fallbackUsed, 'canonical')
})

test('the default aspect is still used when it can actually place the target', (t) => {
    // The other half of the same rule: falling back is right whenever there is somewhere to fall to.
    const where = resolveLink(link(pump), at('documentation', 'doc:manuals/valves/V-204'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'functional')
    t.truthy(where.occurrenceId)
    t.is(where.fallbackUsed, 'target-default')
})

test('a reader who is nowhere yet gets the default aspect', (t) => {
    const where = resolveLink(link(valve), undefined, structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'functional')
    t.is(where.fallbackUsed, 'target-default')
})

test('focus is carried through untouched', (t) => {
    const where = resolveLink(link(valve, { focus: 'block-3' }), at('location', 'loc:hall-a/room-3/P-101'), structure())

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    // Whether that block exists is the provider's question and whether a renderer can honour it is
    // the viewer's. This file has no opinion, and having one would be the wrong file to have it in.
    t.is(where.focus, 'block-3')
})
