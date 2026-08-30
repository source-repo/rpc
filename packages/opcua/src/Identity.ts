/**
 * What identifies an OPC UA node, and what merely locates it today.
 *
 * A UA node is addressed on the wire as `ns=4;s=Filler01`, and that `4` is a **NamespaceIndex** -
 * a per-session, per-server compression of a namespace URI, taken from the server's namespace array
 * at the moment you looked. The standard says in as many words that a client must not assume the
 * index is stable between sessions: add a namespace to a server's configuration and yesterday's `4`
 * is today's `5`, pointing at somebody else's nodes.
 *
 * So the identity this package hands out is the **URI** and the identifier, never the index:
 *
 *     nsu=urn:acme:filler;s=Filler01
 *
 * which is OPC UA's own ExpandedNodeId form and is portable by construction. The index is resolved
 * per session, on the way in and out, and never stored.
 *
 * This is the same rule `@source-repo/aspects` states about structure - a browse path is a placement
 * and not an identity - arriving from the other direction. A UA node's browse path is where it sits
 * in one arrangement of one server today; its URI-qualified identifier is what it *is*.
 */

/** A node named the way it can be named again tomorrow. */
export interface PortableNodeId {
    /** The namespace URI, not the index. `''` is the OPC UA base namespace, whose index is always 0. */
    readonly namespaceUri: string
    /** `i` numeric, `s` string, `g` guid, `b` opaque - OPC UA's own four identifier types. */
    readonly identifierType: 'i' | 's' | 'g' | 'b'
    readonly identifier: string
}

/** The ExpandedNodeId text form: `nsu=<uri>;<type>=<identifier>`, or `<type>=<id>` in namespace 0. */
export const portableNodeIdToText = (id: PortableNodeId): string =>
    id.namespaceUri ? `nsu=${id.namespaceUri};${id.identifierType}=${id.identifier}` : `${id.identifierType}=${id.identifier}`

/**
 * Read that text form back.
 *
 * Refused rather than guessed at when it is not one: an id that arrived from a link, a saved view or
 * another peer is input, and quietly treating an unparseable one as a node in namespace zero would
 * turn a typo into a browse of somebody else's address space.
 */
export const portableNodeIdFromText = (text: string): PortableNodeId | undefined => {
    const match = /^(?:nsu=(.*?);)?([isgb])=(.*)$/s.exec(text)
    if (!match) return undefined
    return { namespaceUri: match[1] ?? '', identifierType: match[2] as PortableNodeId['identifierType'], identifier: match[3] }
}

/**
 * The session-local form, given the server's namespace array.
 *
 * `undefined` when the server does not have that namespace at all, which is a real answer rather
 * than an error: a link saved against a server that has since dropped a namespace points at nothing,
 * and saying so is better than resolving it to whichever namespace happens to hold that index now.
 */
export const toSessionNodeId = (id: PortableNodeId, namespaces: readonly string[]): string | undefined => {
    const index = id.namespaceUri ? namespaces.indexOf(id.namespaceUri) : 0
    if (index < 0) return undefined
    return `ns=${index};${id.identifierType}=${id.identifier}`
}

/**
 * The portable form of a node the server just told us about.
 *
 * Read from the node's own canonical text - `ns=2;s=Line1` - rather than from its `identifierType`
 * field, which is a numeric enum whose values this file would then be asserting. The text form is
 * OPC UA's, node-opcua emits it, and it carries the type letter already; swapping the session index
 * for the namespace URI is then the only thing left to do, which is the one thing this file is for.
 */
export const fromSessionNodeId = (nodeId: { toString(): string; readonly namespace: number }, namespaces: readonly string[]): PortableNodeId => {
    const text = nodeId.toString()
    const match = /^(?:ns=(\d+);)?([isgb])=(.*)$/s.exec(text)
    // A node id this stack produced that does not read as one is a bug in the assumption above
    // rather than a value to guess at, and the loudest place to find that out is here.
    if (!match) throw new Error(`could not read the node id ${text}`)
    return { namespaceUri: namespaces[nodeId.namespace] ?? '', identifierType: match[2] as PortableNodeId['identifierType'], identifier: match[3] }
}
