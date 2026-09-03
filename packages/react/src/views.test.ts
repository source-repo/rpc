import { expect, test } from 'vitest'
import { asView, channelsFor, holds, movedNode, viewKey, viewProjection, withNode, withoutNode, type View } from './views.js'
import type { DescribedComponent } from './types.js'

const node = (peer: string, namespace: string, ...path: string[]) => ({ peer, namespace, path })

test('a key cannot be forged by spelling one part cleverly', () => {
    // The separator is why. A peer called `a.b` and a namespace called `c` must not key the same as
    // a peer called `a` and a namespace called `b.c`, and with a dot between them they would.
    expect(viewKey(node('a.b', 'c', 'state'))).not.toBe(viewKey(node('a', 'b.c', 'state')))
    expect(viewKey(node('a', 'b', 'state', 'zones'))).toBe(`a\u0000b\u0000state.zones`)
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
    const view: View = [node('a', 'n', 'x'), node('b', 'n', 'y'), node('c', 'n', 'z')]
    expect(movedNode(view, viewKey(node('c', 'n', 'z')), -1).map((one) => one.peer)).toEqual(['a', 'c', 'b'])
    // Not a wrap: a reader pressing up on the top entry means nothing happened, and a list whose
    // first row jumps to the bottom is a list they now have to put back.
    expect(movedNode(view, viewKey(node('a', 'n', 'x')), -1)).toBe(view)
    expect(movedNode(view, viewKey(node('c', 'n', 'z')), 1)).toBe(view)
    expect(movedNode(view, 'nothing of that name', 1)).toBe(view)
})

test('removing names the key rather than the node, which is what a row has', () => {
    const view = [node('a', 'n', 'x'), node('b', 'n', 'y')]
    expect(withoutNode(view, viewKey(node('a', 'n', 'x'))).map((one) => one.peer)).toEqual(['b'])
})

test('a stored view keeps what it can still read and drops the rest', () => {
    // One node written by an older version does not cost a reader the other three, which is the
    // moment they would least like to lose them.
    const stored = [node('a', 'n', 'x'), { peer: 'b' }, null, { peer: 'c', namespace: 'n', path: ['ok'] }, { peer: 'd', namespace: 'n', path: [7] }]
    expect(asView(stored).map((one) => one.peer)).toEqual(['a', 'c'])
    expect(asView(null)).toEqual([])
    expect(asView('[]')).toEqual([])
})

test('one channel per component, however many nodes were chosen from it', () => {
    const view: View = [node('plant', 'line1', 'state', 'zones'), node('depot', 'stock', 'state'), node('plant', 'line1', 'state', 'motors'), node('plant', 'line2', 'state')]
    const channels = channelsFor(view)
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
    const paths = viewProjection([node('p', 'n', 'state', 'zones')], component)
    // Narrowed on purpose, where the component panel asks for everything: a view borrowing one
    // number from a machine carrying three hundred tags must not subscribe to three hundred.
    expect(paths.map((path) => path.join('.'))).toEqual(['state.zones.top.setpoint', 'state.zones.top.actual'])
})

test('overlapping choices ask once, and a collection asks for nothing', () => {
    const paths = viewProjection([node('p', 'n', 'state', 'zones'), node('p', 'n', 'state')], component)
    // `state` contains `state.zones`, so a reader who added both would otherwise have every zone
    // leaf named twice in one projection.
    expect(paths.map((path) => path.join('.'))).toEqual(['state.zones.top.setpoint', 'state.zones.top.actual', 'state.motors.one'])
    // `state.tags` is a record: its keys are data, its rows are fetched by asking, and no
    // subscription can name them. So it contributes nothing rather than contributing a guess.
    expect(viewProjection([node('p', 'n', 'state', 'tags')], component)).toEqual([])
})
