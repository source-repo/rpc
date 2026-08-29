/**
 * What may cross a boundary between two nodes, wherever the boundary happens to be.
 *
 * One rule, checked the same way at every placement, and that is the whole point of it. A call to a
 * component on this thread, one on a worker and one on a machine in another building are the same
 * call to whoever wrote it - so a value that is legal for one of them and not for another makes
 * **placement observable**: moving a component into a worker to watch it, or onto another host to
 * scale it, would change what its callers may say to it. A debugger that could not be attached
 * without narrowing an interface would not be a debugger anybody used.
 *
 * So the rule is the intersection, not the union:
 *
 * | Placement | Carried by |
 * |---|---|
 * | Same thread | a direct call - carries anything |
 * | Worker | structured clone - carries `Date`, `Map`, `bigint`, class instances *flattened* |
 * | Another process | the frame codec, MsgPack or JSON - carries neither `Date` nor `Map` nor `bigint` |
 *
 * The narrowest column decides. That is why a `Date` is refused here even though a worker would
 * carry it: it arrives at a remote peer as a string, so a component that accepted one would work
 * until the day somebody moved it.
 *
 * ## The three that are silent
 *
 * **A class instance is flattened.** Structured clone copies its properties and drops its prototype,
 * so the receiver gets an object that looks right and has no methods - and nothing throws. This is
 * the one that motivated the check: the worker boundary previously relied on `postMessage` throwing,
 * which catches a function and says nothing at all about a class.
 *
 * **A `SharedArrayBuffer` crosses by reference.** It is not copied: both sides hold the same memory,
 * which is a shared-mutable-state bridge opened by an ordinary-looking argument. Shared memory is a
 * legitimate thing to want and `RpcPauseGate` is what wanting it looks like - a named capability
 * whose concurrency protocol is part of its contract - not a value that turns up in a parameter.
 *
 * **A cycle survives structured clone and no codec.** A worker would take it and a remote peer would
 * not, which is placement made observable in the sharpest way available.
 *
 * ## What it deliberately does not police
 *
 * `undefined` as an object's property value. JSON drops the key and MsgPack keeps it as nil, so the
 * two placements do differ - but an options object with an absent field is the most ordinary value
 * in this codebase, and refusing it would cost far more than the difference does. It is named here
 * rather than checked, because a validator that quietly ignores a case it knows about is worse than
 * one that says which cases it ignores.
 *
 * This is not `@source-repo/continuity`'s `toPortable`, and the two must not be merged. That one
 * asks whether a value survives *JSON*, because a snapshot is a document read by another language;
 * this asks whether a value survives *any of this library's boundaries*, which is a different and
 * slightly wider question - binary passes here, because the frame codec carries it.
 */

/** Why a value may not cross, and where in it the problem is. */
export interface RpcValueRefusal {
    /** The path to the offending value, from whatever root the caller named. */
    readonly path: string
    readonly why: string
}

export interface RpcValueOptions {
    /** What to call the root in a refusal - `bake argument 0`, `the result`. */
    readonly at?: string
    /**
     * Let a `SharedArrayBuffer` through.
     *
     * Off by default and rarely right: shared memory between two nodes is a concurrency protocol,
     * and a protocol belongs in something that documents it rather than in an argument. `RpcPauseGate`
     * is the shape of the exception - seven explicitly structured words with one purpose.
     */
    readonly allowSharedMemory?: boolean
    /** How deep to walk before refusing. A bound, because a validator is work on the call path. */
    readonly maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 32

/** The binary the frame codec carries: MsgPack as bytes, JSON as base64. Both ends agree. */
const isBinary = (value: object): boolean => value instanceof ArrayBuffer || ArrayBuffer.isView(value)

const nameOf = (value: object): string => {
    const prototype = Object.getPrototypeOf(value) as object | null
    return (prototype?.constructor as { name?: string } | undefined)?.name ?? 'an object with no prototype'
}

/**
 * The first thing in this value that cannot cross a boundary, or nothing.
 *
 * The first, not all of them: a refusal is a message somebody acts on, and a list of forty paths in
 * one object is a list nobody reads to the end. Fixing the first usually fixes the rest, because
 * they are usually the same mistake repeated.
 */
export const valueRefusal = (value: unknown, options: RpcValueOptions = {}): RpcValueRefusal | undefined => {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    // Ancestors rather than everything seen, so that a value appearing twice in a tree is fine and
    // only a value containing *itself* is refused. The distinction matters: sharing is ordinary and
    // survives every boundary as two copies; a cycle survives only one of them.
    const ancestors = new Set<object>()

    const walk = (held: unknown, path: string, depth: number): RpcValueRefusal | undefined => {
        if (held === null) return undefined
        switch (typeof held) {
            case 'string':
            case 'number':
            case 'boolean':
            case 'undefined':
                return undefined
            case 'function':
                return { path, why: `${path} is a function, and a function cannot be sent anywhere: it closes over a scope that exists only where it was written` }
            case 'symbol':
                return { path, why: `${path} is a symbol, which is an identity rather than a value and has no meaning on the other side of any boundary` }
            case 'bigint':
                return {
                    path,
                    why: `${path} is a bigint: it crosses a thread and does not cross a codec, since JSON has no such type. Send it as a decimal string, which is what this library's own positions do and for the same reason`
                }
        }

        const object = held as object
        if (depth > maxDepth) return { path, why: `${path} is nested more than ${maxDepth} deep, which is past the point where this checks - and past the point where a value is a message rather than a database` }
        if (ancestors.has(object)) return { path, why: `${path} contains itself: structured clone would carry that to a worker and no codec would carry it to another process, so a component holding one would work until it moved` }

        // Answered here in full rather than falling through to the prototype rule below, which would
        // otherwise refuse an *allowed* shared buffer a second time and for the wrong reason.
        if (typeof SharedArrayBuffer !== 'undefined' && object instanceof SharedArrayBuffer)
            return options.allowSharedMemory
                ? undefined
                : {
                      path,
                      why: `${path} is a SharedArrayBuffer, which crosses by reference rather than by copy: both sides would hold the same memory. Shared memory is a capability with a concurrency protocol of its own, not an argument`
                  }
        if (isBinary(object)) return undefined

        const prototype = Object.getPrototypeOf(object) as object | null
        if (Array.isArray(object)) {
            ancestors.add(object)
            for (const [index, entry] of object.entries()) {
                const refusal = walk(entry, `${path}[${index}]`, depth + 1)
                if (refusal) return refusal
            }
            ancestors.delete(object)
            return undefined
        }
        if (prototype !== Object.prototype && prototype !== null)
            return {
                path,
                why: `${path} is ${nameOf(object)}, and only a plain object crosses as itself: structured clone copies its properties and drops its prototype, so the far side receives something that looks right and has no methods - and nothing throws`
            }

        ancestors.add(object)
        for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
            const refusal = walk(entry, `${path}.${key}`, depth + 1)
            if (refusal) return refusal
        }
        ancestors.delete(object)
        return undefined
    }

    return walk(value, options.at ?? 'this value', 0)
}

/** Every argument of one call, named the way a caller will recognise. The first refusal, or nothing. */
export const argumentsRefusal = (method: string, params: readonly unknown[], options: RpcValueOptions = {}): RpcValueRefusal | undefined => {
    for (const [index, param] of params.entries()) {
        const refusal = valueRefusal(param, { ...options, at: `${method} argument ${index}` })
        if (refusal) return refusal
    }
    return undefined
}
