import { describe, expect, it } from 'vitest'
import { hitAddress, searchable, searchFilter } from './searching'
import type { ServerDescription } from './types'

const described = {
    name: 'devserver',
    namespaces: [
        {
            name: 'shop',
            component: {
                subscribers: 0,
                resources: [
                    { path: ['customers'], verbs: ['getList', 'getMany'], presentation: { representation: 'name' } },
                    // Serves a list, but nobody said what names a row - so there is nothing to match
                    // against and nothing to show for what was found.
                    { path: ['orders'], verbs: ['getList', 'getMany'] }
                ]
            }
        },
        {
            name: 'handbook',
            component: {
                subscribers: 0,
                // A tree browsed a branch at a time. `getChildren` takes no filter, so there is no
                // way to ask it a question about all of it.
                resources: [{ path: ['by-folder'], verbs: ['getChildren'], presentation: { representation: 'title' } }]
            }
        },
        { name: 'msgrpc', component: undefined }
    ]
} as unknown as ServerDescription

describe('which resources a search can ask', () => {
    it('needs a verb that takes a filter and a field to match', () => {
        expect(searchable(described).map((one) => `${one.namespace}.${one.resource.path.join('.')}:${one.representation}`)).toEqual(['shop.customers:name'])
    })

    it('has nothing to ask before a peer has been described', () => {
        expect(searchable(undefined)).toEqual([])
    })
})

describe('what a search asks', () => {
    it('asks one clause, against the field the resource nominated', () => {
        // Not a sweep across every field: an object-valued field does not match a string in any
        // meaningful sense, and asking a SQL node to scan every column of every table is a query
        // nobody sized, issued by a search box.
        expect(searchFilter('acme', 'name')).toEqual({ field: 'name', op: 'contains', operand: 'acme' })
    })

    it('asks nothing at all for nothing typed', () => {
        expect(searchFilter('', 'name')).toBeUndefined()
        expect(searchFilter('   ', 'name')).toBeUndefined()
        expect(searchFilter('  acme ', 'name')).toEqual({ field: 'name', op: 'contains', operand: 'acme' })
    })
})

describe('where a hit is', () => {
    it('resolves to the address the observer already reads, carrying the resource it came from', () => {
        expect(hitAddress('dev server', 'shop', ['customers'])).toBe('?observe=dev%20server&ns=shop&scope=customers')
    })
})
