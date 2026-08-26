import test from 'ava'
import { canonicalText, canonicalValue } from './RPC/Canonical.js'

/**
 * The encoder three things share, tested for the properties each of them relies on.
 *
 * `DataWrites.test.ts` pins its exact bytes and is the fixture that fails when it moves. What is
 * here is the other half: *why* those bytes are the shape they are, written as the questions the
 * three callers ask - because a change that kept the bytes stable for a row and broke them for a
 * projection would pass over there and be found in a plant.
 */

test('two values written in different key orders are the same value', (t) => {
    t.is(canonicalText({ b: 2, a: 1 }), canonicalText({ a: 1, b: 2 }))
    t.is(canonicalText({ path: ['state', 'tags'], offset: 10 }), canonicalText({ offset: 10, path: ['state', 'tags'] }))
    // One level down, because that is where a driver's round trip actually reorders things.
    t.is(canonicalText({ filter: { field: 'quality', op: 'eq', operand: 'bad' } }), canonicalText({ filter: { op: 'eq', operand: 'bad', field: 'quality' } }))
})

test('an absent option and an explicit undefined are the same question', (t) => {
    // The projection comparison and the cache key both depend on this, and they fail differently:
    // one re-subscribes, spending a targeted snapshot to receive what it already had, and the other
    // misses and asks the plant again for a page it is holding.
    t.is(canonicalText({ path: ['state', 'tags'] }), canonicalText({ path: ['state', 'tags'], offset: undefined, limit: undefined }))
    t.is(canonicalText({}), canonicalText({ filter: undefined }))
    // Not the same as null, which is a value somebody wrote.
    t.not(canonicalText({ filter: undefined }), canonicalText({ filter: null }))
})

test('order inside an array is part of the value', (t) => {
    // A page of rows in a different order is a different page, and a path spelled in a different
    // order names a different place. Sorting here would make both of those invisible.
    t.not(canonicalText(['state', 'tags']), canonicalText(['tags', 'state']))
    t.not(canonicalText([1, 2]), canonicalText([2, 1]))
})

test('a value is tagged by kind, so a type change is a change', (t) => {
    t.not(canonicalText(1), canonicalText('1'))
    t.not(canonicalText(true), canonicalText(1))
    t.not(canonicalText(null), canonicalText(''))
    t.not(canonicalText(new Date(0)), canonicalText(new Date(0).toISOString()))
    t.not(canonicalText([]), canonicalText({}))
})

test('nothing an unexpected shape can be makes this throw', (t) => {
    // It runs inside a precondition and inside a re-subscribe, neither of which has anywhere to put
    // an exception raised by a value that was merely surprising.
    t.notThrows(() => canonicalText(() => undefined))
    t.notThrows(() => canonicalText(Symbol('x')))
    t.notThrows(() => canonicalText(new Map([['a', 1]])))
    t.notThrows(() => canonicalText(NaN))
    // NaN and Infinity survive as themselves rather than becoming JSON's null, which would make a
    // sensor reading no-value and a sensor reading out-of-range the same state.
    t.not(canonicalText(NaN), canonicalText(null))
    t.not(canonicalText(Infinity), canonicalText(-Infinity))
})

test('a class instance is compared by what it is, not walked', (t) => {
    // Same rule the snapshot sharing makes: a prototype of its own means this encoder does not know
    // what the value's identity is made of, and guessing is worse than being coarse.
    t.is(canonicalText(new Uint8Array([1, 2])), canonicalText(new Uint8Array([1, 2])))
    t.not(canonicalText(new Uint8Array([1, 2])), canonicalText([1, 2]))
})

test('the canonical form is JSON-safe, which is what lets it be compared as text', (t) => {
    // Every object in the output is an array, so nothing is left for key order to decide a second
    // time - which is the only reason `JSON.stringify` is safe on the far side of this.
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk)
        t.true(node === null || typeof node !== 'object', `${String(node)} is a bare object in the canonical form`)
    }
    walk(canonicalValue({ a: [1, { b: new Date(0) }], c: 'x' }))
})
