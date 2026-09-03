import { expect, test } from 'vitest'
import { asWatch, channelsFor, everythingIn, holds, movedNode, scopesIn, watchKey, watchProjection, withNode, withoutNode, type Watch } from './watching.js'
import type { DescribedComponent, ServerDescription } from './types.js'

const node = (peer: string, namespace: string, ...path: string[]) => ({ peer, namespace, path })

test('a key cannot be forged by spelling one part cleverly', () => {
    // The separator is why. A peer called `a.b` and a namespace called `c` must not key the same as
    // a peer called `a` and a namespace called `b.c`, and with a dot between them they would.
    expect(watchKey(node('a.b', 'c', 'state'))).not.toBe(watchKey(node('a', 'b.c', 'state')))
    expect(watchKey(node('a', 'b', 'state', 'zones'))).toBe(`a\u0000b\u0000state.zones`)
})

test('adding twice is adding once, because the button may be pressed twice', () => {
    const one = withNode([], node('plant', 'line1', 'state', 'zones'))
    expect(one).toHaveLength(1)
    expect(withNode(one, node('plant', 'line1', 'state', 'zones'))).toHaveLength(1)
    // A different path on the same component is a different node, not the same one.
    expect(withNode(one, node('plant', 'line1', 'state', 'motors'))).toHaveLength(2)
    expect(holds(one, node('plant', 'line1', 'state', 'zones'))).toBe(true)
    expect(holds(one, node('depot', 'line1', 'state', 'zones'))).toBe(false)
})

test('the order is the reader\'s, and a move off the end is no move', () => {
    const watch: Watch = [node('a', 'n', 'x'), node('b', 'n', 'y'), node('c', 'n', 'z')]
    expect(movedNode(watch, watchKey(node('c', 'n', 'z')), -1).map((one) => one.peer)).toEqual(['a', 'c', 'b'])
    // Not a wrap: a reader pressing up on the top entry means nothing happened, and a list whose
    // first row jumps to the bottom is a list they now have to put back.
    expect(movedNode(watch, watchKey(node('a', 'n', 'x')), -1)).toBe(watch)
    expect(movedNode(watch, watchKey(node('c', 'n', 'z')), 1)).toBe(watch)
    expect(movedNode(watch, 'nothing of that name', 1)).toBe(watch)
})

test('removing names the key rather than the node, which is what a row has', () => {
    const watch = [node('a', 'n', 'x'), node('b', 'n', 'y')]
    expect(withoutNode(watch, watchKey(node('a', 'n', 'x'))).map((one) => one.peer)).toEqual(['b'])
})

test('a stored view keeps what it can still read and drops the rest', () => {
    // One node written by an older version does not cost a reader the other three, which is the
    // moment they would least like to lose them.
    const stored = [node('a', 'n', 'x'), { peer: 'b' }, null, { peer: 'c', namespace: 'n', path: ['ok'] }, { peer: 'd', namespace: 'n', path: [7] }]
    expect(asWatch(stored).map((one) => one.peer)).toEqual(['a', 'c'])
    expect(asWatch(null)).toEqual([])
    expect(asWatch('[]')).toEqual([])
})

test('one channel per component, however many nodes were chosen from it', () => {
    const watch: Watch = [node('plant', 'line1', 'state', 'zones'), node('depot', 'stock', 'state'), node('plant', 'line1', 'state', 'motors'), node('plant', 'line2', 'state')]
    const channels = channelsFor(watch)
    // Four nodes, three subscriptions. Without this a view would cost one channel per entry, and
    // adding to it - the whole appeal - would be what made it expensive.
    expect(channels).toHaveLength(3)
    expect(channels[0]).toMatchObject({ peer: 'plant', namespace: 'line1' })
    expect(channels[0].nodes).toHaveLength(2)
    // First appearance, so a view somebody arranged does not come back sorted by peer name.
    expect(channels.map((one) => `${one.peer}.${one.namespace}`)).toEqual(['plant.line1', 'depot.stock', 'plant.line2'])
})

const component: DescribedComponent = {
    state: {
        kind: 'object',
        fields: {
            zones: { type: { kind: 'object', fields: { top: { type: { kind: 'object', fields: { setpoint: { type: { kind: 'number' } }, actual: { type: { kind: 'number' } } } } } } } },
            motors: { type: { kind: 'object', fields: { one: { type: { kind: 'number' } } } } },
            tags: { type: { kind: 'record', values: { kind: 'number' } } }
        }
    }
} as unknown as DescribedComponent

test('a channel asks for the leaves under what was chosen, and not for the whole component', () => {
    const paths = watchProjection([node('p', 'n', 'state', 'zones')], component)
    // Narrowed on purpose, where the component panel asks for everything: a view borrowing one
    // number from a machine carrying three hundred tags must not subscribe to three hundred.
    expect(paths.map((path) => path.join('.'))).toEqual(['state.zones.top.setpoint', 'state.zones.top.actual'])
})

test('overlapping choices ask once, and a collection asks for nothing', () => {
    const paths = watchProjection([node('p', 'n', 'state', 'zones'), node('p', 'n', 'state')], component)
    // `state` contains `state.zones`, so a reader who added both would otherwise have every zone
    // leaf named twice in one projection.
    expect(paths.map((path) => path.join('.'))).toEqual(['state.zones.top.setpoint', 'state.zones.top.actual', 'state.motors.one'])
    // `state.tags` is a record: its keys are data, its rows are fetched by asking, and no
    // subscription can name them. So it contributes nothing rather than contributing a guess.
    expect(watchProjection([node('p', 'n', 'state', 'tags')], component)).toEqual([])
})

/**
 * What the whole network reads as, when a reader asks to see all of it.
 *
 * This is the derivation that used to be refused, on the grounds that a federation is too big for
 * one list. What made that wrong is that the list is *headings*: the expensive part was holding a
 * channel per section, and that is now paid only for what somebody opens. So what is left to get
 * right is which headings there are.
 */

const description = (namespaces: unknown[]): ServerDescription => ({ name: 'p', namespaces, types: {} }) as unknown as ServerDescription
const observable = (name: string) => ({
    name,
    component: { state: { kind: 'object', fields: { zones: { type: { kind: 'object', fields: { top: { type: { kind: 'number' } } } } } } } },
    methods: [],
    events: []
})
const service = (name: string) => ({ name, methods: [], events: [] })

test('every scope of every observable namespace, of every peer described', () => {
    const known = { devserver: description([observable('plant'), service('msgrpc')]), depot: description([observable('stock')]) }
    expect(everythingIn(known).map((node) => `${node.peer}/${node.namespace}/${node.path.join('.')}`)).toEqual(['devserver/plant/state', 'depot/stock/state'])
})

test('a peer serving only services contributes no headings, rather than an empty one', () => {
    // An empty section under a peer's name would claim it has something to show and that it is
    // empty, which are two different things and only one of them is true.
    expect(everythingIn({ gateway: description([service('msgrpc')]) })).toEqual([])
})

test('nothing described is nothing listed, which is what tells "still asking" from "nothing there"', () => {
    expect(everythingIn({})).toEqual([])
})

test('roots only, because the way into a tree is to open it', () => {
    // Not every node of every scope tree: a list of everything is for finding out what is there, and
    // the depth is already inside the pane that opens.
    const nodes = everythingIn({ p: description([observable('plant')]) })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].path).toEqual(['state'])
})

test('one peer at a time is the same derivation, which is what the console draws grouped', () => {
    // The console lists peers and describes one when it is opened, so the per-peer form is the one
    // it actually uses; the flat form is what a CLI printing the network would want.
    const one = description([observable('plant'), service('msgrpc')])
    expect(scopesIn('devserver', one).map((node) => `${node.namespace}/${node.path.join('.')}`)).toEqual(['plant/state'])
    expect(everythingIn({ devserver: one })).toEqual(scopesIn('devserver', one))
})
