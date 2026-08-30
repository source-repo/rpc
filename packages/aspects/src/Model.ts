import type { RpcRef } from '@source-repo/rpc'
// Type-only, and circular with `Link.ts` on purpose: an object carries its links and a link names
// an object, which is one idea in two files rather than two ideas.
import type { AspectLink } from './Link.js'

/**
 * What a provider serves, and the words it serves it in.
 *
 * IEC 81346's idea, and its word: one object is viewed in several **aspects** - function (`=`),
 * product (`-`), location (`+`), and since the 2022 edition type (`%`) - and an aspect is a way of
 * looking rather than a place the object lives. A plant has had this problem for as long as it has
 * had drawings, and the answer it reached is the answer here.
 *
 * The type aspect is the odd one and the useful one: it is not a structure over individuals but a
 * placement of an object under the *class* it belongs to. This pump and every other of that model
 * sit under one type, so what is said once about the type is true of all of them. A system without
 * that aspect says the model's things about each instance, and eventually disagrees with itself.
 *
 * So the whole layer rests on one distinction, and everything exists to keep it: **structure is an
 * aspect, identity is not.** A document filed under a folder and the same document listed under
 * a topic are one object in two places. A `AspectRef` says which object; an occurrence says
 * where it is showing. Confusing the two is how a system ends up with the same thing twice, each
 * copy accumulating its own comments.
 *
 * This package deliberately owns no storage, no parser and no renderer. It is a vocabulary and the
 * two pieces of logic that vocabulary implies - serving aspects as trees, and resolving a link
 * from one place to another. A provider supplies the objects.
 */

/**
 * Which object, independent of where it is showing.
 *
 * The provider resolves it, so the reference carries the component that can answer for it rather
 * than a global identifier nobody issues. A path is not part of it: reorganising a aspect must
 * not invalidate a saved reference, which is the failure this whole shape exists to avoid.
 */
export interface AspectRef {
    /** The component that can resolve this object. */
    readonly provider: RpcRef
    /** Provider-defined resource name. Not a structural path. */
    readonly resource: readonly string[]
    /** Stable id inside that resource. */
    readonly id: string
}

/** Two references to the same object. Compared field by field, since a ref is data. */
export const sameAspectRef = (a: AspectRef | undefined, b: AspectRef | undefined): boolean =>
    !!a &&
    !!b &&
    a.provider.peer === b.provider.peer &&
    a.provider.instance === b.provider.instance &&
    a.id === b.id &&
    a.resource.length === b.resource.length &&
    a.resource.every((segment, at) => segment === b.resource[at])

/**
 * One string for a reference, for use as a map key and nowhere else.
 *
 * NUL-separated because it cannot occur in a peer name, an instance, a resource segment or an id,
 * so no choice of those can forge a collision with another reference. Written as the escape rather
 * than the byte, which this repository states as a rule and has been bitten by: a literal NUL makes
 * the file binary to every tool that sniffs content, and `grep` then finds nothing and says so
 * confidently.
 */
export const aspectRefKey = (ref: AspectRef): string => [ref.provider.peer, ref.provider.instance, ...ref.resource, ref.id].join('\u0000')

/** Where an object came from, and when anybody last looked. */
export interface AspectOrigin {
    /** The system of record: `markdown`, `linear`, `git`. Namespaced by whoever owns it. */
    readonly system: string
    readonly externalId?: string
    readonly url?: string
    readonly createdAt?: string
    readonly updatedAt?: string
    /** When this provider last read it, which is a different fact from when it last changed. */
    readonly retrievedAt?: string
    readonly revision?: string
}

/**
 * Enough of an object to draw a row, and no more.
 *
 * Small on purpose: this is what a tree and a list carry, and a summary that included the document
 * would make every branch expansion pay for text nobody has opened yet.
 */
export interface ObjectSummary {
    readonly ref: AspectRef
    /** Namespaced, such as `markdown.document` or `linear.issue`. */
    readonly kind: string
    readonly title: string
    readonly summary?: string
    readonly fields?: Readonly<Record<string, unknown>>
    readonly origin: AspectOrigin
}

/** The object as opened: its content and what it points at. */
export interface ObjectDetail extends ObjectSummary {
    readonly content?: readonly ContentBlock[]
    readonly links?: readonly AspectLink[]
}

/**
 * A bounded unit of content.
 *
 * Three kinds, and the shortness of the list is the design. An `artefact` block naming a renderer,
 * and a `live-example` naming a method to run, are both in the specification and neither is here:
 * nothing serves one yet, and a vocabulary that ships words nobody says is how a small contract
 * becomes a large one without anybody deciding to make it large. They arrive when a provider needs
 * them, with the sandbox and renderer questions answered then rather than guessed at now.
 */
export type ContentBlock =
    | { readonly kind: 'markdown'; readonly id: string; readonly markdown: string; readonly source?: AspectOrigin }
    | { readonly kind: 'code'; readonly id: string; readonly code: string; readonly language?: string; readonly source?: AspectOrigin }
    | { readonly kind: 'attachment'; readonly id: string; readonly label: string; readonly href: string; readonly mediaType?: string; readonly source?: AspectOrigin }

/**
 * A typed edge between two objects.
 *
 * A fact the provider holds, not a hierarchy. A hierarchy is one possible *reading* of a set of
 * these, which is what a aspect is - and the reason relationships and aspects are separate
 * things here rather than one thing with a direction.
 */
export interface Relationship {
    readonly id: string
    readonly from: AspectRef
    readonly to: AspectRef
    /** Namespaced or provider-owned, such as `markdown.in-folder` or `plant.feeds`. */
    readonly kind: string
    readonly label?: string
    readonly origin?: AspectOrigin
}

/**
 * What conventional thing an aspect *is*, when it is one.
 *
 * An `id` is a local name. Two providers written by different people may each offer a "functional"
 * aspect and mean the same thing, or not, and nothing in the name says which - which is fine for a
 * console drawing a tree and useless for anything that has to line two providers up: an OPC UA
 * bridge, an import, an assessment, an MCP client reasoning across peers.
 *
 * So a provider may say what its aspect is in somebody else's vocabulary, and that is deliberately
 * *not* the same field as its own name. IEC 81346's function aspect is a thing with a definition;
 * `functional` is a string a developer typed. Keeping them apart is what lets a provider adopt the
 * convention without renaming its own ids, and lets one decline the convention entirely - which is
 * the more common case and must stay the cheap one.
 *
 * **Nothing here is required, and no scheme is privileged.** This package ships the IEC terms as a
 * convenience because typos are the failure mode, not because an aspect must be one of them.
 *
 * One, not a list. A descriptor claiming three conventional identities is asserting a mapping
 * between vocabularies, and a mapping belongs where mappings are curated and versioned rather than
 * scattered across every provider that happens to have an opinion.
 */
export interface AspectSemantics {
    /** Whose vocabulary: `IEC81346`. Stable, and owned by whoever defines the terms. */
    readonly scheme: string
    /** The term within it: `function`, `product`, `location`, `type`. */
    readonly term: string
}

/**
 * IEC 81346's aspects, spelled once so nobody spells them twice.
 *
 * A convenience and not a constraint: `semantics` takes any scheme, and a provider whose structures
 * are not IEC aspects should say nothing rather than reach for the nearest term. The 2022 edition
 * added `type`, which is the one that is not a structure over individuals - it places an object
 * under the class it belongs to.
 */
export const IEC81346 = {
    scheme: 'IEC81346',
    /** `=` - what it does. */
    function: { scheme: 'IEC81346', term: 'function' },
    /** `-` - what it is part of. */
    product: { scheme: 'IEC81346', term: 'product' },
    /** `+` - where it stands. */
    location: { scheme: 'IEC81346', term: 'location' },
    /** `%` - what kind of thing it is, since the 2022 edition. */
    type: { scheme: 'IEC81346', term: 'type' }
} as const satisfies { scheme: string } & Record<'function' | 'product' | 'location' | 'type', AspectSemantics>

/** Whether two aspects claim the same conventional identity. Unclaimed is never equal to anything. */
export const sameAspectSemantics = (a: AspectSemantics | undefined, b: AspectSemantics | undefined): boolean => !!a && !!b && a.scheme === b.scheme && a.term === b.term

/**
 * A named structure over the objects a provider serves.
 *
 * `revision` changes when the structure does, so a saved location can tell that the tree it was
 * recorded against has been rebuilt - which is why a link stores intent rather than a path.
 */
export interface AspectDescriptor {
    readonly id: string
    readonly label: string
    readonly description?: string
    readonly revision: string
    readonly default?: boolean
    readonly preferredPresentation?: 'tree' | 'list' | 'document'
    /**
     * What this aspect is in a shared vocabulary, when it is anything in one.
     *
     * Absent is the ordinary case and says something true: this is a structure this provider offers,
     * and no claim is made that it is anybody else's. Claiming a term the aspect does not really
     * mean would be worse than claiming nothing, because the field exists precisely so that two
     * providers agreeing can be told from two providers using the same word.
     */
    readonly semantics?: AspectSemantics
    /**
     * Which fields of an occurrence to draw first, when this aspect has an opinion.
     *
     * The aspect is in a better position to say than the base class is: a documentation tree wants
     * the words and the date, a functional one wants the tag, and a generic default that showed the
     * kind put `document.markdown` on every row of a library where every row was one. Absent falls
     * back to something plain.
     */
    readonly defaultColumns?: readonly string[]
}

/**
 * One appearance of something inside one aspect.
 *
 * `occurrenceId` identifies the *placement* and `ref` identifies the object, and an occurrence may
 * have no `ref` at all: a grouping node - "No project", a topic, a workflow state - is real
 * structure that is not an object anybody can open, and giving it a reference would invent an
 * identity for something the provider does not have one for.
 */
export interface Occurrence {
    readonly occurrenceId: string
    readonly ref?: AspectRef
    readonly title: string
    readonly kind: string
    /** Why it is here: the relationship that placed it, where one did. */
    readonly relation?: string
    readonly hasChildren: boolean
    readonly fields?: Readonly<Record<string, unknown>>
}
