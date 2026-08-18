import type { RpcPersistedSnapshot, RpcSnapshotStore } from './Snapshots.js'

/**
 * `localStorage`, for a page that must come back with its values after a browser restart or a power
 * cut - a kiosk, a wall panel, an HMI on a machine that is switched off at night.
 *
 * **Plant values are then at rest, unencrypted, for whatever opens that origin next.** That is the
 * trade being made, and it is why `scope` has no default: the scope is what keeps one operator's
 * screen from being drawn for another, and it has to change when the identity behind it does. Clear
 * it on logout and on a tenant or site switch.
 *
 * `sessionStorage` is the narrower alternative and is the same adapter over
 * `globalThis.sessionStorage`: per tab, per profile, surviving a reload but not a restart. Prefer it
 * wherever the restart is not the case being solved.
 *
 * A quota failure is swallowed rather than escaping into the receive loop. A page that cannot cache
 * is a page that draws a blank on reload; it is not a page that stops working.
 */
export const localStorageSnapshots = (): RpcSnapshotStore => ({
    read: (key) => {
        try {
            const held = globalThis.localStorage?.getItem(key)
            // Unparseable is indistinguishable from absent, and both mean "draw nothing yet".
            return Promise.resolve(held ? (JSON.parse(held) as RpcPersistedSnapshot) : undefined)
        } catch {
            return Promise.resolve(undefined)
        }
    },
    write: (key, snapshot) => {
        try {
            globalThis.localStorage?.setItem(key, JSON.stringify(snapshot))
        } catch {
            // Quota, private browsing, a disabled origin. None of them are this channel's failure.
        }
        return Promise.resolve()
    },
    remove: (key) => {
        try {
            globalThis.localStorage?.removeItem(key)
        } catch {
            // As above.
        }
        return Promise.resolve()
    }
})
