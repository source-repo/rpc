import { networkRowFromKey } from '@source-repo/query'

export interface NetworkMethodSelection {
    readonly peer: string
    readonly namespace: string
    readonly method: string
}

/** Decode only rows produced by the peer-level Interfaces resource. */
export const networkMethodSelectionFromRowKey = (key: string): NetworkMethodSelection | undefined => {
    const row = networkRowFromKey(key)
    if (!row || row.namespace !== '$peer' || row.resource.length !== 1 || row.resource[0] !== 'interfaces') return undefined
    try {
        const method: unknown = JSON.parse(row.id)
        return Array.isArray(method) && method.length === 2 && typeof method[0] === 'string' && typeof method[1] === 'string'
            ? { peer: row.peer, namespace: method[0], method: method[1] }
            : undefined
    } catch {
        return undefined
    }
}
