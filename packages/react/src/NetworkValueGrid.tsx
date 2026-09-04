import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { RpcDataCache, networkScopeFromKey, type NetworkRpcDataProvider, type NetworkScopeRef, type RpcDataAnswer, type RpcQuestion } from '@source-repo/query'
import type { DescribedAction, DescribedComponent } from './types.js'
import { ValueGrid } from './ValueGrid.js'
import { networkMethodSelectionFromRowKey, type NetworkMethodSelection } from './network-method.js'

/**
 * The existing scope-tree/leaf-grid arrangement, pointed at the local network resource adapter.
 *
 * There is intentionally no second network viewer here. `ValueGrid` already owns the arrangement:
 * a provider tree scopes a paged leaf table, and an optional record panel opens the selected row.
 * This component supplies only the synthetic component declaration and question addresses needed
 * to let that view ask a client-side `NetworkRpcDataProvider`.
 */

const networkComponent = (columns: readonly string[]): DescribedComponent => ({
    subscribers: 0,
    resources: [
        {
            path: ['network'],
            verbs: ['getChildren', 'getList', 'getOne'],
            shape: 'tree',
            label: 'Network',
            row: {
                kind: 'object',
                fields: {
                    peer: { type: { kind: 'string' } },
                    namespace: { type: { kind: 'string' } },
                    resource: { type: { kind: 'string' } },
                    id: { type: { kind: 'string' } },
                    value: { type: { kind: 'any' } }
                },
                additional: true
            },
            presentation: { defaultColumns: [...columns], representation: 'name' }
        }
    ]
})

const question = (method: RpcQuestion['method'], params: RpcQuestion['params']): RpcQuestion => ({
    // Local-only addresses. The cache calls the adapter below rather than putting these on a link.
    target: '$network-view',
    namespace: '$network-view',
    method,
    resource: ['network'],
    params
})

const CALL_METHOD: DescribedAction = { method: 'call', label: 'call', kinds: ['rpc.method'] }

export const NetworkValueGrid = ({
    provider,
    period,
    pageSize = 50,
    onScope,
    onCallMethod
}: {
    provider: NetworkRpcDataProvider
    period?: number
    pageSize?: number
    /** Structural selection for console chrome; resource data remains owned by this grid. */
    onScope?: (scope: NetworkScopeRef) => void
    /** Open the host's call form for a method-description row. */
    onCallMethod?: (method: NetworkMethodSelection) => void
}) => {
    const current = useRef(provider)
    current.current = provider
    const cache = useMemo(
        () =>
            new RpcDataCache({
                ask: async ({ method, resource, params }) => (await current.current.dataRequest(method, resource, params ?? {})) as RpcDataAnswer
            }),
        []
    )
    const [preview, setPreview] = useState(true)
    const [size, setSize] = useState(pageSize)
    const status = useSyncExternalStore(provider.subscribe, provider.getStatus, provider.getStatus)
    const component = useMemo(() => networkComponent(status.columns), [status.columns])

    useEffect(() => {
        // A newly learnt description changes the local catalogue without changing any synthetic
        // question address. Mark active questions so the already-open tree grows in place.
        void cache.queryClient.invalidateQueries({ refetchType: 'active' })
    }, [cache, provider])
    useEffect(() => () => cache.close(), [cache])

    return (
        <div className="network-value-grid">
            {status.settled && status.partial && (
                <div className="network-result-notice" role="status">
                    <strong>Incomplete network result</strong>
                    <span>
                        {status.rows} rows from {status.asked} source{status.asked === 1 ? '' : 's'}
                        {status.hasMore ? ' · the bounded result has more rows' : ''}
                        {status.refused.length ? ` · ${status.refused.length} source${status.refused.length === 1 ? '' : 's'} refused` : ''}
                    </span>
                    {status.refused.length > 0 && (
                        <details>
                            <summary>show refusals</summary>
                            <ul>
                                {status.refused.map(({ source: refused, reason }) => (
                                    <li key={`${refused.peer}\u0000${refused.namespace}\u0000${refused.resource.join('\u0000')}`}>
                                        <span className="mono">
                                            {refused.peer}/{refused.namespace}/{refused.resource.join('.')}
                                        </span>{' '}
                                        — {reason}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
            <ValueGrid
                component={component}
                scope={['network']}
                cache={cache}
                period={period}
                preview={preview}
                onPreview={setPreview}
                pageSize={size}
                onPageSize={setSize}
                onScope={(id) => onScope?.(id === undefined ? { kind: 'network' } : (networkScopeFromKey(id) ?? { kind: 'network' }))}
                branchQuestion={(_resource, parentId, page, branchSize) => question('getChildren', { ...(parentId !== undefined ? { parentId } : {}), pagination: { page, pageSize: branchSize } })}
                scopedQuestion={(_resource, under, page, rowPageSize, filter, sort) =>
                    question('getList', { ...(under !== undefined ? { under } : {}), recursive: true, pagination: { page, pageSize: rowPageSize }, ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) })
                }
                rowQuestion={(_resource, id) => question('getOne', { id })}
                manyQuestion={(_resource, ids) => question('getMany', { ids })}
                actionsFor={() => (onCallMethod ? [CALL_METHOD] : undefined)}
                onAction={(_action, id) => {
                    const method = networkMethodSelectionFromRowKey(id)
                    if (method) onCallMethod?.(method)
                }}
            />
        </div>
    )
}
