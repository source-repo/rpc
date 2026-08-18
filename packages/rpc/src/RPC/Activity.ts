import type { RpcActivitySignal } from './ComponentClient.js'

/**
 * The browser's answer to "is anyone looking at this": `document.visibilityState`.
 *
 * Exported from the web entry point only, because the library also runs in Node and the interface
 * it satisfies is deliberately injectable - a kiosk, a screensaver or an application that knows its
 * own pane is closed can supply something better than the document can.
 *
 * Note what the browser calls hidden. A locked screen and a screensaver both fire
 * `visibilitychange`, which is right for a laptop on a desk and wrong for the wall panel this
 * option is most often reached for - which is the concrete reason the signal is a parameter rather
 * than a rule, and the reason to leave it unset on a display nobody is going to touch.
 */
export const visibilityActivity = (): RpcActivitySignal => {
    const listeners = new Set<(active: boolean) => void>()
    const visible = () => globalThis.document?.visibilityState !== 'hidden'
    const onChange = () => {
        const active = visible()
        for (const listener of [...listeners]) listener(active)
    }
    return {
        get active() {
            return visible()
        },
        subscribe: (onActive) => {
            if (listeners.size === 0) globalThis.document?.addEventListener('visibilitychange', onChange)
            listeners.add(onActive)
            return () => {
                listeners.delete(onActive)
                if (listeners.size === 0) globalThis.document?.removeEventListener('visibilitychange', onChange)
            }
        }
    }
}
