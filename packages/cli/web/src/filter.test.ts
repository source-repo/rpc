import { describe, expect, it } from 'vitest'
import { compileFilter } from './filter'

/**
 * The search box, which is the only part of the query grammar an operator ever touches.
 *
 * Every case here asserts the *shape* that goes on the wire, because the one property worth
 * protecting is that it stays data. The provider this grammar came from compiled the same text into
 * a regular expression and sent that to be run; if this file ever starts asserting a pattern instead
 * of a condition, that is what has happened.
 */

describe('compileFilter', () => {
    it('searches the tag name for a bare word', () => {
        expect(compileFilter('setp')).toEqual({ field: 'id', op: 'contains', operand: 'setp' })
    })

    it('names a field with a colon, which is the query a plant screen is for', () => {
        expect(compileFilter('quality:bad')).toEqual({ field: 'quality', op: 'contains', operand: 'bad' })
    })

    it('reads & as and, and | as or', () => {
        expect(compileFilter('a & b')).toEqual({ all: [{ field: 'id', op: 'contains', operand: 'a' }, { field: 'id', op: 'contains', operand: 'b' }] })
        expect(compileFilter('a | b')).toEqual({ any: [{ field: 'id', op: 'contains', operand: 'a' }, { field: 'id', op: 'contains', operand: 'b' }] })
    })

    it('binds or tighter than and, which is what a list beside a qualifier means', () => {
        // `a | b & quality:bad` is "either a or b, and bad" - not "a, or b-and-bad". The provider
        // this came from read it the same way, and an operator typing alternatives expects it.
        expect(compileFilter('a | b & quality:bad')).toEqual({
            all: [
                { any: [{ field: 'id', op: 'contains', operand: 'a' }, { field: 'id', op: 'contains', operand: 'b' }] },
                { field: 'quality', op: 'contains', operand: 'bad' }
            ]
        })
    })

    it('treats && and || as the same operators, since both get typed', () => {
        expect(compileFilter('a && b')).toEqual(compileFilter('a & b'))
        expect(compileFilter('a || b')).toEqual(compileFilter('a | b'))
    })

    it('asks for nothing when nothing was typed', () => {
        // Not an empty filter, which would be a query matching everything dressed as a narrowing.
        for (const nothing of ['', '   ', '&', ' | & ']) expect(compileFilter(nothing)).toBeUndefined()
    })

    it('narrows rather than widens while it is still being typed', () => {
        // `quality:` mid-keystroke must not become "every row whose quality contains the empty
        // string", which is all of them - a half-typed query that widens to everything is the one
        // behaviour a slow link cannot afford.
        expect(compileFilter('quality:')).toEqual({ field: 'id', op: 'contains', operand: 'quality' })
    })

    it('compiles to a comparison and never to something that runs', () => {
        // The assertion this file exists for. A regular expression here would be a program sent to
        // a machine with a plant attached to it.
        const compiled = JSON.stringify(compileFilter('a.* | (b)[0-9]+ & quality:bad'))
        expect(compiled).toContain('"op":"contains"')
        expect(compiled).not.toContain('pattern')
        expect(compiled).not.toContain('regex')
    })
})
