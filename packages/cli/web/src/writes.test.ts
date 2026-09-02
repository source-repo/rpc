import { describe, expect, it } from 'vitest'
import { canUpdate, editableFields, writableFor, writeNamespace } from './writes'
import type { RpcWritableResource } from '@source-repo/rpc'
import { isOptional, requiredPart, type TypeNode } from './types'

const customers: RpcWritableResource = {
    resource: 'customers',
    verbs: ['update'],
    columns: ['name', 'city', 'notes'],
    row: { kind: 'object', fields: {} }
}

describe('finding the write half', () => {
    it('follows the convention rather than discovering it', () => {
        // Nothing in describe() links a read component to its write component. The name beside it
        // is the link, and MCP already tells callers so in its own refusal text.
        expect(writeNamespace('shop')).toBe('shop.write')
    })

    it('matches a resource by the single name a write surface knows it as', () => {
        expect(writableFor([customers], ['customers'])?.resource).toBe('customers')
        expect(writableFor([customers], ['other'])).toBeUndefined()
        // A deeper path matches nothing rather than being flattened into a name that might be a
        // different resource's.
        expect(writableFor([customers], ['shop', 'customers'])).toBeUndefined()
        expect(writableFor(undefined, ['customers'])).toBeUndefined()
    })
})

describe('which fields an edit form offers', () => {
    it('offers everything writable where the resource gave no advice', () => {
        expect(editableFields(customers)).toEqual(['name', 'city', 'notes'])
    })

    it('lets advice order and narrow', () => {
        expect(editableFields(customers, ['city', 'name'])).toEqual(['city', 'name'])
    })

    it('never lets advice widen, because that would be a hint deciding authority', () => {
        // `writable()` is the write rules resolved against the store. A presentation hint naming a
        // column it did not resolve cannot make that column writable, and must not look as if it
        // did: the peer would refuse the write, after somebody had typed into the field.
        expect(editableFields(customers, ['name', 'balance', 'id'])).toEqual(['name'])
    })

    it('knows when there is nothing to offer', () => {
        expect(canUpdate(customers)).toBe(true)
        expect(canUpdate(customers, ['balance'])).toBe(false)
        expect(canUpdate({ ...customers, verbs: ['delete'] })).toBe(false)
        expect(canUpdate(undefined)).toBe(false)
    })
})

describe('a value that may be null', () => {
    // Two spellings, both legitimate: the extractor writes an optional parameter as a union with a
    // null *literal*, and a provider building a type at runtime writes `{ kind: 'null' }` - which is
    // what a nullable SQL column comes back as. A viewer knowing one of them draws the other's union
    // whole, which falls through every widget to the JSON textarea.
    const literal: TypeNode = { kind: 'union', options: [{ kind: 'string' }, { kind: 'literal', value: null }] }
    const bare: TypeNode = { kind: 'union', options: [{ kind: 'string' }, { kind: 'null' }] }

    it('is recognised in either spelling', () => {
        expect(isOptional(literal)).toBe(true)
        expect(isOptional(bare)).toBe(true)
        expect(isOptional({ kind: 'union', options: [{ kind: 'string' }, { kind: 'number' }] })).toBe(false)
    })

    it('leaves the widget the type it is really about', () => {
        expect(requiredPart(literal)).toEqual({ kind: 'string' })
        expect(requiredPart(bare)).toEqual({ kind: 'string' })
    })
})
