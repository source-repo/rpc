import type { AspectSemantics, Occurrence } from '@source-repo/aspects'

/**
 * Arrangements of a server's nodes that the server does not itself publish.
 *
 * The address space is the one hierarchy OPC UA hands you. A **functional** arrangement - what a
 * thing does, the loop it serves - and a **location** arrangement - where it stands - are the two
 * IEC 81346 aspects a plant actually asks for, and a generic UA server has neither. Some companion
 * specifications model them; most servers just have a browse tree somebody built.
 *
 * So the rule comes from the deployment, as code, and never over the wire. That is not caution for
 * its own sake: `@source-repo/aspects` refuses to evaluate remotely supplied structure rules
 * precisely so that a provider cannot be turned into a query engine by a caller, and a grouping
 * function is exactly such a rule. What crosses the wire is the *result* - a tree of occurrences.
 *
 * ## Selection is part of it
 *
 * A rule that returns nothing for a node leaves that node out of the arrangement entirely, and that
 * is a feature rather than a gap: an operations arrangement holds the four hundred nodes an
 * operator cares about, not the eighteen thousand a server has. `placements()` answering empty is
 * the aspects package's own way of saying *this structure does not contain that object*.
 *
 * The distinction worth keeping, and the one that stops aspects becoming a tagging mechanism:
 * **selection as meaning** - "these are the objects that matter operationally" - is an aspect;
 * selection as configuration - "these are the nodes currently published to MQTT" - is a read model
 * of somebody's settings, and belongs in an aspect only if a person would browse it as one.
 *
 * ## Why these need an index and the address space does not
 *
 * A browse answers *what is under this node* directly, so the address space is served a branch at a
 * time and never walked. A derived arrangement cannot be: to know what belongs under "Hall 2" you
 * must have seen every node and asked the rule about each one. That is a walk of the server, and it
 * is why `index()` is an explicit, bounded operation with a number in the component's state rather
 * than something that happens quietly behind the first click.
 */

/** What the rule is told about a node. Everything here came from one browse of its parent. */
export interface IndexedNode {
    /** The portable, URI-qualified id - the same identity the address space aspect hands out. */
    readonly id: string
    /** The session-local id, for a further browse or read while this index is being built. */
    readonly session: string
    readonly title: string
    /** `Object`, `Variable`, `Method`, and the rest of OPC UA's node classes. */
    readonly nodeClass: string
    /** Titles from the Objects folder down to, but not including, this node. */
    readonly path: readonly string[]
}

/**
 * One arrangement, and the rule that builds it.
 *
 * `groups` returns the paths this node belongs under - plural, because a node genuinely can belong
 * in two places in one arrangement, and pretending otherwise is what makes a system quietly show
 * half its equipment. Nothing, or an empty array, leaves it out.
 */
export interface DerivedAspect {
    readonly id: string
    readonly label: string
    readonly description?: string
    /** What this arrangement is in a shared vocabulary, when it is one. `IEC81346.function`. */
    readonly semantics?: AspectSemantics
    readonly defaultColumns?: readonly string[]
    groups(node: IndexedNode): readonly (readonly string[])[] | undefined
}

/**
 * A built arrangement: what is under each occurrence, and where each object sits.
 *
 * Occurrence ids are issued from a counter rather than composed from group names, and that is worth
 * the extra map. A composed id has to escape whatever a group name might contain - and group names
 * here come from a rule somebody else wrote, over data from a server nobody controls, so a name
 * with a slash in it is a matter of time. An opaque id cannot be malformed by its contents.
 */
export interface DerivedIndex {
    readonly children: ReadonlyMap<string, readonly Occurrence[]>
    readonly placements: ReadonlyMap<string, readonly string[]>
    readonly nodes: number
    readonly groups: number
}

/** The key under which a branch's children are held. The roots have no parent occurrence. */
const ROOT = ''

/**
 * Build one arrangement from the nodes an index walk found.
 *
 * Groups are created as they are first needed and shared by everything that names the same path, so
 * two rules agreeing that a pump is in `Hall 2 / Line 3` put it under one node rather than two that
 * look identical.
 */
export const buildDerived = (aspect: DerivedAspect, nodes: readonly IndexedNode[], occurrenceOf: (node: IndexedNode) => Occurrence): DerivedIndex => {
    const children = new Map<string, Occurrence[]>([[ROOT, []]])
    const placements = new Map<string, string[]>()
    /**
     * Group path, joined for lookup only - never used as an id, for the reason above.
     *
     * NUL-separated, written as the escape: it cannot occur in a group name, so `A` under `B C`
     * and `A B` under `C` cannot collide however somebody names their halls. The escape rather
     * than the byte because a literal one makes this file binary to every tool that sniffs
     * content - which the repository's own guard caught here, in this very line, before the file
     * was committed.
     */
    const groupIds = new Map<string, string>()
    let issued = 0

    const groupFor = (path: readonly string[]): string => {
        let parent = ROOT
        let here = ''
        for (const [depth, name] of path.entries()) {
            here = here ? `${here}\u0000${name}` : name
            let id = groupIds.get(here)
            if (!id) {
                id = `g${(issued += 1)}`
                groupIds.set(here, id)
                children.set(id, [])
                children.get(parent)!.push({ occurrenceId: id, title: name, kind: 'opcua.group', hasChildren: true, fields: { depth: depth + 1 } })
            }
            parent = id
        }
        return parent
    }

    for (const node of nodes) {
        const paths = aspect.groups(node)
        if (!paths?.length) continue
        for (const path of paths) {
            const parent = groupFor(path)
            const occurrenceId = `o${(issued += 1)}`
            children.get(parent)!.push({ ...occurrenceOf(node), occurrenceId, hasChildren: false })
            placements.set(node.id, [...(placements.get(node.id) ?? []), occurrenceId])
        }
    }

    // A group that ended up with nothing under it is a rule that named a path and then put nothing
    // in it. It is left in place: an empty branch is a true statement about the arrangement, and
    // silently dropping it would hide a rule that is not doing what its author thinks.
    return { children, placements, nodes: placements.size, groups: groupIds.size }
}

export const derivedRoot = ROOT
