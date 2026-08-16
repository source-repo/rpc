import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'

/**
 * The MQTT 5 half of the frame mapping: what the neutral frame in RPC/Frame.ts is called on this
 * wire, and how it is read back off it. The layout is described in docs/mqtt5-frame-spec.md.
 *
 * The point is that a peer needs no msgrpc code to take part: where to reply and how to correlate
 * come from the protocol's own Response Topic and Correlation Data, and everything else is a
 * readable user property. Kept separate from the transport so the naming can be read, and tested,
 * without a broker - and separate from the frame itself so that adding a field to the protocol is
 * not the same act as deciding what MQTT calls it.
 */

/** Control properties are prefixed so a broker or gateway injecting its own cannot be mistaken for one. */
export const MR = {
    version: 'mr-v',
    source: 'mr-src',
    kind: 'mr-kind',
    path: 'mr-path',
    method: 'mr-method',
    event: 'mr-event',
    code: 'mr-code',
    nonce: 'mr-nonce',
    timestamp: 'mr-ts',
    signature: 'mr-sig',
    contractVersion: 'mr-ver',
    /**
     * Milliseconds the caller will still wait, counted from when it sent. Carried alongside MQTT's
     * own messageExpiryInterval rather than instead of it: expiry is coarse (whole seconds), the
     * broker decrements it, and it stops at the broker - it says nothing about how long a frame then
     * sat in the receiving process. This is the caller's own statement, signed, and it survives
     * relaying through a transport that does not speak MQTT at all.
     */
    ttl: 'mr-ttl',
    /**
     * Names the command a request is an attempt at, when the caller distinguishes the two. Absent
     * means the correlation data is the name, so a redelivered packet is the same command and a
     * fresh attempt is a different one.
     */
    idempotencyKey: 'mr-idem',
    /**
     * The owner generation the caller observed for the instance it is addressing. Absent means an
     * unfenced call, which is the ordinary case.
     *
     * This travels or the fence does not exist. `RpcServerHandler.fenceRefusal` returns early when
     * the payload carries no fence, so a layout with no representation for one does not weaken the
     * check - it removes it, and a command whose instance was reassigned mid-flight runs under the
     * new owner with nothing said. Which is the failure a fence exists to prevent.
     */
    fence: 'mr-fence',
    /**
     * On a result: this is the receipt for a method that answers later, not the answer. `1` when
     * set, absent otherwise - a caller hydrates a ticket on the property being there rather than on
     * its value, so there is no false to spell.
     */
    deferred: 'mr-deferred',
    /** On a ticket: `progress`, `resolved` or `rejected`. Which of the three decides whether the caller's promise settles. */
    outcome: 'mr-outcome',
    /**
     * On an event: this emission's position in the server's per-(namespace, event) count, and the
     * server incarnation that count belongs to.
     *
     * Together they are what lets a watcher say "gapless" rather than merely "saw nothing":
     * consecutive stamps under one epoch prove nothing fell between them. Carried as properties
     * rather than folded into the payload because the payload is the emit arguments and nothing
     * else, which is what makes an event readable to a peer with no msgrpc code.
     */
    seq: 'mr-seq',
    epoch: 'mr-epoch'
} as const

/**
 * Version 3 covers the whole protocol: it adds the owner fence, the deferred marker, the ticket
 * outcome and the event cursor, all of them in the signature. Version 2 covered contentType, the
 * error code, the declared contract version, the response topic, the ttl and the idempotency key;
 * version 1 covered none of them, and a frame signed under one cannot verify under another.
 *
 * Bumped rather than negotiated: a receiver that quietly accepted either would let an attacker
 * choose the weaker, and under version 2 the weaker choice is the one where deleting `mr-fence`
 * disarms the owner check for free.
 */
export const FRAME_VERSION = '3'

/** Frame versions this build will accept. A frame announcing anything else is refused, not guessed at. */
export const SUPPORTED_FRAME_VERSIONS = new Set([FRAME_VERSION])

export type RawUserProperties = { [key: string]: string | string[] } | undefined

/**
 * Read the control properties, refusing any that appear more than once.
 *
 * MQTT permits a repeated user property, and mqtt.js surfaces repeats as an array. Taking the
 * first or the last would let a sender show one value to a check and a different one to the
 * dispatcher, so a repeat is an ambiguity to refuse rather than resolve.
 */
export const readControlProperties = (properties: RawUserProperties): { values: { [key: string]: string } } | { duplicate: string } => {
    const values: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(properties ?? {})) {
        if (!key.startsWith('mr-')) continue
        if (Array.isArray(value)) return { duplicate: key }
        values[key] = value
    }
    return { values }
}

/**
 * A count read back off the wire, or undefined for anything that is not one.
 *
 * Every user property is a string, and this one is compared and ordered rather than merely echoed.
 * A `seq` of "NaN" or "1e400" would make a watcher's gap arithmetic produce nonsense quietly, so
 * what cannot be read as a whole number is treated as a frame that carried no count at all.
 */
export const readCount = (value: string | undefined) => {
    if (value === undefined) return undefined
    const count = Number(value)
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

export const correlationToString = (correlation: Uint8Array | undefined) => (correlation ? uint8ArrayToString(correlation) : undefined)
export const correlationToBytes = (correlation: string | undefined) => (correlation ? stringToUint8Array(correlation) : undefined)
