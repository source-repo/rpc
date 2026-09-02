import type { RpcWritableResource } from '@source-repo/rpc'

/**
 * Where a component's write half lives, and which of its fields to offer.
 *
 * Kept apart from the form that draws them so both can be reasoned about without a browser - and
 * because the first of these is a convention rather than a fact, which is worth stating in one
 * place rather than assuming in three.
 */

/**
 * The namespace a component's writes are exposed under.
 *
 * **A convention, followed rather than discovered.** The read half and the write half are two
 * components, and nothing in `describe()` links them: `document` and `relational` each expose a
 * separate write service, and the name beside the read one is how a caller finds it. MCP already
 * says so in its own refusal text - *the write half is exposed beside it, conventionally as
 * `<read name>.write`* - so this follows the same rule rather than inventing a second.
 *
 * A namespace that is not there is the ordinary case, not a failure: most components have no write
 * half at all, and a viewer asking for one gets nothing and offers nothing.
 */
export const writeNamespace = (namespace: string): string => `${namespace}.write`

/**
 * Which fields an edit form offers, in which order.
 *
 * Two declarations meet here and they are not equals. `writable()` is **authority**: it is the write
 * rules resolved against the store, so a column that is not in it cannot be written whatever anybody
 * says. `presentation.edit` is **advice**: which of those are worth putting in front of somebody,
 * and in what order, because forty writable columns of which three are ever edited is the ordinary
 * case.
 *
 * So advice orders and narrows, and can never widen. A path in `edit` that `writable()` did not
 * resolve is dropped, exactly as the contract says - a presentation hint that could make a field
 * editable would be a hint deciding authority. And no advice at all offers everything writable in
 * the order the rule declared it, which is a perfectly good answer and why the hint is optional.
 */
export const editableFields = (writable: RpcWritableResource | undefined, edit?: readonly string[]): readonly string[] => {
    if (!writable) return []
    const allowed = new Set(writable.columns)
    if (!edit?.length) return writable.columns
    return edit.filter((field) => allowed.has(field))
}

/** The writable resource for one path, by the name the write service knows it as. */
export const writableFor = (writable: readonly RpcWritableResource[] | undefined, resource: readonly string[]): RpcWritableResource | undefined =>
    // A write surface names a resource by a single string - a table, a collection - where `$data`
    // addresses it by a path. They agree for every resource that has one segment, which is every
    // resource either store package serves; a deeper path simply matches nothing rather than being
    // flattened into a name that might collide with a different resource's.
    resource.length === 1 ? writable?.find((one) => one.resource === resource[0]) : undefined

/** Whether a row can be changed at all: the resource accepts `update` and offers a field to change. */
export const canUpdate = (writable: RpcWritableResource | undefined, edit?: readonly string[]): boolean =>
    !!writable && writable.verbs.includes('update') && editableFields(writable, edit).length > 0
