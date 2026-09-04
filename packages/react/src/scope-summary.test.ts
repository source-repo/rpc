import { describe, expect, it } from 'vitest'
import { scopeSummaryFields } from './ScopeSummary.js'

describe('scope summary', () => {
    it('keeps every field of a provider-owned branch record', () => {
        expect(scopeSummaryFields({ name: 'oven', className: 'Oven', capabilities: ['plant.Oven'], subscribers: 2 })).toEqual([
            { name: 'name', value: 'oven' },
            { name: 'className', value: 'Oven' },
            { name: 'capabilities', value: ['plant.Oven'] },
            { name: 'subscribers', value: 2 }
        ])
    })

    it('does not invent fields for a primitive branch record', () => {
        expect(scopeSummaryFields('rack A')).toEqual([])
        expect(scopeSummaryFields(null)).toEqual([])
    })
})
