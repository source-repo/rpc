import { componentSnapshot, projectionKeyOrder, type RpcComponentData } from './Component.js'
import type { RpcSchema, TypeNode } from './Schema.js'

/**
 * Paging and filtering a collection by *asking*, rather than by subscribing to it.
 *
 * A component whose state carries three hundred tags cannot be browsed through the snapshot: the
 * whole thing is eighty seconds at 1200 baud, and a screen showing fifty rows should cost fifty
 * rows. The projection answers half of that - name the paths, receive those - and stops where the
 * question turns into "which fifty?", because **a record's keys are data, not type**, so a caller
 * cannot name them without first receiving everything.
 *
 * The shape this takes is react-admin's **DataProvider**, deliberately and not by coincidence. It
 * is the interface several hundred backends already implement, so a component that serves it can be
 * browsed by anything that speaks it, and the parts not built here - reference fields resolving ids
 * to values, one-to-many under a record, drop-downs filled from a related resource - arrive as the
 * same verbs pointed at a second resource rather than as features to be designed.
 *
 * **Pull, not push, and that is the decision the rest follows from.** A projection is re-applied per
 * subscriber on every publish, so a predicate living there would make every commit a query on a peer
 * that may be a small computer running a process; and a filtered, paged set is unstable under push,
 * because matches depend on values and values change - one tag going bad-quality enters the match
 * and silently renumbers every row beneath it. A request is answered once, when somebody asks, with
 * a deadline and an `authorize()` check on it. Values stay current because the caller asks again, on
 * a period it chooses - which is also the only rate control a subscriber has on a slow link, since a
 * subscription's rate belongs to the component.
 *
 * What is here is the first cut: `getList` over a record in a component's own state, served from the
 * contract without the author writing anything. `getOne`, `getMany` and the relational verbs come
 * next, and a component that has its own store - a database, a document collection, a queue - serves
 * them itself instead.
 */

/** What a caller may ask for. */
export type RpcDataMethod = 'getList' | 'getOne' | 'getMany' | 'getManyReference' | 'getChildren'

/**
 * What is answered, which is now all of them.
 *
 * The list was for a while shorter than the type above it, and named the difference so a refusal
 * could say what to reach for instead - `shape: 'tree'` was declarable before `getChildren` answered
 * it, and `getOne` was named here for two releases before anything served it. Both seams are closed,
 * and the list stays as a list rather than being folded away: what a resource *declares* it answers
 * is still checked against what this library *can* answer, and the next verb to be named will spend
 * its own while in the gap between the two.
 */
const served: readonly RpcDataMethod[] = ['getList', 'getOne', 'getMany', 'getManyReference', 'getChildren']

/**
 * Rows by id, which is how a foreign key becomes a value.
 *
 * Plural from the start, and that is the whole point of it: a page of fifty rows each naming a
 * customer is fifty lookups, and fifty calls is fifty envelopes and - on MQTT - fifty exchanges.
 * One `getMany` for the page is the same instinct `rpcWrites` and a projection's path list already
 * apply by hand, and it is what a reference field on a grid needs to be affordable at all.
 */
/**
 * One row, by an id a list or a branch already handed out.
 *
 * Not `getMany` with a single id, because a detail view asks a different question. A list answers
 * what a row looks like *among its siblings* - the four fields worth comparing down a column - and
 * this answers what it looks like *on its own*, which for a serial port or a drive is twenty fields
 * nobody wants in a table. The same resource legitimately serves both.
 *
 * Both answers are still governed by the one declared `row`, so a resource whose detail is richer
 * than its rows declares those extra fields **optional** and simply does not populate them in a
 * list. That is a truthful description of what it serves rather than a second type to keep in step
 * with the first, and it means a caller reading the contract can see everything a row may carry.
 */
export interface RpcGetOneParams {
    readonly id: string
}

export interface RpcGetOneResult extends RpcDataTiming {
    /**
     * The row, or **absent when nothing has that id**.
     *
     * Absent rather than an error, for the reason `getMany` leaves missing ids out of its answer: a
     * row can be removed between the list that named it and the click that opened it, and that race
     * is one no caller can avoid. A viewer drawing an error there would be reporting the ordinary
     * passage of time as a fault in the peer.
     */
    readonly data?: unknown
    readonly epoch: string
    readonly revision: number
    readonly stamp?: string
}

export interface RpcGetManyParams {
    readonly ids: readonly string[]
}

/**
 * A bound, because this arrives from the network. Fifty rows referencing fifty distinct customers
 * is the shape it is for; ten thousand ids in one frame is a caller that meant to page instead.
 */
const MAX_GET_MANY_IDS = 1000

/**
 * One branch of a tree, which is the verb `shape: 'tree'` has been naming since it was added.
 *
 * A tree is asked for a branch at a time and never as a whole, and that is the entire point rather
 * than an optimisation: a resource that answers a hierarchy is usually answering something it does
 * not hold - an external workspace, a filesystem, a table joined to itself - and the number of
 * descendants under a node is not knowable before somebody asks. `getList` on such a resource is a
 * question with no bounded answer.
 *
 * So this is `getList` for one parent's children: the same filter, sort and pagination, applied
 * among the children of one node. An absent `parentId` asks for the roots, which is a different
 * question from `parentId: ''` and is why it is optional rather than empty-by-default.
 */
export interface RpcGetChildrenParams extends RpcGetListParams {
    /** Absent means the roots. A branch is identified by the id of the row that is its parent. */
    readonly parentId?: string
}

export interface RpcGetChildrenResult extends RpcGetListResult {
    /**
     * Whether each row is a place to look inside or a thing to list, positionally against `ids`.
     *
     * **Not the same question as `hasChildren`, and the difference is the whole reason this exists.**
     * That one says a node has descendants; this says what the node *is* in the arrangement. A
     * folder is a place. A document is a thing. An OPC UA Object is a place and a Variable is a
     * thing - and a Variable very often has children, because `EngineeringUnits` and `EURange` are
     * properties hanging off it. Reading the first as an answer to the second puts that Variable in
     * the scope tree and takes it out of the table, which is exactly backwards: its properties are
     * what a viewer shows *about* it, not a place to navigate to.
     *
     * The same mistake in the other direction is an empty folder, which has no children and is still
     * not a document.
     *
     * Absent falls back to `hasChildren`, which is what every existing tree meant by it and is right
     * often enough to be a sensible default - but it is a guess, and a resource whose leaves carry
     * properties should say.
     */
    readonly grouping?: readonly boolean[]
    /**
     * Which of these children a viewer should open when this branch is opened, if any.
     *
     * A fact only the node has. A folder of documentation whose first business is its `README` is
     * the case it exists for, and "README" is a convention of that domain rather than of consoles:
     * a viewer that knew the word would be carrying somebody else's filing rule, and would apply it
     * to a rack of serial ports the first time one had a port called readme.
     *
     * Advice, and bounded advice: an id this branch did not answer with is ignored, and a viewer
     * that already has something open leaves it open, because arriving somewhere and having what
     * you were reading replaced is worse than one more click.
     */
    readonly defaultChild?: string
    /**
     * Whether each row has children of its own, positionally against `ids` and `data`.
     *
     * Carried beside the rows rather than merged into them, for the reason `ids` already is: a row
     * may be a primitive, and a row that happened to have a `hasChildren` field would otherwise be
     * quietly overwritten. Two arrays read together is the smaller cost.
     *
     * It is here at all because a viewer has to decide whether to draw an expander *before* anybody
     * asks to expand. Without it the choice is a disclosure arrow on every row, half of which
     * expand to nothing, or a request per row to find out - which is the fan-out this verb exists
     * to avoid.
     */
    readonly hasChildren: readonly boolean[]
}

export interface RpcGetManyResult extends RpcDataTiming {
    /** The ids that were found, in the order they were asked for. */
    readonly ids: readonly string[]
    readonly data: readonly unknown[]
    readonly epoch: string
    readonly revision: number
    readonly stamp?: string
}

/**
 * How long the peer spent answering, in milliseconds.
 *
 * Filled in by the dispatcher rather than by the component, so it is there whoever answered and no
 * implementor has to remember it. It exists for the failure that is otherwise invisible: a request
 * that takes long enough to be noticed looks, from a browser, exactly like a link that has gone -
 * and the one number that tells those apart is how long the *peer* thought it took.
 *
 * Wall time, so it includes waiting on a store as well as work done on the loop. A large number
 * means slow rather than necessarily blocking; `slowRequest` on the server is what names the peer
 * that stalled itself.
 */
/**
 * How long a request may take before the peer says so, unprompted.
 *
 * A quarter of a second is already a visible stall on something that also publishes snapshots, and
 * during development it is the difference between "the console is broken" and "that query is slow".
 * Deliberately not configurable: a threshold somebody has to find and raise is one nobody sets, and
 * this only ever emits an event - it refuses nothing and slows nothing down.
 */
export const SLOW_DATA_REQUEST_MS = 250

export interface RpcDataTiming {
    /** Wall time for the whole request, filled in by the dispatcher whoever served it. */
    readonly ms?: number
    /**
     * The rows, and the count, separately - when the component can tell them apart.
     *
     * They are one number for a record held in memory, because filtering produces the matched set
     * and `total` is its length: the count is a byproduct and costs nothing. They are two very
     * different numbers over a real table, where `LIMIT 50` is answered from an index and
     * `COUNT(*)` over the same predicate walks it - and the second is routinely most of the time.
     *
     * Reported rather than inferred, because the difference decides what to do about it. A slow
     * page wants an index; a fast page behind a slow count wants the count asked for less often, or
     * estimated, or not at all - and nothing can choose between those without seeing which half the
     * time went to. Absent where the split does not exist, which is itself an answer.
     */
    readonly queryMs?: number
    readonly countMs?: number
}

/**
 * What a condition may do. A closed set, and deliberately not an expression.
 *
 * This is evaluated on the peer that holds the data, which may be a small computer with a process
 * attached to it, and it is evaluated again every time somebody asks. A predicate language with an
 * evaluator in it - a regular expression most obviously - hands whoever can reach the console a way
 * to spend that machine's time. The old provider this design came from compiled an operator's search
 * box straight into `new RegExp`, which is safe in a browser against an in-memory store and is a
 * stall on a plant server. So the wire carries facts about a comparison and nothing that runs.
 */
export type RpcFilterOp = 'startsWith' | 'contains' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

const OPS: readonly RpcFilterOp[] = ['startsWith', 'contains', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte']

export interface RpcFilterCondition {
    /**
     * What to compare. `id` is the row's key; a dot path names a field inside the row; absent means
     * the row itself, which is the only thing there is to compare in a record of numbers.
     */
    readonly field?: string
    readonly op: RpcFilterOp
    readonly operand: string | number | boolean | null
}

/** A condition, or all of these, or any of these. Closed, so it can be checked rather than trusted. */
export type RpcFilter = RpcFilterCondition | { readonly all: readonly RpcFilter[] } | { readonly any: readonly RpcFilter[] }

/**
 * Bounds on the shape rather than on the cost, which is the only thing checkable before running it.
 * Deep nesting and a thousand conditions are both a caller holding it wrong, and both are cheaper to
 * refuse than to serve.
 */
const MAX_FILTER_DEPTH = 8
const MAX_FILTER_NODES = 64

export interface RpcSort {
    /** The same naming as a filter's `field`. Absent sorts by id, which is the order keys already have. */
    readonly field?: string
    readonly order?: 'ASC' | 'DESC'
}

export interface RpcGetListParams {
    /**
     * Zero-based, so `page * pageSize` needs no adjustment anywhere. Absent means the whole
     * collection, which is the right default for a small one and is what a caller with no pager
     * means; the console always sends it.
     */
    readonly pagination?: { readonly page?: number; readonly pageSize?: number }
    /**
     * Applied before the page is cut, which is the entire point: **a filter matching nothing
     * transfers nothing.** No amount of client-side filtering can have that property, because
     * finding out that nothing matched is exactly what it has to receive everything to discover.
     */
    readonly filter?: RpcFilter
    /** Applied to the filtered set, before paging - an order over the page alone would mean nothing. */
    readonly sort?: RpcSort
    /**
     * Only rows beneath this branch of a `shape: 'tree'` resource, at any depth.
     *
     * The scoping half of a tree, and the reason it is a parameter here rather than a verb of its
     * own: what a reader wants under a branch is a *list* - filtered, sorted, paged - and every one
     * of those already belongs to `getList`. Scoping it is one more condition, applied before the
     * page is cut, exactly as `filter` is.
     *
     * **Answered by the node and never by a viewer walking.** `getChildren` is a branch at a time
     * because the number of descendants is not knowable before somebody asks; a viewer collecting
     * leaves itself would be that walk, done in the one place with the least idea what it costs. A
     * node knows: a table does it with a predicate on a path, and a browsing protocol does it by
     * walking until the page is full and stopping.
     *
     * Which is why `total` may be absent here even where a flat list would have known it - the count
     * of what is under a node can cost the whole walk when the page cost a corner of it. `hasMore`
     * is the half that matters and the half that stays cheap.
     *
     * Absent asks the resource for everything it holds, which is what `getList` has always meant.
     */
    readonly under?: string
}

/**
 * The rows of one resource that point at one row of another: the orders of this customer, the
 * readings of this tag.
 *
 * A list with one condition already applied, which is exactly how it is served - `target` and `id`
 * become an `eq` on the filter, and everything else about paging, ordering and filtering is the
 * list's. That is the claim the whole DataProvider shape was taken for, arriving as almost no code:
 * one-to-many is not a new mechanism, it is `getList` pointed at a second resource with the join
 * already in hand.
 */
export interface RpcGetManyReferenceParams extends RpcGetListParams {
    /** The field of *this* resource that names the other row - a foreign key, by whatever name. */
    readonly target: string
    /** What that field must equal. */
    readonly id: string | number
}

export interface RpcGetListResult extends RpcDataTiming {
    /** The rows of this page, in key order. */
    readonly data: readonly unknown[]
    /**
     * The id of each row, positionally. Carried beside the rows rather than merged into them,
     * because a row may be a primitive - a record of numbers is a perfectly good resource - and
     * because a row that already had an `id` field would otherwise be quietly overwritten.
     */
    readonly ids: readonly string[]
    /**
     * How many rows **match**, which with no filter is how many the resource holds. That is what a
     * pager needs and what "3 of 47" means: the count of the set this page was cut from, not the
     * size of the collection behind it.
     *
     * Reported where it is known, because it is the only thing a caller cannot work out for itself.
     *
     * **Optional, and absent means unknown rather than zero.** A record held in memory produces the
     * matched set and this is its length - a byproduct that costs nothing, so the library-served
     * path always supplies it. Over a table they are two different questions: `LIMIT 50` is answered
     * from an index and `COUNT(*)` over the same predicate walks it, routinely most of the request.
     * react-admin carries `pageInfo.hasNextPage` instead for exactly that reason.
     *
     * Absent rather than zero, and the difference is not stylistic. `total: 0` alongside `hasMore`
     * reads unambiguously almost everywhere - a genuinely empty set has neither rows nor more - but
     * it runs out of room when a caller pages past the end: no rows, nothing beyond, count zero is
     * exactly what an empty collection answers, and a console would render "no rows match" over a
     * filter that matched sixty. Absent says unknown in that case and in every other one.
     */
    readonly total?: number
    /**
     * Whether anything follows this page - the cheap half of the count.
     *
     * The one fact a pager actually needs to draw a "next" control, and the one a store can answer
     * without walking the predicate: ask for one row more than the page and see whether it arrives.
     * Reported alongside `total` rather than instead of it, so a resource that can afford both says
     * both, and a caller can show "3 of 47" where it is known and a next arrow where it is not.
     *
     * Absent means the answer was not computed, which a caller should read as "no idea" rather than
     * as "no". Where `total` is present, `hasMore` adds nothing and may be left off.
     */
    readonly hasMore?: boolean
    /** Which epoch and revision this page was drawn from, so a caller can tell a restart from an update. */
    readonly epoch: string
    readonly revision: number
    /**
     * A name for the state of the whole resource, where the node can speak for one.
     *
     * Two answers carrying the same stamp describe the same state, as far as **writes this node
     * served** are concerned. That qualification is the whole of it and is not a caveat to be
     * skimmed: a table changed by another service, a scheduled job or a person at a SQL prompt moves
     * underneath this without it noticing, so a caller must read a matching stamp as *nothing I did
     * changed it* rather than as *nothing changed it*.
     *
     * **Absent means the node does not speak for this resource**, which is the ordinary case: a
     * record in `props` or `state` has the component's own revision instead and needs nothing here,
     * and a read-only table has nobody who could move a stamp. Absent is deliberately the default,
     * because a stamp that does not move when the data moves is worse than no stamp at all.
     *
     * **Not ordered.** Two stamps are equal or they are not; neither is newer. See
     * `RpcResourceStamps`, and note what the epoch and revision above still do *not* cover for a
     * declared resource - they are the component's, and the store-backed nodes move them on reads.
     */
    readonly stamp?: string
}

/**
 * Where a resource lives: a path from `props` or `state`, spelled as every other path here is.
 *
 * A component's own state is addressed the way `sets` and a projection address it, so nothing new
 * has to be learned to name one. A component serving an external store publishes resource names
 * instead, and those arrive here as a single-segment path.
 */
export type RpcResource = readonly string[]

/**
 * One collection a component serves that its contract cannot describe.
 *
 * A record in `props` or `state` needs none of this: it is in the published type, so a viewer finds
 * it by reading the contract and addresses it by the path it already has. This is for the other
 * kind - a table, a document collection, a queue - where **what resources exist is itself data**.
 * A database's tables are not known when the component is written, so they cannot be extracted from
 * source and have to be said at runtime.
 *
 * Which is the same boundary as everywhere else here, one level up: the contract knows a component
 * *serves* collections, and only the component knows which. So a viewer draws the scope tree from
 * the contract and this list together, and neither is guessed from the other.
 */
/**
 * One of the component's own methods, said to apply to a row of this resource.
 *
 * It adds no capability whatsoever. The method is an ordinary `@rpc` method that already exists,
 * already appears in `describe()`, and is already ruled on by `authorize()`, the owner fence and
 * idempotency. What this carries is the one fact a viewer cannot work out for itself: *which*
 * existing method belongs to *which* row - exactly what `sets` does for a field, one level up.
 *
 * Which is what keeps the rule intact: a value is still never written, a method is still called.
 */
export interface RpcDataAction {
    /** The method to call, by the name `describe()` publishes. */
    readonly method: string
    /** What to put on the button. The method name where there is nothing better. */
    readonly label?: string
    /**
     * Whether the component considers this destructive enough to ask first.
     *
     * The author's to say, not the viewer's to guess. A console inferring it from the word
     * "discard" would be guessing about a plant, and would be wrong the first time somebody named
     * a method `archive`.
     */
    readonly confirm?: boolean
    /**
     * Which rows this method is about, where the resource's rows are not all the same kind of thing.
     *
     * A flat list has no such problem: every row of it is the same shape, so an action about one is
     * about all of them. A **tree** is different. A rack whose branches are cabinets and whose
     * leaves are ports has one `resetPort`, and it is about the ports - offering it on a cabinet is
     * offering a button that throws, which an operator learns by pressing it.
     *
     * Absent means **leaves**, and that default is chosen rather than convenient. It changes nothing
     * for a list, whose rows have no children and are therefore all leaves; and for a tree it is the
     * safe half, because the failure it prevents is a command offered against the wrong kind of
     * thing. A node whose branches really are actionable - restart this hub, archive this folder -
     * says so, and saying so is the author's claim rather than the viewer's inference. The same rule
     * `confirm` follows one field up.
     */
    readonly appliesTo?: 'leaves' | 'branches' | 'all'
}

export interface RpcDataPresentationHint {
    /**
     * Dot paths into the declared row type, in the order they should first appear.
     *
     * A path the row type does not have is ignored rather than refused, and said so at describe
     * time: this is advice about presentation, and a node that will not start because somebody
     * renamed a field in a hint is a worse failure than a table that opens on a sensible default.
     * Every schema-derived column stays selectable whatever is named here - this decides what is
     * shown first, never what may be shown.
     */
    readonly defaultColumns?: readonly string[]
}

export interface RpcDataResource {
    /** How `$data` names it. A single segment for a resource of its own, never `props` or `state`. */
    readonly path: RpcResource
    /** The shape of one row, so a viewer can draw columns for a table it has never heard of. */
    readonly row?: TypeNode
    /** Which verbs it answers. A viewer offers what is here and nothing else. */
    readonly verbs: readonly RpcDataMethod[]
    /**
     * Whether rows are a flat list or a hierarchy.
     *
     * A tree is fetched a branch at a time, with `getChildren`, and a resource that declares this
     * shape is saying it will answer that verb rather than that it happens to be long. It was named
     * here before it was served, so that a resource which is one could say so; it is served now,
     * and the declaration is what a viewer reads to decide whether to draw a tree at all.
     */
    readonly shape?: 'list' | 'tree'
    /** What to call it on a screen, where the path is not what a person would read. */
    readonly label?: string
    /**
     * Which columns to draw first, and nothing else about how to draw them.
     *
     * The *possible* columns already follow from `row`, and a second declaration of them would be a
     * second thing to keep in step with the schema - so this does not restate them. What the schema
     * cannot say is which four of a table's forty a person wants to see before they have chosen
     * anything, and that is a judgement the resource is in a position to make and a viewer is not.
     *
     * Deliberately not a UI. No widths, no colours, no component names, no order beyond this one:
     * those are preferences and belong to whoever is looking, not to the node. A hint that grew
     * those fields would be a layout engine delivered over the wire, which is the thing this whole
     * surface is arranged to avoid.
     */
    readonly presentation?: RpcDataPresentationHint
    /**
     * What can be done to a row, as methods this component already declares.
     *
     * Each is called with the row's id and nothing else - `retryDeadLetter(taskId)` is the shape
     * every real case has so far, and anything richer is a form rather than an action.
     */
    readonly actions?: readonly RpcDataAction[]
}

/**
 * A component that serves collections of its own, rather than only the records in its state.
 *
 * Implementing this is what Source Relational, Source Document and Source Queue do; an ordinary
 * component implements nothing and still answers `getList` over any record it holds, because the
 * base class serves that from the contract.
 */
export interface RpcDataResources {
    /** What this component serves. Read at describe time, so it may change as the store does. */
    dataResources(): readonly RpcDataResource[]
    /**
     * Answer one request against one of them. Reached only for a path `dataResources()` named, and
     * only for a verb that resource claimed.
     *
     * Shaped like the wire verb rather than one method per verb, for the reason `$data` is: adding
     * `getManyReference` is then a value a component already switches on rather than a method every
     * implementor has to grow.
     *
     * The reference params are named here as well as the other two, because the dispatcher passes
     * exactly those for `getManyReference` - and a union that omitted them made an implementor
     * narrow a parameter its caller had already widened, which every implementation resolved with
     * a cast that hid the one field the verb is about.
     */
    dataRequest(
        method: RpcDataMethod,
        resource: RpcResource,
        params: RpcGetListParams | RpcGetOneParams | RpcGetManyParams | RpcGetManyReferenceParams | RpcGetChildrenParams
    ): unknown | Promise<unknown>
}

/**
 * Whether a component serves resources of its own.
 *
 * Both methods are required together on purpose: a component that listed resources and could not
 * answer for them would publish a table that renders as a permanent error, and one that answered
 * for resources it never listed could not be found at all.
 */
export const servesDataResources = (instance: object): instance is RpcDataResources =>
    typeof (instance as RpcDataResources).dataResources === 'function' && typeof (instance as RpcDataResources).dataRequest === 'function'

/** The declared resource a path names, if any. Paths into the component's own state match nothing. */
export const declaredResource = (instance: object, resource: RpcResource): RpcDataResource | undefined =>
    servesDataResources(instance)
        ? instance.dataResources().find((declared) => declared.path.length === resource.length && declared.path.every((segment, at) => segment === resource[at]))
        : undefined

/**
 * Check the request before it is served, refusing rather than clamping.
 *
 * A negative or fractional page is a caller holding it wrong, and quietly reading it as zero
 * produces a page nobody asked for with no way to notice - the same judgement the projection slice
 * makes about its bounds, and for the same reason.
 *
 * A `pageSize` of zero is deliberately **allowed**: it asks for no rows and answers the total, which
 * is how a caller learns the number of pages before deciding to fetch any. That costs one number
 * rather than a record, and it is worth having as a stated feature rather than as something that
 * happens to fall out of the arithmetic.
 */
export const readDataRequest = (method: unknown, resource: unknown, params: unknown): Error | { method: RpcDataMethod; resource: RpcResource; params: RpcGetListParams | RpcGetOneParams } => {
    if (typeof method !== 'string' || !served.includes(method as RpcDataMethod))
        return new Error(`$data: ${String(method)} is not served here - this component answers ${served.join(', ')}`)
    if (!Array.isArray(resource) || !resource.length || !resource.every((segment) => typeof segment === 'string'))
        return new Error('$data: a resource is a non-empty path of string segments, such as ["state","tags"]')
    const given = (params ?? {}) as RpcGetListParams & RpcGetManyParams
    if (typeof given !== 'object') return new Error('$data: params is an object, or absent')
    if (method === 'getMany') {
        if (!Array.isArray(given.ids) || !given.ids.length || !given.ids.every((id) => typeof id === 'string'))
            return new Error('$data: getMany takes a non-empty array of string ids')
        if (given.ids.length > MAX_GET_MANY_IDS) return new Error(`$data: getMany is bounded at ${MAX_GET_MANY_IDS} ids; ask for a page instead`)
        return { method: method as RpcDataMethod, resource: resource as RpcResource, params: given }
    }
    if (method === 'getOne') {
        const one = given as unknown as RpcGetOneParams
        if (typeof one.id !== 'string' || !one.id) return new Error('$data: getOne takes a non-empty string id')
        return { method: method as RpcDataMethod, resource: resource as RpcResource, params: one }
    }
    if (given.under !== undefined && (typeof given.under !== 'string' || !given.under))
        return new Error('$data: under is the non-empty id of a branch, or absent for the whole resource')
    if (method === 'getChildren') {
        const branch = given as unknown as RpcGetChildrenParams
        // Checked rather than coerced, as everything else here is: a parentId that arrived as a
        // number is a caller that built the request wrongly, and answering the roots instead would
        // look exactly like a node that genuinely has no children.
        if (branch.parentId !== undefined && (typeof branch.parentId !== 'string' || !branch.parentId))
            return new Error('$data: getChildren takes a non-empty string parentId, or none at all for the roots')
    }
    if (method === 'getManyReference') {
        const reference = given as unknown as RpcGetManyReferenceParams
        if (typeof reference.target !== 'string' || !reference.target) return new Error('$data: getManyReference needs a target field to match on')
        if (typeof reference.id !== 'string' && typeof reference.id !== 'number') return new Error('$data: getManyReference needs an id, as a string or a number')
    }
    const pagination = given.pagination
    if (pagination !== undefined) {
        if (typeof pagination !== 'object' || pagination === null) return new Error('$data: pagination is { page, pageSize }')
        for (const [name, value] of [
            ['page', pagination.page],
            ['pageSize', pagination.pageSize]
        ] as const)
            if (value !== undefined && (!Number.isInteger(value) || value < 0)) return new Error(`$data: pagination.${name} must be a non-negative integer, not ${String(value)}`)
        // A page number means nothing without a page to measure it in, and answering the whole
        // collection to something that asked for page 2 is the failure this exists to prevent.
        if (pagination.page !== undefined && pagination.pageSize === undefined) return new Error('$data: pagination.page needs a pageSize - a page number alone does not say how big a page is')
    }
    if (given.filter !== undefined) {
        const bad = readFilter(given.filter, 1, { nodes: 0 })
        if (bad) return bad
    }
    if (given.sort !== undefined) {
        const sort = given.sort
        if (typeof sort !== 'object' || sort === null) return new Error('$data: sort is { field, order }')
        if (sort.field !== undefined && (typeof sort.field !== 'string' || !sort.field)) return new Error('$data: sort.field is a non-empty string, or absent for the id')
        if (sort.order !== undefined && sort.order !== 'ASC' && sort.order !== 'DESC') return new Error(`$data: sort.order is ASC or DESC, not ${String(sort.order)}`)
    }
    return { method: method as RpcDataMethod, resource: resource as RpcResource, params: given }
}

/**
 * Whether a dot path names something the row type actually has.
 *
 * Follows `ref` into the named types, looks through `union` - a field present in any branch counts,
 * since a row of one shape or another still has it - and gives up in favour of the caller on `any`
 * and on `record`, whose keys are not known in advance and where a path can only be checked against
 * a value nobody has yet.
 */
const pathInType = (path: readonly string[], type: TypeNode | undefined, types: RpcSchema['types'] | undefined, depth = 0): boolean => {
    if (!type || depth > 12) return true
    if (!path.length) return true
    if (type.kind === 'any' || type.kind === 'record') return true
    if (type.kind === 'ref') return pathInType(path, types?.[type.name], types, depth + 1)
    if (type.kind === 'union') return type.options.some((option) => pathInType(path, option, types, depth + 1))
    if (type.kind === 'array') return pathInType(path, type.items, types, depth + 1)
    if (type.kind !== 'object') return false
    const field = type.fields[path[0]]
    if (field) return pathInType(path.slice(1), field.type, types, depth + 1)
    // A row that admits fields it did not name cannot be said to be missing one. An aspect provider
    // is the case: an occurrence carries whatever fields the arrangement puts on it - a value, a
    // node class, a path - and those vary per provider, so the row declares the five it always has
    // and `additional` for the rest. Without this the columns it advertises are each reported as a
    // mistake, which is the opposite of what the warning is for.
    return type.additional === true
}

/** Said once per resource and path, since describe() reads resources fresh every time it is asked. */
const warnedColumns = new Set<string>()

/**
 * Say when `defaultColumns` names a field the row type does not have.
 *
 * Ignored rather than refused, for the reason the hint's own comment gives - a node that will not
 * start because somebody renamed a field in a preference is a worse failure than a table opening on
 * a default. But not silently: a column that quietly stopped appearing after a rename is exactly the
 * kind of thing nobody notices, and the alternative to a line on stderr is somebody reading this
 * file to find out why their column went away.
 *
 * A resource with no declared `row` is left alone. There is nothing to check the path against, and
 * warning about every column of an undescribed row would train people to ignore this.
 */
export const describedResources = (instance: unknown, owner: string, types?: RpcSchema['types']): readonly RpcDataResource[] => {
    const resources = (instance as RpcDataResources).dataResources()
    for (const resource of resources) checkPresentation(owner, resource, types)
    return resources
}

const checkPresentation = (owner: string, resource: RpcDataResource, types?: RpcSchema['types']): void => {
    const columns = resource.presentation?.defaultColumns
    if (!columns?.length || !resource.row) return
    for (const column of columns) {
        if (pathInType(column.split('.'), resource.row, types)) continue
        const key = `${owner}\u0000${resource.path.join('.')}\u0000${column}`
        if (warnedColumns.has(key)) continue
        warnedColumns.add(key)
        console.warn(
            `source-rpc: ${owner}.${resource.path.join('.')} names '${column}' in presentation.defaultColumns, ` +
                'which its declared row type does not have. The column is ignored; every other field of the row is still selectable.'
        )
    }
}

/**
 * Check a filter, all the way down, before any of it runs.
 *
 * Checked rather than coerced, for the same reason the bounds are: an operand that arrived as an
 * object is a caller that built its query wrongly, and quietly comparing it to everything and
 * matching nothing looks exactly like a filter that worked and found no rows.
 */
const readFilter = (filter: unknown, depth: number, count: { nodes: number }): Error | undefined => {
    if (depth > MAX_FILTER_DEPTH) return new Error(`$data: a filter nested deeper than ${MAX_FILTER_DEPTH} is refused`)
    if (++count.nodes > MAX_FILTER_NODES) return new Error(`$data: a filter of more than ${MAX_FILTER_NODES} conditions is refused`)
    if (typeof filter !== 'object' || filter === null) return new Error('$data: a filter is a condition, or { all: [...] }, or { any: [...] }')
    const group = filter as { all?: unknown; any?: unknown }
    for (const key of ['all', 'any'] as const) {
        if (group[key] === undefined) continue
        if (!Array.isArray(group[key]) || !group[key].length) return new Error(`$data: ${key} is a non-empty array of filters`)
        for (const inner of group[key] as unknown[]) {
            const bad = readFilter(inner, depth + 1, count)
            if (bad) return bad
        }
        return undefined
    }
    const condition = filter as RpcFilterCondition
    if (!OPS.includes(condition.op)) return new Error(`$data: ${String(condition.op)} is not a comparison - one of ${OPS.join(', ')}`)
    if (condition.field !== undefined && (typeof condition.field !== 'string' || !condition.field))
        return new Error('$data: a condition field is a non-empty string, or absent to compare the row itself')
    const operand = condition.operand
    if (operand !== null && typeof operand !== 'string' && typeof operand !== 'number' && typeof operand !== 'boolean')
        return new Error('$data: an operand is a string, number, boolean or null')
    return undefined
}

/** Walk to whatever a path names, or undefined where it reaches nothing. */
const resolvePath = (from: RpcComponentData, path: readonly string[]): unknown => {
    let at: unknown = from
    for (const step of path) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as { [key: string]: unknown })[step]
    }
    return at
}

/**
 * The collection a resource names, or nothing.
 *
 * A path reaching something that is not a plain object answers an **empty list** rather than an
 * error, which follows the rule the projection already set: state is data, and a record a caller
 * expects may simply not have been populated yet. Refusing the request because a collection is
 * currently absent would make this less robust than the whole snapshot it replaces. A caller that
 * named the wrong path sees `total: 0`, which reads as an empty table rather than as data lost.
 */
const collectionAt = (snapshot: { props: RpcComponentData; state: RpcComponentData }, resource: RpcResource): RpcComponentData | undefined => {
    const [root, ...rest] = resource
    const from = root === 'props' ? snapshot.props : root === 'state' ? snapshot.state : undefined
    if (!from) return undefined
    const at = resolvePath(from, rest)
    return at !== null && typeof at === 'object' && !Array.isArray(at) ? (at as RpcComponentData) : undefined
}

/**
 * What a condition compares: the key, a field inside the row, or the row itself.
 *
 * A record of numbers has no fields at all, and filtering one is a perfectly ordinary thing to want,
 * so an absent `field` compares the row - which is the only reading that makes sense and the only
 * one that leaves such a collection filterable.
 */
const fieldOf = (row: unknown, id: string, field?: string): unknown => {
    if (field === undefined) return row
    if (field === 'id') return id
    let at: unknown = row
    for (const step of field.split('.')) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as { [key: string]: unknown })[step]
    }
    return at
}

/**
 * Whether one value satisfies one condition.
 *
 * A field that is not there never matches, rather than matching as `undefined` - "quality contains
 * bad" must not be true of a row that has no quality, and stringifying an absent value would make
 * `contains: 'undef'` find every one of them. `ne` is the deliberate exception: a row that lacks the
 * field is genuinely not equal to what was named, and an operator asking for "not bad" means to see
 * the rows that never reported a quality at all.
 *
 * Ordered comparisons need both sides to be the same kind of thing. Numbers compare numerically and
 * strings lexicographically; anything else answers false rather than inventing an order, because
 * `20 > '9'` having an answer at all is how a threshold silently stops working.
 */
const satisfies = (value: unknown, { op, operand }: RpcFilterCondition): boolean => {
    if (op === 'ne') return value !== operand
    if (value === undefined) return false
    switch (op) {
        case 'eq':
            return value === operand
        case 'startsWith':
        case 'contains': {
            const text = typeof value === 'string' ? value : String(value)
            const needle = String(operand)
            return op === 'startsWith' ? text.startsWith(needle) : text.includes(needle)
        }
        default: {
            const comparable = (typeof value === 'number' && typeof operand === 'number') || (typeof value === 'string' && typeof operand === 'string')
            if (!comparable) return false
            const order = value < operand ? -1 : value > operand ? 1 : 0
            return op === 'lt' ? order < 0 : op === 'lte' ? order <= 0 : op === 'gt' ? order > 0 : order >= 0
        }
    }
}

/**
 * Whether one row satisfies a filter.
 *
 * Exported because a caller may hold part of a set already and have no reason to ask for it. The
 * console is the case: a component's typed leaves are bounded by the contract, so it subscribes to
 * them and filters them here, while the record beside them is paged and filtered on the peer. Those
 * are one search box to whoever is reading the screen, and a search that meant two different things
 * either side of the same pane would be worse than no search at all - so both ends call this rather
 * than each having a version of it.
 */
export const matchesFilter = (filter: RpcFilter, row: unknown, id: string): boolean => {
    const group = filter as { all?: readonly RpcFilter[]; any?: readonly RpcFilter[] }
    if (group.all) return group.all.every((inner) => matchesFilter(inner, row, id))
    if (group.any) return group.any.some((inner) => matchesFilter(inner, row, id))
    const condition = filter as RpcFilterCondition
    return satisfies(fieldOf(row, id, condition.field), condition)
}

/** Undefined sorts last in both directions: "no reading" is not the smallest reading. */
const compare = (a: unknown, b: unknown): number => {
    if (a === b) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * One page of a collection, with the count that tells a caller how many matched.
 *
 * **Filter, then order, then cut the page** - in that order, and none of them is interchangeable. A
 * filter applied after paging would be a filter over fifty rows pretending to be one over three
 * hundred; an order applied to the page alone would be an order over nothing.
 *
 * Which is also where the whole design earns itself: the filter runs where the data is, so a search
 * that matches nothing sends nothing. No amount of client-side filtering can do that, because
 * discovering that nothing matched is exactly what it must receive everything to find out.
 *
 * Keys are sorted, contractually, for the reason `projectionKeyOrder` exists: insertion order is a
 * property of how the component happened to build its state, so after a restart page 2 could hold
 * something else entirely and a paging caller would see one entry twice and another never, with
 * nothing to indicate it. A named sort replaces that order and is stable within it - ties keep key
 * order - so paging stays coherent when half the rows report the same quality.
 *
 * A page past the end answers empty with the true total. That sits beside the refusal of a negative
 * page above and only looks inconsistent: a malformed bound is a caller holding it wrong, while a
 * page that has run off the end is a **race the caller cannot avoid** - the set is data, and a page
 * that was valid when the operator clicked may be past the end by the time the request lands.
 * Erroring on that would make a link fail more the slower it got. A filter makes that ordinary
 * rather than exotic: typing one more letter can empty a page the operator was reading.
 *
 * A store-backed component should do all of this as a query. In particular a `startsWith` on `id`
 * over sorted keys is a contiguous range rather than a scan, which is what makes this affordable on
 * something larger than a record held in memory.
 */
/**
 * The rows of this resource that point at one row of another.
 *
 * Served as `getList` with the reference `and`ed onto whatever filter the caller sent, rather than
 * as a second implementation: paging, ordering, the count of matches and the treatment of a page
 * past the end are then identical by construction rather than by having been written twice the same
 * way. `total` is the count of *referencing* rows, which is what a pager under a record needs.
 */
export const getManyReference = (component: object, resource: RpcResource, params: RpcGetManyReferenceParams): RpcGetListResult => {
    const reference: RpcFilter = { field: params.target, op: 'eq', operand: params.id }
    return getList(component, resource, { ...params, filter: params.filter ? { all: [reference, params.filter] } : reference })
}

/**
 * The rows a caller already knows the ids of.
 *
 * Ids that reach nothing are **absent from the answer** rather than filled with a null, so a caller
 * can tell "this row is gone" from "this row has no value", which on a plant are different facts and
 * one of them means a reference is dangling. Answered in the order asked, so a caller pairing rows
 * back to the fields that named them does not have to sort them itself.
 *
 * There is no `total`: a caller that named the ids knows how many it asked for, and how many came
 * back is `ids.length`. Nothing here is a page, so nothing here has a count of pages.
 */
/**
 * One row of a record the component holds, by key.
 *
 * Served here as well as by declared resources, because a component's own record is a collection
 * like any other and a caller that can list it should be able to open a row of it. It is `getMany`
 * with one id and the answer unwrapped - written out rather than delegated so that "absent means no
 * such row" is visible in the shape of this function rather than inferred from an empty array.
 */
export const getOne = (component: object, resource: RpcResource, params: RpcGetOneParams): RpcGetOneResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const held = Object.prototype.hasOwnProperty.call(collection, params.id)
    // Spread rather than `data: undefined`, so an absent row is a key that is not there. A frame
    // carrying `data: undefined` says the same thing in JSON and something else in a format that
    // encodes fields positionally.
    return { ...(held ? { data: collection[params.id] } : {}), epoch: snapshot.epoch, revision: snapshot.revision }
}

export const getMany = (component: object, resource: RpcResource, params: RpcGetManyParams): RpcGetManyResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const found = params.ids.filter((id) => Object.prototype.hasOwnProperty.call(collection, id))
    return { ids: found, data: found.map((id) => collection[id]), epoch: snapshot.epoch, revision: snapshot.revision }
}

export const getList = (component: object, resource: RpcResource, params: RpcGetListParams): RpcGetListResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    return {
        ...pageEntries(
            projectionKeyOrder(collection).map((id) => [id, collection[id]] as const),
            params
        ),
        epoch: snapshot.epoch,
        revision: snapshot.revision
    }
}

/**
 * Filter, order and cut a page out of rows a caller already holds.
 *
 * Exported for the component that fetched its rows from somewhere else - a table, a queue, a file -
 * and now has to answer the same question about them. Sharing this rather than each store
 * reimplementing it is the same argument as `matchesFilter`: a `getList` that meant something
 * slightly different depending on which component answered it would be worse than one that was
 * missing, because nothing would show which of the two you were looking at.
 *
 * **Order matters and none of the three is interchangeable.** A filter applied after paging would be
 * a filter over fifty rows pretending to be one over three hundred; an order applied to the page
 * alone would be an order over nothing.
 *
 * Note what this does *not* promise. The wire carries only matches - that is what the pull is for -
 * but whether the peer could push the filter down into its store, or had to read the rows and then
 * discard most of them, is the store's business and invisible from here. A component over a real
 * database should do this as a query; one over a bounded in-memory backlog is right to read it and
 * hand it here.
 */
export const pageEntries = (
    entries: readonly (readonly [string, unknown])[],
    params: RpcGetListParams
): { ids: string[]; data: unknown[]; total: number; hasMore: boolean } => {
    const rows = new Map(entries)
    const keys = entries.map(([id]) => id)
    const matched = params.filter ? keys.filter((id) => matchesFilter(params.filter as RpcFilter, rows.get(id), id)) : keys
    const ordered = params.sort
        ? [...matched].sort((a, b) => {
              const by = compare(fieldOf(rows.get(a), a, params.sort?.field), fieldOf(rows.get(b), b, params.sort?.field))
              // Ties fall back to key order, so a sort on a field half the rows share does not
              // shuffle between requests and hand the operator the same row on two pages.
              return (by || compare(a, b)) * (params.sort?.order === 'DESC' ? -1 : 1)
          })
        : matched
    const { page = 0, pageSize } = params.pagination ?? {}
    const from = page * (pageSize ?? 0)
    const ids = pageSize === undefined ? ordered : ordered.slice(from, from + pageSize)
    // Both, always, because this path already holds the matched set: the count is a byproduct and
    // `hasMore` is arithmetic over it. A caller that only understands one of the two is right either
    // way, which is what makes this the reference a store-backed implementation is checked against.
    return { ids, data: ids.map((id) => rows.get(id)), total: ordered.length, hasMore: from + ids.length < ordered.length }
}
