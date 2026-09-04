import { describe, expect, it } from 'vitest'
import type { RpcGetManyResult, RpcGetOneResult } from '@source-repo/rpc'
import { rowFromAnswer, rowReadMethod } from './row-preview.js'

describe('generic row preview', () => {
    it('prefers richer getOne detail and falls back to getMany for an ordinary table', () => {
        expect(rowReadMethod({ verbs: ['getList', 'getMany', 'getOne'] })).toBe('getOne')
        expect(rowReadMethod({ verbs: ['getList', 'getMany', 'getManyReference'] })).toBe('getMany')
        expect(rowReadMethod({ verbs: ['getList'] })).toBeUndefined()
    })

    it('unwraps the selected id from a positional getMany answer', () => {
        const many: RpcGetManyResult = { ids: ['3', '1'], data: [{ name: 'Cyberdyne' }, { name: 'Acme' }], epoch: 'e', revision: 1 }
        expect(rowFromAnswer(many, '1')).toEqual({ name: 'Acme' })
        expect(rowFromAnswer(many, '2')).toBeUndefined()

        const one: RpcGetOneResult = { data: { name: 'Borg' }, epoch: 'e', revision: 1 }
        expect(rowFromAnswer(one, '2')).toEqual({ name: 'Borg' })
    })
})
