import { expect, test } from 'vitest'
import { navigable } from './navigable'

/**
 * The gate on addresses that arrive from a peer.
 *
 * This is a security check rather than a formatting one, which is why it is a module of its own with
 * tests of its own: the console renders what peers publish, and an `href` is the one field where
 * publishing a string is publishing behaviour. A `javascript:` address in an anchor runs in *this*
 * origin the moment somebody clicks it - and this page holds a live link to the whole network.
 *
 * The cases below are the ones a `startsWith('http')` test gets wrong, and they are the reason the
 * implementation parses instead.
 */

test('an ordinary http or https address is handed over unchanged', () => {
    expect(navigable('https://example.com/guide/components')).toBe('https://example.com/guide/components')
    expect(navigable('http://plant-gateway:8080/config')).toBe('http://plant-gateway:8080/config')
})

test('a script address is refused, however it is spelled', () => {
    expect(navigable('javascript:alert(1)')).toBeUndefined()
    // Case is not part of a scheme, so a test that compares text has to remember that and this does not.
    expect(navigable('JavaScript:alert(1)')).toBeUndefined()
    expect(navigable('JAVASCRIPT:alert(1)')).toBeUndefined()
    // The URL parser strips leading whitespace and inner tabs and newlines before reading the
    // scheme, which is exactly the trick a prefix test misses and a browser does not.
    expect(navigable('  javascript:alert(1)')).toBeUndefined()
    expect(navigable('java\nscript:alert(1)')).toBeUndefined()
    expect(navigable('java\tscript:alert(1)')).toBeUndefined()
})

test('the other schemes that carry content or reach the reader’s machine are refused', () => {
    expect(navigable('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(navigable('blob:https://example.com/1234')).toBeUndefined()
    expect(navigable('file:///etc/passwd')).toBeUndefined()
    expect(navigable('vbscript:msgbox(1)')).toBeUndefined()
})

test('an address for a system a browser cannot open is not a link, and that is the common case', () => {
    // What an OPC UA binding actually carries. It stays text beside the binding, which is right:
    // somebody pastes it into the tool that understands it.
    expect(navigable('opc.tcp://plant-server:4840')).toBeUndefined()
    expect(navigable('mqtt://bus:1883')).toBeUndefined()
    expect(navigable('ssh://gateway')).toBeUndefined()
})

test('a relative address is refused rather than resolved against this origin', () => {
    // The console's own origin is the one origin a binding never means, so resolving against it
    // would turn a malformed endpoint into a link pointing back at the console.
    expect(navigable('/admin')).toBeUndefined()
    expect(navigable('config/index.html')).toBeUndefined()
    expect(navigable('//example.com/x')).toBeUndefined()
})

test('nothing at all is nothing, rather than an error', () => {
    expect(navigable(undefined)).toBeUndefined()
    expect(navigable('')).toBeUndefined()
    expect(navigable('   ')).toBeUndefined()
    expect(navigable('not a url')).toBeUndefined()
})
