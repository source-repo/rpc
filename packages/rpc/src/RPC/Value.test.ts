import test from 'ava'
import { argumentsRefusal, valueRefusal } from './Value.js'

/**
 * What may cross a boundary, checked the same way wherever the boundary is.
 *
 * The tests that matter are the three silent ones. A function throws at a worker boundary and is
 * therefore not the dangerous case; a class instance, a shared buffer and a cycle all *succeed* at
 * one placement and fail or change meaning at another, which is how a component comes to work until
 * somebody moves it.
 */

test('an ordinary message crosses, and nothing about it is refused', (t) => {
    t.is(valueRefusal({ target: 300, mode: 'heating', zones: [{ id: 'top', on: true }], note: null, absent: undefined }), undefined)
    t.is(valueRefusal([1, 'two', false, null]), undefined)
    t.is(valueRefusal('a string'), undefined)
    t.is(valueRefusal(undefined), undefined, 'an argument that was not given is not a value that cannot cross')
})

test('a class instance is refused, because it would arrive looking right with no methods', (t) => {
    class Setpoint {
        constructor(readonly celsius: number) {}
        clamp() {
            return Math.min(this.celsius, 300)
        }
    }

    const refusal = valueRefusal({ setpoint: new Setpoint(420) }, { at: 'bake argument 0' })
    t.is(refusal?.path, 'bake argument 0.setpoint')
    t.regex(refusal?.why ?? '', /looks right and has no methods/)
    t.regex(refusal?.why ?? '', /Setpoint/, 'and it says which class, because that is what a reader has to go and find')
})

test('a shared buffer is refused: it crosses by reference, which is a different kind of thing', (t) => {
    const shared = new SharedArrayBuffer(8)

    const refusal = valueRefusal({ gate: shared })
    t.regex(refusal?.why ?? '', /crosses by reference rather than by copy/)

    t.is(valueRefusal({ gate: shared }, { allowSharedMemory: true }), undefined, 'unless somebody said so out loud')
})

test('a cycle is refused, because a worker would take it and a codec would not', (t) => {
    const cyclic: Record<string, unknown> = { name: 'oven' }
    cyclic.self = cyclic

    t.regex(valueRefusal(cyclic)?.why ?? '', /contains itself/)
})

test('the same value appearing twice is not a cycle, and is not refused', (t) => {
    const shared = { id: 'top' }
    // Two copies arrive on the other side, which is true at every placement. Refusing this would
    // refuse a perfectly ordinary message for looking momentarily like a dangerous one.
    t.is(valueRefusal({ first: shared, second: shared }), undefined)
})

test('a Date is refused although a worker would carry it, and the reason is the point', (t) => {
    // The narrowest boundary decides. A worker carries a Date; a codec turns it into a string; so a
    // component that accepted one would work until the day somebody moved it to another host.
    t.regex(valueRefusal({ at: new Date() })?.why ?? '', /only a plain object crosses as itself/)
    t.regex(valueRefusal({ seen: new Map() })?.why ?? '', /Map/)
    t.regex(valueRefusal({ seen: new Set() })?.why ?? '', /Set/)
})

test('a bigint is refused, and told what this library sends instead', (t) => {
    const refusal = valueRefusal({ position: 9007199254740993n })
    t.regex(refusal?.why ?? '', /decimal string/)
    t.regex(refusal?.why ?? '', /this library's own positions do/, 'the convention already exists and the message points at it')
})

test('binary crosses, because the frame codec carries it either way', (t) => {
    t.is(valueRefusal({ payload: new Uint8Array([1, 2, 3]) }), undefined)
    t.is(valueRefusal({ payload: new ArrayBuffer(8) }), undefined)
})

test('a function and a symbol are refused for what they are rather than what they lack', (t) => {
    t.regex(valueRefusal({ done: () => undefined })?.why ?? '', /closes over a scope that exists only where it was written/)
    t.regex(valueRefusal({ tag: Symbol('oven') })?.why ?? '', /an identity rather than a value/)
})

test('the first refusal is the answer, not a list of forty paths nobody reads', (t) => {
    const refusal = valueRefusal({ a: () => undefined, b: () => undefined, c: () => undefined })
    t.is(refusal?.path, 'this value.a')
})

test('a value nested past the bound is refused rather than walked forever', (t) => {
    let deep: Record<string, unknown> = { bottom: true }
    for (let level = 0; level < 40; level++) deep = { deep }

    t.regex(valueRefusal(deep)?.why ?? '', /nested more than 32 deep/)
    t.is(valueRefusal(deep, { maxDepth: 64 }), undefined, 'and the bound is the caller’s to set')
})

test('arguments are named the way a caller will recognise them', (t) => {
    const refusal = argumentsRefusal('bake', [300, { schedule: new Date() }])
    t.is(refusal?.path, 'bake argument 1.schedule')
})
