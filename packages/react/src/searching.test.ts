import { describe, expect, it } from 'vitest'
import { hitAddress, targetsIn } from './searching.js'
import type { ServerDescription } from './types.js'

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
        expect(targetsIn('devserver', described).map((one) => `${one.peer}.${one.namespace}.${one.resource.join('.')}:${one.representation}`)).toEqual([
            'devserver.shop.customers:name'
        ])
    })

    it('carries the peer, because a target is a resource of a *machine*', () => {
        // What makes the fan-out federated rather than one peer's fan-out: the same resource path
        // on two peers is two targets, and a hit has to say which one it came from.
        expect(targetsIn('other', described)[0].peer).toBe('other')
    })

    it('has nothing to ask before a peer has been described', () => {
        expect(targetsIn('devserver', undefined)).toEqual([])
    })
})

describe('where a hit is', () => {
    it('resolves to the address the observer already reads, carrying the resource it came from', () => {
        expect(hitAddress('dev server', 'shop', ['customers'])).toBe('?observe=dev%20server&ns=shop&scope=customers')
    })
})
