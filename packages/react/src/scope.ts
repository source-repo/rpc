import { componentDataResources } from '@source-repo/rpc'
import type { DescribedAction, DescribedComponent, DescribedMethod, DescribedResource, TypeNode } from './types.js'

/** Resource catalogue and schema helpers shared by the generic tree/scope/grid. */

type Types = { [name: string]: TypeNode } | undefined

/** One resource-catalogue node. Provider-owned branches are fetched by ResourceTree. */
export interface ScopeNode {
    /** The resource path. */
    path: string[]
    /** Its display name. */
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
 * The provider catalogue, including the two resources supplied by RpcComponent itself.
 *
 * Kept as a compatibility fold at the client boundary: new peers publish these in `resources`,
 * while an older description still has enough contract to name them. Either way the renderer sees
 * resources only; it never rebuilds their branch tree from `props` or `state`.
 */
const resourcesOf = (component: DescribedComponent): DescribedResource[] => {
    const declared = component.resources ?? []
    const builtIn = componentDataResources(component).filter(
        (resource) => !declared.some((one) => one.path.length === resource.path.length && one.path.every((segment, at) => segment === resource.path[at]))
    )
    return [...(builtIn as DescribedResource[]), ...declared]
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

/**
 * The resource catalogue for a component.
 *
 * This tree contains resource roots only. Every hierarchy beneath a root belongs to that resource
 * and is fetched through `getChildren` by `ResourceTree`; props and state are not a second kind of
 * tree assembled from schema. That is what lets Line, Stock, SQL and an address space use the same
 * scoping interaction.
 */
export const scopeTree = (component: DescribedComponent, _types?: Types): ScopeNode[] => [
    // Only those this pane can actually show, which the verb list is there to say: `getList` for a
    // page of rows, and `getChildren` for a tree browsed a branch at a time. A resource that
    // appeared and then refused every selection would be worse than one that is not offered.
    ...resourcesOf(component)
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
    const resource = resourcesOf(component).find((declared) => declared.path.length === path.length && declared.path.every((segment, at) => segment === path[at]))
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

export const declaredResourceAt = (component: DescribedComponent, path: readonly string[]) =>
    resourcesOf(component).find((resource) => resource.path.length === path.length && resource.path.every((segment, at) => segment === path[at]))

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
