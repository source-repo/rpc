import type { RpcGetManyResult, RpcGetOneResult } from '@source-repo/rpc'
import type { DescribedResource } from './types.js'

/**
 * How the generic preview can read one selected row.
 *
 * `getOne` wins because it may return richer detail than a list row. `getMany` is the honest
 * fallback for resources such as SQL tables whose one-row shape is identical to their page shape;
 * requiring them to publish a redundant `getOne` would make the renderer dictate the contract.
 */
export const rowReadMethod = (resource: Pick<DescribedResource, 'verbs'> | undefined): 'getOne' | 'getMany' | undefined =>
    resource?.verbs.includes('getOne') ? 'getOne' : resource?.verbs.includes('getMany') ? 'getMany' : undefined

/**
 * One row from either detail-capable `getOne` or the ordinary `getMany([id])` fallback.
 *
 * Missing remains missing in both protocols: absent `data` for `getOne`, or an id absent from the
 * positional `getMany` answer.
 */
export const rowFromAnswer = (answer: RpcGetOneResult | RpcGetManyResult | undefined, id: string): unknown => {
    if (!answer) return undefined
    if ('ids' in answer) {
        const at = answer.ids.indexOf(id)
        return at < 0 ? undefined : answer.data[at]
    }
    return answer.data
}
