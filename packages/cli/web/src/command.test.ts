import { afterEach, expect, test } from 'vitest'
import { webcrypto } from 'node:crypto'
import { mint } from './command'

/**
 * That a command can be given a key at the address the console is actually served from.
 *
 * `crypto.randomUUID` is **secure-context only**: present on `http://localhost`, which browsers
 * treat as trustworthy, and absent on `http://plant-console:7844`, which is the same console over
 * the same plain HTTP at an address an operator can reach from their desk. A console that mints keys
 * only in the first case has command buttons that throw before the call is made - and the throw
 * lands before anything that draws a failure, so the button does nothing at all, silently.
 *
 * That is why this test replaces `crypto` rather than trusting the one the test runner has: Node's
 * has `randomUUID`, so the interesting half of `mint` would otherwise never run here and the bug
 * would return the moment somebody simplified the function back.
 */

const real = globalThis.crypto

/** What the runtime looks like outside a secure context: `getRandomValues`, and no `randomUUID`. */
const withoutRandomUUID = () =>
    Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: (array: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(array) },
        configurable: true
    })

afterEach(() => Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true }))

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('mints a key where randomUUID exists', () => {
    expect(mint()).toMatch(uuidV4)
})

test('mints a key where it does not - the plain-HTTP address the console is served from', () => {
    withoutRandomUUID()
    expect(globalThis.crypto.randomUUID).toBeUndefined()
    expect(mint()).toMatch(uuidV4)
})

/**
 * Distinct, because the key is the whole mechanism: two presses sharing one would be read by the far
 * end as one command attempted twice, and the second pump start would never happen.
 */
test('a key per press, not a key per page', () => {
    withoutRandomUUID()
    const keys = new Set(Array.from({ length: 500 }, () => mint()))
    expect(keys.size).toBe(500)
})
