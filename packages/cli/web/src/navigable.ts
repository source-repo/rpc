/**
 * An address a peer supplied, when it is one this page may hand to the browser.
 *
 * `http` and `https`, and nothing else. The scheme is the check that matters: a `javascript:` href
 * runs in *this* origin the moment somebody clicks it, and this page holds a live link to the whole
 * network - so a peer able to publish an address could publish a script and wait. `data:` and
 * `blob:` are refused one step removed from the same thing, and `file:` because a console has no
 * business naming paths on the reader's own machine.
 *
 * Parsed rather than pattern-matched, because a scheme is not a prefix. ` javascript:`, `JavaScript:`
 * and a scheme split by a newline are all things a string test gets wrong and a URL parser does not.
 * Absolute only: a relative address would resolve against this origin, which is the one origin a
 * binding never means.
 */
export const navigable = (address: string | undefined): string | undefined => {
    if (!address) return undefined
    try {
        const url = new URL(address)
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
    } catch {
        return undefined
    }
}
