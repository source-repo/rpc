import type { RpcFilter } from '@source-repo/rpc'

/**
 * What an operator types, as something a peer can check without running anything.
 *
 * The grammar is the one the plant console this design came from used, because operators already
 * know it: `&` is and, `|` is or, and a bare word is a substring of the tag name. `field:word`
 * narrows to a field of the row, so `quality:bad` is the query a screen exists for - the one that
 * cannot be answered locally at any bandwidth, because finding out which of three hundred are bad
 * is exactly what a local filter must receive all three hundred to discover.
 *
 * **What it compiles to is data, never a program.** The provider it is modelled on ended this
 * function with `new RegExp(expression, 'i')` and handed that to the store; here the same text
 * becomes `{ field, op: 'contains', operand }`, which the peer checks and can refuse. That matters
 * because the thing evaluating it may be a small computer with a process attached, and it evaluates
 * again every time the page is asked for. A search box should not be able to spend a plant server's
 * afternoon.
 *
 * Or binds tighter than and, so `a | b & c` is `(a or b) and c` - which is what someone typing a
 * list of alternatives beside a qualifier means, and it is also how the original read it.
 *
 * Comparisons - `value >= 200` - exist in the wire grammar and deliberately not in this box yet.
 * A search box that silently reads `>` as part of a tag name is worse than one that does not offer
 * it, and nothing has asked for it from a keyboard.
 */
export const compileFilter = (text: string): RpcFilter | undefined => {
    const ands = text
        .split(/&+/)
        .map((group) =>
            group
                .split(/\|+/)
                .map((term) => term.trim())
                .filter(Boolean)
                .map(condition)
        )
        .filter((group) => group.length)
        .map((group) => (group.length === 1 ? group[0] : { any: group }))
    if (!ands.length) return undefined
    return ands.length === 1 ? ands[0] : { all: ands }
}

/**
 * One term. `field:word` names a field of the row; anything else searches the id, which is the tag
 * name and is what somebody typing into a box is nearly always looking for.
 */
const condition = (term: string): RpcFilter => {
    const colon = term.indexOf(':')
    if (colon <= 0) return { field: 'id', op: 'contains', operand: term }
    const operand = term.slice(colon + 1).trim()
    // `tag:` with nothing after it searches for that word in the id rather than for every row whose
    // `tag` field contains the empty string, which is all of them - a half-typed query should
    // narrow towards what is wanted, never widen to everything.
    if (!operand) return { field: 'id', op: 'contains', operand: term.slice(0, colon).trim() }
    return { field: term.slice(0, colon).trim(), op: 'contains', operand }
}
