import type { DescribedAction, DescribedComponent, DescribedMethod, TypeNode } from './types.js'

/**
 * What is a container and what is a value, decided once from the contract and nothing else.
 *
 * The component panel used to draw one tree of everything, which is right for an oven and wrong for
 * anything carrying hundreds of values - a plant screen is three hundred tags, and three hundred
 * tree nodes is not a screen. So the panel splits in two: a scope tree of *typed containers* on the
 * left, and a grid of *values* on the right, where selecting a node narrows the grid to everything
 * beneath it recursively. The tree filters; it does not navigate.
 *
 * **The rule that makes it work is that a record is a value leaf, and never a tree node.** A
 * `{ [tag: string]: Reading }` does not appear in the tree at all - its entries are grid rows. That
 * is principled rather than a threshold on size: an object's members are named by the contract, and
 * a record's keys are *data*. Type ends, data begins, and the tree stops exactly there.
 *
 * Which yields the invariant this file exists to keep: **the tree is exactly the contract, and costs
 * nothing on the wire, ever.** Everything here is a function of `props` and `state` as `describe()`
 * published them, so the whole scope tree is drawn before a single value arrives, however much data
 * sits behind it. Nothing in this file reads a value, and nothing in it may ever issue a request -
 * a scope node whose children came from a peer would end the invariant silently, and the tree would
 * start costing what it is here to avoid. A hierarchy among *rows* is a different tree, fetched
 * lazily, and it belongs to the grid rather than to this one.
 *
 * The leaf rule is shared with `ValueTree` rather than restated, because the tree, the grid and the
 * renderer disagreeing about what counts as a leaf is how a value appears twice or not at all.
 */

type Types = { [name: string]: TypeNode } | undefined

/** A typed container: a node the scope tree draws. Never a leaf, never a record. */
export interface ScopeNode {
    /** Spelled from the component root, so `['state', 'zones', 'top']` - what `sets` and a projection use. */
    path: string[]
    /** The last segment, which for the two roots is `props` or `state`. */
    name: string
    children: ScopeNode[]
}

/** One row of the grid: a value, or a record whose *entries* are the rows. */
export interface ScopeLeaf {
    path: string[]
    /** The published type, resolved through any refs. Absent where the contract does not say. */
    type: TypeNode | undefined
    /**
     * This leaf is a record or an array, so it is not one row but a resource: its entries are the
     * rows, and paging them is a request rather than a walk. The grid names it in a `getList`; the
     * tree never expands it.
     */
    collection?: boolean
}

/**
 * The duck-typed projection of a process value: an object carrying `value` plus any of `quality`,
 * `unit`, `forced`.
 *
 * Three fields to a schema and one thing to a reader, so it is a leaf despite being an object - a
 * `zones.top.setpoint` that expanded into a branch of three would be a worse screen and a wronger
 * one, because the reading is what the operator is looking at. The domain classes live in sector
 * contract packages this console has no compile-time sight of, so the shape is recognized rather
 * than imported.
 */
export const isProcessValueType = (type: TypeNode | undefined) =>
    type?.kind === 'object' && 'value' in type.fields && ('quality' in type.fields || 'unit' in type.fields || 'forced' in type.fields || 'at' in type.fields)

/**
 * Whether the contract enumerates this thing's members, which is the whole test for a tree node.
 *
 * `object` and `tuple` qualify: their members are named or positioned by the type, so the tree can
 * draw them before any data exists. `record` and `array` do not - their members are keys and
 * indices, which are data. A process value is excluded even though it is an object, for the reason
 * above, and it is excluded here rather than at each call site so the tree and the grid cannot come
 * to different conclusions.
 */
const enumerable = (type: TypeNode | undefined): type is Extract<TypeNode, { kind: 'object' | 'tuple' }> =>
    (type?.kind === 'object' || type?.kind === 'tuple') && !isProcessValueType(type)

/** Members in contract order: named for an object, positional for a tuple. */
const membersOf = (type: Extract<TypeNode, { kind: 'object' | 'tuple' }>) =>
    type.kind === 'object'
        ? Object.entries(type.fields).map(([name, field]) => ({ name, type: field.type }))
        : type.items.map((item, index) => ({ name: String(index), type: item }))

/**
 * Resolve a ref, refusing to expand one already being expanded.
 *
 * A contract may legitimately describe a self-referential type - `interface Node { child: Node }` is
 * how a hierarchy is written - and expanding it here would not terminate. Stopping is also the right
 * answer rather than merely the safe one: a type that contains itself describes a shape whose depth
 * is decided by *data*, and data is precisely what this tree does not know. So a repeated ref
 * becomes a leaf, and whatever hangs beneath it is the grid's problem to fetch.
 */
const resolveOnce = (type: TypeNode | undefined, types: Types, seen: ReadonlySet<string>): { type: TypeNode | undefined; seen: ReadonlySet<string> } => {
    if (type?.kind !== 'ref') return { type, seen }
    if (seen.has(type.name)) return { type: undefined, seen }
    return resolveOnce(types?.[type.name], types, new Set(seen).add(type.name))
}

const childrenOf = (type: TypeNode | undefined, path: string[], types: Types, seen: ReadonlySet<string>): ScopeNode[] => {
    const here = resolveOnce(type, types, seen)
    if (!enumerable(here.type)) return []
    return membersOf(here.type)
        .map((member) => ({ member, at: resolveOnce(member.type, types, here.seen) }))
        .filter(({ at }) => enumerable(at.type))
        .map(({ member, at }) => ({
            name: member.name,
            path: [...path, member.name],
            children: childrenOf(member.type, [...path, member.name], types, at.seen)
        }))
}

/**
 * The whole scope tree for a component, which is two roots of one tree rather than two panels.
 *
 * `props` and `state` sit side by side because they are one list to whoever is reading the screen,
 * and because a path spelled from either root is the same kind of thing everywhere else here - what
 * `sets` claims, what a projection names, what a grid row is labelled with. A root the contract does
 * not publish is absent rather than empty: a component serving no schema has no scope to show, and
 * an empty `state` node would claim it had one and that it was empty.
 */
export const scopeTree = (component: DescribedComponent, types?: Types): ScopeNode[] => [
    ...(['props', 'state'] as const)
        .filter((root) => component[root] !== undefined)
        .map((root) => ({ name: root, path: [root], children: childrenOf(component[root], [root], types, new Set()) })),
    // A declared resource is a root of its own, beside props and state, because it is neither: a
    // table or a queue is not part of the component's state and has no path into it. It has no
    // children, which is the record rule holding one level up - the resource is named by the
    // component, its rows are data, and selecting it puts those rows in the grid.
    //
    // Only those this pane can actually show, which the verb list is there to say: `getList` for a
    // page of rows, and `getChildren` for a tree browsed a branch at a time. A resource that
    // appeared and then refused every selection would be worse than one that is not offered.
    ...(component.resources ?? [])
        .filter((resource) => resource.verbs.includes('getList') || resource.verbs.includes('getChildren'))
        .map((resource) => ({ name: resource.label ?? resource.path.join('.'), path: [...resource.path], children: [] }))
]

/**
 * The resource at this path when it is a tree this console can browse, and nothing otherwise.
 *
 * Both halves are required rather than either: `shape` says what it is and the verb says the node
 * will answer for it, and a resource claiming one without the other is a declaration the viewer
 * cannot act on. Offering a tree that refuses `getChildren` would be the thing the verb list exists
 * to prevent.
 */
export const treeResourceAt = (component: DescribedComponent, path: readonly string[]) => {
    const resource = component.resources?.find((declared) => declared.path.length === path.length && declared.path.every((segment, at) => segment === path[at]))
    return resource?.shape === 'tree' && resource.verbs.includes('getChildren') ? resource : undefined
}

/**
 * The resource a path names, when a component declared one.
 *
 * Matched on the whole path rather than the first segment, so a resource called `state` could not
 * shadow the component's own - not that one should be called that, but a rule that depends on
 * nobody doing so is not a rule.
 *
 * Exported as `declaredResourceAt` because a viewer needs the same question `treeResourceAt` asks,
 * without the tree part: a table, a queue and an address space are one arrangement - rows, with a
 * panel for the row that is picked - and only the *browsing* differs. Asking whether a resource is
 * a tree in order to decide how to *draw* it is what produced three renderings of one idea.
 */
const resourceAt = (component: DescribedComponent, path: string[]) =>
    component.resources?.find((resource) => resource.path.length === path.length && resource.path.every((segment, at) => segment === path[at]))

export const declaredResourceAt = (component: DescribedComponent, path: readonly string[]) => resourceAt(component, [...path])

/**
 * Which columns to draw for a resource, in order of what actually knows.
 *
 * `defaultColumns` first, because it is the resource's own judgement about which four of forty a
 * person wants before they have chosen anything. Then the row type, which knows every field there
 * is and no more. A resource with neither gets nothing here and the table falls back to the id,
 * which is honest: it is what a resource that described nothing actually has.
 */
export const columnsFor = (resource: { presentation?: { defaultColumns?: readonly string[] }; row?: TypeNode } | undefined, types?: Types): readonly string[] => {
    if (resource?.presentation?.defaultColumns?.length) return resource.presentation.defaultColumns
    const row = resolveOnce(resource?.row, types, new Set()).type
    return row?.kind === 'object' ? Object.keys(row.fields) : []
}

/**
 * Every value beneath a path, recursively, all the way down - which is what selecting a scope node
 * shows.
 *
 * Recursive by design and not by accident: the tree is a filter rather than a navigator, so
 * selecting `state` lists every leaf in the state and selecting `state.zones` lists the leaves of
 * both zones. A grid that showed only direct children would make the tree a navigator again, and a
 * screen would need as many clicks as the state has depth.
 *
 * A record or an array stops the walk and is reported as one `collection` leaf. It is not that its
 * contents are uninteresting - they are most of what the operator came to see - but that they are
 * data, and the grid fetches them by asking rather than by walking a type. Expanding it here would
 * be inventing rows that may not exist.
 */
export const leavesUnder = (type: TypeNode | undefined, path: string[], types?: Types): ScopeLeaf[] => {
    const walk = (at: TypeNode | undefined, here: string[], seen: ReadonlySet<string>): ScopeLeaf[] => {
        const resolved = resolveOnce(at, types, seen)
        if (resolved.type?.kind === 'record' || resolved.type?.kind === 'array') return [{ path: here, type: resolved.type, collection: true }]
        if (!enumerable(resolved.type)) return [{ path: here, type: resolved.type }]
        return membersOf(resolved.type).flatMap((member) => walk(member.type, [...here, member.name], resolved.seen))
    }
    return walk(type, path, new Set())
}

/**
 * The type at a path, for a caller that has a scope selection and needs what sits there.
 *
 * Separate from the walks above because a selection is a path and the contract is a tree, and every
 * consumer would otherwise re-derive the same descent. Refs resolve on the way down, so a caller
 * gets the shape rather than the name.
 */
export const typeAt = (component: DescribedComponent, path: string[], types?: Types): TypeNode | undefined => {
    // A declared resource reads as a record of its row type, which is what it is: keys chosen by
    // the store rather than by the contract, values of a shape the component published. Saying it
    // that way means the grid needs to know nothing about resources - it finds a collection under
    // the selection and pages it, exactly as it does for a record in state.
    const resource = resourceAt(component, path)
    if (resource) return { kind: 'record', values: resource.row ?? { kind: 'any' } }
    const [root, ...rest] = path
    if (root !== 'props' && root !== 'state') return undefined
    let at = resolveOnce(component[root], types, new Set())
    for (const step of rest) {
        if (!enumerable(at.type)) return undefined
        const member = membersOf(at.type).find(({ name }) => name === step)
        if (!member) return undefined
        at = resolveOnce(member.type, types, at.seen)
    }
    return at.type
}

/**
 * What may be done to a row of the resource at this path - and only what can actually be done.
 *
 * A declared action names one of the component's own methods, so it is checked against the methods
 * `describe()` published before anything is drawn for it. A typo in a declaration would otherwise
 * produce a control that always fails, which is worse than no control at all: an operator would
 * find out it does not work by trying it on a plant.
 *
 * That check is also what keeps the declaration honest about what it is. An action adds no
 * capability - it says which existing method is about which row - so an action naming a method that
 * does not exist is not a half-working feature, it is a statement that was never true.
 */
/**
 * Which of a resource's actions belong on *this* row.
 *
 * Two questions and they are not the same one. `appliesTo` is about position - a rack's cabinets are
 * branches and its ports are leaves, and `resetPort` is about the ports. `kinds` is about what the
 * thing is - an address space lists Variables and Methods and both are leaves, and `write` is about
 * the first. A row failing either test is not offered the button, which is the whole point: the
 * alternative is a command an operator discovers is wrong by pressing it.
 *
 * One function rather than the three copies of the position test this replaces, because a rule
 * applied in three places is a rule that will be right in two of them.
 */
export const actionsOn = (actions: readonly DescribedAction[] | undefined, row: { branch: boolean; kind?: unknown }): DescribedAction[] =>
    (actions ?? []).filter((action) => {
        const where = action.appliesTo ?? 'leaves'
        if (where !== 'all' && where !== (row.branch ? 'branches' : 'leaves')) return false
        // Declared but unmatchable is a no rather than a yes: a row with no kind cannot be shown to
        // be one of the kinds named, and the safe half of that is not offering the command.
        if (action.kinds?.length) return typeof row.kind === 'string' && action.kinds.includes(row.kind)
        return true
    })

export const actionsFor = (component: DescribedComponent, path: string[], methods: readonly DescribedMethod[]): DescribedAction[] | undefined => {
    const resource = component.resources?.find((declared) => declared.path.length === path.length && declared.path.every((segment, at) => segment === path[at]))
    return resource?.actions?.filter((action) => methods.some((method) => method.name === action.method))
}
