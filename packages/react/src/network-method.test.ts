import { describe, expect, it } from 'vitest'
import { networkRowKey } from '@source-repo/query'
import { networkMethodSelectionFromRowKey } from './network-method.js'

describe('network method row actions', () => {
    it('recover the peer, namespace and method from a complete aggregate row identity', () => {
        const key = networkRowKey({ peer: 'cell-7', namespace: '$peer', resource: ['interfaces'], id: JSON.stringify(['oven', 'heat']) })
        expect(networkMethodSelectionFromRowKey(key)).toEqual({ peer: 'cell-7', namespace: 'oven', method: 'heat' })
    })

    it('refuse ordinary resource rows and malformed method identities', () => {
        expect(networkMethodSelectionFromRowKey(networkRowKey({ peer: 'cell-7', namespace: 'oven', resource: ['state'], id: 'temperature' }))).toBeUndefined()
        expect(networkMethodSelectionFromRowKey(networkRowKey({ peer: 'cell-7', namespace: '$peer', resource: ['interfaces'], id: 'heat' }))).toBeUndefined()
    })
})
