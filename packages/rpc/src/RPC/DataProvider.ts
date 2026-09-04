import { componentSnapshot, projectionKeyOrder, type RpcComponentData } from './Component.js'
import type { RpcWritableResource, RpcWriteVerb } from './DataWrites.js'
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
 * `props` and `state` are built-in tree resources served without the author writing anything. A
 * component that has its own store - a database, document collection or queue - appends resources
 * and serves those itself.
 */

/** What a caller may ask for. */
export type RpcDataMethod = 'getList' | 'getOne' | 'getMany' | 'getManyReference' | 'getChildren'

/**
 * Everything a resource can be asked to do, reading and writing, in one vocabulary.
 *
 * The two surfaces stay apart on the wire and should: `$data` reads and is repeatable by
 * construction, `$write` carries a precondition and answers `ok | missing | conflict`. What had no
 * reason to stay apart was the **declaration**. A resource used to say what it read in
 * `RpcDataResource.verbs` and what it wrote somewhere else entirely - a separate `<namespace>.write`
 * instance answering `writable()` - so "what can I do with this?" was two questions, of two shapes,
 * over two round trips, joined by the caller.
 *
 * That join was also lossy, and the loss is the argument. A write surface named a resource by a
 * single string where `$data` addresses it by a path, so the two agreed only for resources one
 * segment deep: anything under `props` or `state`, or any resource nested deeper, could not be
 * described as writable at all - not refused, just unsayable. One vocabulary over one address ends
 * that by construction rather than by widening the join.
 */
export type RpcResourceVerb = RpcDataMethod | RpcWriteVerb

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
    /**
     * Compare without regard to case. Only on `startsWith` and `contains`, and off by default.
     *
     * **A filter is case-sensitive because a filter has to be.** `borg` and `Borg AB` are different
     * rows, the conformance fixture keeps them apart on purpose, and the three SQL flavours go to
     * some trouble to force a binary collation so that a query means the same thing on each - a
     * default that folded case would silently change what a condition selects depending on how a
     * database happened to be created.
     *
     * A **search box** wants the opposite, and it is not a preference: somebody typing `acme` means
     * `Acme Ltd`, and a search that answers "nothing of that name" because they used the wrong
     * capital is a search nobody can use. That is a real requirement, so it is asked for explicitly
     * rather than guessed from context - the caller says which of the two they meant, and the
     * condition still says the same thing wherever it is evaluated.
     *
     * Refused on the ordering operators rather than ignored there. "Case-insensitively less than"
     * is a collation question and not a comparison, and this library has been careful enough about
     * collations not to answer one by accident.
     */
    readonly fold?: boolean
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
    /**
     * Whether to descend, or to answer one level.
     *
     * `under` says *where* and this says *how deep*, and keeping them apart is what collapses two
     * verbs into one. The four combinations are the whole of what a hierarchy can be asked:
     *
     * | `under` | `recursive` | asks for |
     * | - | - | - |
     * | absent | `false` | the roots |
     * | a branch | `false` | the children of that branch |
     * | absent | `true` | everything the resource holds, at any depth |
     * | a branch | `true` | everything beneath that branch |
     *
     * The second row is `getChildren`, which is why that verb is now the `recursive: false` corner
     * of this one rather than a thing of its own. It stays on the wire - a caller that has been
     * asking for a branch at a time is not wrong and does not have to change - but nothing new needs
     * it, and a resource that can be browsed can now be browsed by the verb that also filters, sorts
     * and pages.
     *
     * **Opt in, and that is a change of default.** `getList` on a tree used to descend always, so a
     * caller that asked a four-hundred-node address space for a page got the whole depth of it
     * flattened; now that is a thing somebody asks for. The expensive answer should be the one with
     * a word in the request, not the one you get by not knowing to say otherwise.
     *
     * On a resource with no hierarchy this is **already true rather than meaningless**, so it is
     * ignored rather than refused - every row of a flat list is one level down, whichever way the
     * flag points. That is the opposite of `fold` on an ordering comparison, which is refused
     * because honouring it would mean something the caller cannot have meant.
     */
    readonly recursive?: boolean
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
    /**
     * Which *kinds* of row this is about, where a resource's rows are not one kind of thing.
     *
     * `appliesTo` answers a question about position - is this row a place or a thing - and that is
     * not the same question as what the thing *is*. An OPC UA address space lists Variables and
     * Methods side by side and both are leaves: `write` is about the first and would throw on the
     * second, and a button that throws is one an operator finds by pressing it.
     *
     * Matched against the row's own `kind`, which is where a provider already says what a row is.
     * Absent means every row `appliesTo` allows, which is what a resource of one kind wants and
     * changes nothing for the resources that had no `kind` to begin with. Declared but with no
     * `kind` on the row, the action is **not** offered - the safe half, for the same reason
     * `appliesTo` defaults to leaves.
     */
    readonly kinds?: readonly string[]
}

/**
 * A named group of a row's fields.
 *
 * `"Architecture"` means something without a screen: the CLI can group the questions it asks, MCP
 * can ask a related set together, a browser can draw a heading. That is the test for whether
 * anything belongs in a presentation hint at all, and grouping passes it - unlike a width or a tab
 * index, which only a screen wants.
 */
export interface RpcPresentationSection {
    /** What to call the group, in a heading, a prompt or a paragraph. */
    readonly label: string
    /** The fields in it, in the order to read or ask them. */
    readonly fields: readonly string[]
}

/**
 * One field of a row that names a row of another resource.
 *
 * The fact a viewer cannot work out and a store already knows: `customerId` is not merely a string,
 * it is a `customers`. From it a viewer draws the customer's name instead of `38271`, makes it
 * openable, batches fifty of them into one `getMany` rather than fifty round trips, and offers the
 * reverse side through `getManyReference` - and MCP reads the same declaration to navigate without
 * a graph protocol underneath it.
 *
 * ## Why there is no `targetField`
 *
 * Because `getMany` takes ids. A reference whose field held some *other* column of the target would
 * need a lookup this contract cannot express, and declaring it before that exists would be a
 * promise no provider could keep - the shape of an unbuilt feature, advertised. A key that is not
 * the target's row id waits until there is a verb that can follow it.
 *
 * So the rule is exact: **`field` holds the target's row id**. A provider that cannot say that
 * truthfully declares nothing, which is always available and always honest.
 */
export interface RpcDataReference {
    /** The field of this row that holds the id. A path, checked against the row like the hints are. */
    readonly field: string
    /** The resource whose row that id names, by the path `$data` addresses it with. */
    readonly target: RpcResource
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
    /**
     * The one field that says what a row *is*, in a sentence rather than in a table.
     *
     * A row has an id because something has to identify it, and an id is almost never what a person
     * should be shown: `Restart b92c21af?` is a question nobody can answer, and `Restart Boiler feed
     * pump P-104?` is the same question asked properly. Confirmations, the title over an opened row,
     * a reference drawn from another resource and a search hit all need the same sentence, so it is
     * declared once here rather than guessed four times.
     *
     * **One path, not a list and not a format string.** A list would be a formatting decision
     * wearing a data hat - what separates the parts, what happens when the second is absent, whether
     * the order is significant - and none of those are questions a resource is in a position to
     * answer for a screen it has never seen. A viewer wanting more than this has the whole row and
     * the declared columns to build it from. If a real case turns up that one path cannot serve, it
     * can widen; widening is a smaller act than narrowing.
     *
     * Checked against `row` at describe time exactly as `defaultColumns` is, and ignored the same
     * way when it names nothing: a node that will not start because a field was renamed in a
     * presentation hint is a worse failure than a viewer falling back to the id.
     */
    readonly representation?: string
    /**
     * Which fields to read first when one row is opened on its own.
     *
     * `defaultColumns` answers what a row looks like *among its siblings* - the four worth reading
     * down a page. This answers what it looks like *on its own*, and the two are different
     * questions with different right answers: a serial port has twenty-two fields, four of which
     * belong in a table and about eight of which somebody opening one actually wants.
     *
     * **Order and prominence, never concealment.** The fields named here come first, in this order,
     * and everything else follows - the same rule `defaultColumns` states one field up, because a
     * reader comparing a panel against the row it came from must find every field in both. A viewer
     * may choose to fold the remainder away; that is the reader's decision and not the node's.
     */
    readonly detail?: readonly string[]
    /**
     * Which fields an outside caller would reasonably want to change, in the order to offer them.
     *
     * **Advice that narrows, and it can never widen.** What may actually be written is settled by
     * the write rules and answered by `writable()`, which resolves them against the store it is
     * pointed at; this says which of those are worth putting in front of somebody, because a
     * resource with forty writable columns and three anybody edits is the ordinary case. A path
     * here that `writable()` does not resolve is dropped, exactly as a rule naming a column the
     * store does not have is dropped - a presentation hint that could make a field editable would
     * be a hint deciding authority, which is the one thing this whole surface is arranged against.
     *
     * Absent means the writable columns in the order the rule declares them, which is a perfectly
     * good answer and the reason this is optional.
     */
    readonly edit?: readonly string[]
    /**
     * How the row's fields group, for any view that draws or asks them in groups.
     *
     * **Orthogonal to the sets above, which is why it is a fifth field rather than a shape they
     * grow.** `detail` and `edit` answer *which* fields a view is about; this answers *how fields
     * relate*, and the same answer serves both - the reading view groups what it shows, the edit
     * form groups what it offers, and a group left empty by either is simply not drawn. Folding
     * grouping into each of them would state the same relationship twice and let the two disagree
     * about which fields belong together, which is the thing a reader would notice and nobody
     * would be able to explain.
     *
     * A field named in no section is not hidden; it comes last, in an unnamed group. A field named
     * in two is a mistake, because it would be drawn twice, and it is said out loud at describe
     * time like every other path here.
     *
     * `groupFields` is how a consumer reads this, so the arranging is done once rather than in
     * every viewer.
     */
    readonly sections?: readonly RpcPresentationSection[]
}

/**
 * Arrange the fields a view is showing into the groups the resource declared.
 *
 * Here rather than in each viewer, because three consumers would otherwise each decide what happens
 * to a field in no section, or a section none of whose fields are being shown, and a reader moving
 * between a browser and the CLI would find the same row arranged two ways.
 *
 * The rules, and each of them is the safe half:
 *
 * - Section order is the resource's; field order within a section is the resource's.
 * - A field the caller is not showing is not conjured into a group. `edit` and `detail` select;
 *   this only groups what they selected.
 * - A section with nothing left in it is dropped, rather than drawn as an empty heading.
 * - A field in no section comes last, in a group with no label, because dropping it would let a
 *   grouping hint decide what may be seen - and it decides what is *beside* what.
 * - No sections at all is one unlabelled group, so a caller never has to branch on whether the
 *   resource had an opinion.
 */
export const groupFields = (fields: readonly string[], sections?: readonly RpcPresentationSection[]): readonly { label?: string; fields: readonly string[] }[] => {
    if (!sections?.length) return fields.length ? [{ fields }] : []
    const showing = new Set(fields)
    const grouped: { label?: string; fields: readonly string[] }[] = []
    const placed = new Set<string>()
    for (const section of sections) {
        const present = section.fields.filter((field) => showing.has(field) && !placed.has(field))
        for (const field of present) placed.add(field)
        if (present.length) grouped.push({ label: section.label, fields: present })
    }
    const rest = fields.filter((field) => !placed.has(field))
    if (rest.length) grouped.push({ fields: rest })
    return grouped
}

export interface RpcDataResource {
    /** How `$data` names it. `props` and `state` are the component's built-in resources. */
    readonly path: RpcResource
    /**
     * The shape of one row, so a viewer can draw columns for a table it has never heard of.
     *
     * Optional for compatibility and for a resource whose values genuinely have no narrower
     * contract. A generic viewer can still show those values, but a provider that wants typed
     * columns, filters, detail fields or references supplies it. In practice that makes `row` part
     * of the useful minimum for a store-backed provider even though it is not a wire requirement.
     */
    readonly row?: TypeNode
    /**
     * Which verbs it answers - **reading and writing, one list**. A viewer offers what is here and
     * nothing else, and asking for anything else is refused by name rather than ignored.
     *
     * A resource that cannot be written does not have a smaller interface; it has a shorter list.
     * That distinction is the point: the provider interface is one verb-shaped `dataRequest`, so
     * nothing about a read-only resource is missing from the type - what is missing is the claim,
     * and the claim is what a viewer reads to decide whether to draw a delete button at all.
     */
    readonly verbs: readonly RpcResourceVerb[]
    /**
     * Which fields a caller may write, by name - the resolved answer, not the rule that asked for it.
     *
     * Required wherever `create` or `update` is offered, for the reason the write rule gives: a
     * declaration naming a resource and no columns reads as "all of them" to whoever wrote it and to
     * whoever reads it next, and those are the two people who must not disagree. Resolved against
     * the store before it is published, so a column the store does not have is absent here rather
     * than advertised and then refused.
     */
    readonly columns?: readonly string[]
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
     * **The row fills the method's first parameter, and the rest are asked for.** `retryDeadLetter(
     * taskId)` therefore runs on a press, and `write(nodeId, value)` opens a form for `value` with
     * `nodeId` already filled in and shown - one rule, and the second case is the first with more
     * of the signature left to supply.
     *
     * Nothing here says how many arguments a method takes or what they are, because `describe()`
     * published that before this field existed. That is the line this whole declaration is drawn
     * on: it carries the one fact a viewer cannot work out - which method is about which row - and
     * reads everything else off the contract, so a method that gains a parameter gains a field in
     * the form and needs nothing changed here.
     *
     * A method whose first parameter is not the row is not an action; it is a method, and the
     * console already offers every one of those. Nothing can check that claim from the outside,
     * which is why the form shows the bound argument rather than sending it out of sight.
     */
    readonly actions?: readonly RpcDataAction[]
    /**
     * Which of this row's fields name rows of other resources.
     *
     * Adds no capability, exactly as `actions` adds none: `getMany` and `getManyReference` have been
     * served since resources existed and were reachable by anybody who already knew what referred to
     * what. This carries the knowing.
     */
    readonly references?: readonly RpcDataReference[]
}

/**
 * The resources every described component already provides.
 *
 * Props and state used to be merely paths accepted by the `$data` fallback while a viewer rebuilt
 * their hierarchy from the schema. Publishing them here makes the fallback a real provider: the
 * same catalogue, branch and list operations used for a database table or an address space now
 * describe a component record too. `any` is deliberate. A recursive list may contain differently
 * typed leaves, and the provider returns each leaf value as the row rather than wrapping it in a
 * second, invented domain object. `id` and `value` are the two generic table projections over that
 * row: its provider identity and the row itself.
 */
export const componentDataResources = (_component?: { readonly props?: TypeNode; readonly state?: TypeNode }): readonly RpcDataResource[] =>
    (['props', 'state'] as const).map((root) => ({
            path: [root],
            row: { kind: 'any' },
            verbs: ['getChildren', 'getList', 'getOne', 'getMany'],
            shape: 'tree',
            label: root,
            presentation: { defaultColumns: ['id', 'value'] }
        }))

/**
 * A component that serves collections of its own, rather than only the records in its state.
 *
 * Implementing this is what Source Relational, Source Document and Source Queue do; an ordinary
 * component implements nothing and still answers `getList` over any record it holds, because the
 * base class serves that from the contract.
 */
/**
 * The complete read protocol, in one place.
 *
 * `RpcDataResources` uses the unions because its dispatcher receives a verb at runtime. Generic
 * callers use the indexed forms to keep a concrete verb paired with exactly its request and answer
 * shapes: `RpcDataParamsFor<'getMany'>` cannot accidentally become list parameters.
 */
export interface RpcDataContract {
    readonly getList: { readonly params: RpcGetListParams; readonly result: RpcGetListResult }
    readonly getOne: { readonly params: RpcGetOneParams; readonly result: RpcGetOneResult }
    readonly getMany: { readonly params: RpcGetManyParams; readonly result: RpcGetManyResult }
    readonly getManyReference: { readonly params: RpcGetManyReferenceParams; readonly result: RpcGetListResult }
    readonly getChildren: { readonly params: RpcGetChildrenParams; readonly result: RpcGetChildrenResult }
}

export type RpcDataParamsFor<M extends RpcDataMethod> = RpcDataContract[M]['params']
export type RpcDataResultFor<M extends RpcDataMethod> = RpcDataContract[M]['result']
export type RpcDataParams = RpcDataParamsFor<RpcDataMethod>
export type RpcDataResult = RpcDataResultFor<RpcDataMethod>

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
        params: RpcDataParams
    ): RpcDataResult | Promise<RpcDataResult>
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

/** An additional component-owned resource, excluding the two roots reserved for the base provider. */
export const declaredResource = (instance: object, resource: RpcResource): RpcDataResource | undefined =>
    resource.length === 1 && (resource[0] === 'props' || resource[0] === 'state')
        ? undefined
        : servesDataResources(instance)
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
    if (given.recursive !== undefined && typeof given.recursive !== 'boolean') return new Error('$data: recursive is true or false - it says how deep to go, not how far')
    if (method === 'getChildren') {
        const branch = given as unknown as RpcGetChildrenParams
        // Checked rather than coerced, as everything else here is: a parentId that arrived as a
        // number is a caller that built the request wrongly, and answering the roots instead would
        // look exactly like a node that genuinely has no children.
        if (branch.parentId !== undefined && (typeof branch.parentId !== 'string' || !branch.parentId))
            return new Error('$data: getChildren takes a non-empty string parentId, or none at all for the roots')
        // Refused rather than ignored, because the two readings of it contradict each other and
        // whichever one a node picked would be a surprise to somebody: `getChildren` *is* one level,
        // so `recursive: true` asks it to stop being itself and `recursive: false` restates it. A
        // caller that wants the choice has `getList`, which is where the choice lives.
        if (branch.recursive !== undefined)
            return new Error('$data: getChildren is one level by definition - ask getList with recursive for the choice')
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
export const describedResources = (instance: unknown, owner: string, types?: RpcSchema['types'], writable?: readonly RpcWritableResource[]): readonly RpcDataResource[] => {
    const resources = (instance as RpcDataResources).dataResources()
    for (const resource of resources) checkPresentation(owner, resource, types)
    checkReferences(owner, resources, types)
    return writable?.length ? resources.map((resource) => withWrites(resource, writable)) : resources
}

/**
 * Fold what a resource may be written with into what it may be read with, so `describe()` answers
 * the whole question.
 *
 * The write half arrives already resolved against the store - `writable()` is the authority and
 * stays it - so this carries an answer rather than restating a rule. What it removes is a join the
 * caller was doing: a console read `describe()` for the read verbs, opened a second namespace for
 * `writable()`, and matched the two by name, which only worked for resources exactly one segment
 * deep. Nothing is added to the write surface by doing this and nothing is taken away; the two lists
 * simply stop being two.
 *
 * A resource nobody named in the write rules keeps the verbs it had, which is the default the write
 * contract already states: a name that is not there accepts none.
 */
const withWrites = (resource: RpcDataResource, writable: readonly RpcWritableResource[]): RpcDataResource => {
    // Matched on the single-segment name the write surface uses, which is the same join as before -
    // but done here, once, by the side that holds both halves, instead of by every caller.
    const rule = resource.path.length === 1 ? writable.find((one) => one.resource === resource.path[0]) : undefined
    if (!rule?.verbs.length) return resource
    return {
        ...resource,
        verbs: [...resource.verbs, ...rule.verbs.filter((verb) => !resource.verbs.includes(verb))],
        ...(rule.columns.length ? { columns: rule.columns } : {})
    }
}

/**
 * A reference has two halves that can be wrong, and they are wrong in different ways.
 *
 * A field the row does not have is the same mistake a presentation hint makes, and costs the same:
 * nothing is drawn. A **target nobody serves** is worse and is worth its own sentence - the row
 * carries the id, the id is right, and a viewer following it asks a resource that is not there. It
 * is checkable here and nowhere else, because this is the one place every resource of a component
 * is in hand at once.
 */
const checkReferences = (owner: string, resources: readonly RpcDataResource[], types?: RpcSchema['types']): void => {
    const served = new Set(resources.map((resource) => resource.path.join('.')))
    for (const resource of resources)
        for (const reference of resource.references ?? []) {
            if (resource.row) complain(owner, resource, types, reference.field, 'references', 'The reference is not drawn; the field is still shown as whatever it holds.')
            const target = reference.target.join('.')
            if (served.has(target)) continue
            const key = `${owner}\u0000${resource.path.join('.')}\u0000references\u0000target\u0000${target}`
            if (warnedColumns.has(key)) continue
            warnedColumns.add(key)
            console.warn(
                `source-rpc: ${owner}.${resource.path.join('.')} says '${reference.field}' refers to '${target}', ` +
                    'which this component does not serve. The reference is not drawn: a viewer following it would ask for a resource that is not here.'
            )
        }
}

/**
 * Every path a presentation hint names, checked against the row it is about.
 *
 * One walk over four hints rather than four walks, and the consequence travels with each because
 * they are not the same: a column that is not there leaves a table one column short, a
 * representation that is not there leaves every confirmation naming a row by its id, and a field
 * missing from `edit` is a field somebody expected to be able to change.
 */
const checkPresentation = (owner: string, resource: RpcDataResource, types?: RpcSchema['types']): void => {
    const hint = resource.presentation
    if (!resource.row || !hint) return
    const named: readonly [string, readonly string[], string][] = [
        ['defaultColumns', hint.defaultColumns ?? [], 'The column is ignored; every other field of the row is still selectable.'],
        ['representation', hint.representation ? [hint.representation] : [], 'Rows will be named by their id instead.'],
        ['detail', hint.detail ?? [], 'The field is not promoted; an opened row still shows everything it carries.'],
        ['edit', hint.edit ?? [], 'The field is not offered for editing. What may be written is settled by the write rules, never here.'],
        ['sections', (hint.sections ?? []).flatMap((section) => section.fields), 'The field is not grouped; it is drawn after the groups that are.']
    ]
    for (const [where, paths, consequence] of named) for (const path of paths) complain(owner, resource, types, path, where, consequence)

    // A field in two groups is drawn twice, which is a mistake nobody makes on purpose and which
    // looks from a screen like the peer sending it twice.
    const placed = new Set<string>()
    for (const section of hint.sections ?? [])
        for (const path of section.fields) {
            if (!placed.has(path)) placed.add(path)
            else complain(owner, resource, types, path, 'sections', `It is in more than one group, and a field can only be drawn once.`, true)
        }
}

const complain = (owner: string, resource: RpcDataResource, types: RpcSchema['types'] | undefined, path: string, hint: string, consequence: string, always = false): void => {
    if (!always && pathInType(path.split('.'), resource.row, types)) return
    const key = `${owner}\u0000${resource.path.join('.')}\u0000${hint}\u0000${path}`
    if (warnedColumns.has(key)) return
    warnedColumns.add(key)
    console.warn(`source-rpc: ${owner}.${resource.path.join('.')} names '${path}' in presentation.${hint}, ` + `which its declared row type does not have. ${consequence}`)
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
    // Refused where it would mean nothing rather than ignored there. A caller who asked for a folded
    // comparison and silently got a sensitive one would be reading a wrong answer as a right one -
    // which is the same failure a dropped field is, and this file refuses those too.
    if (condition.fold !== undefined) {
        if (typeof condition.fold !== 'boolean') return new Error('$data: fold is true or false')
        if (condition.fold && condition.op !== 'startsWith' && condition.op !== 'contains')
            return new Error(`$data: fold applies to startsWith and contains, not to ${condition.op} - "case-insensitively less than" is a collation, not a comparison`)
    }
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

/** A row id is a dotted path for a recursively listed component record. Prefer an exact key. */
const valueAt = (collection: RpcComponentData, id: string): { held: boolean; value?: unknown } => {
    if (Object.prototype.hasOwnProperty.call(collection, id)) return { held: true, value: collection[id] }
    const find = (from: unknown, parts: readonly string[]): { held: boolean; value?: unknown } => {
        if (from === null || typeof from !== 'object') return { held: false }
        const record = from as Record<string, unknown>
        // Longest key first preserves record ids containing dots: `tags.tag.007` reaches the key
        // `tag.007` after entering `tags`, instead of assuming every dot came from object depth.
        for (let length = parts.length; length > 0; length--) {
            const key = parts.slice(0, length).join('.')
            if (!Object.prototype.hasOwnProperty.call(record, key)) continue
            if (length === parts.length) return { held: true, value: record[key] }
            const nested = find(record[key], parts.slice(length))
            if (nested.held) return nested
        }
        return { held: false }
    }
    return find(collection, id.split('.'))
}

/** Process readings are domain values, not folders merely because their wire shape is an object. */
const processValue = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const fields = value as Record<string, unknown>
    return 'value' in fields && ('quality' in fields || 'unit' in fields || 'forced' in fields || 'at' in fields)
}

/** The built-in component provider's leaf decision. */
const groupingValue = (value: unknown): value is RpcComponentData =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date) && !processValue(value)

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
    // The base props/state provider exposes heterogeneous leaf values directly. `value` is the
    // generic table projection of a scalar row; object rows keep their real field of that name.
    if (field === 'value' && (row === null || typeof row !== 'object' || Array.isArray(row) || row instanceof Uint8Array || row instanceof Date)) return row
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
const satisfies = (value: unknown, { op, operand, fold }: RpcFilterCondition): boolean => {
    if (op === 'ne') return value !== operand
    if (value === undefined) return false
    switch (op) {
        case 'eq':
            return value === operand
        case 'startsWith':
        case 'contains': {
            const held = typeof value === 'string' ? value : String(value)
            // Both sides, and only when asked. Folding one side would make the comparison depend on
            // which of them happened to be capitalised.
            const text = fold ? held.toLowerCase() : held
            const needle = fold ? String(operand).toLowerCase() : String(operand)
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
    const row = valueAt(collection, params.id)
    // Spread rather than `data: undefined`, so an absent row is a key that is not there. A frame
    // carrying `data: undefined` says the same thing in JSON and something else in a format that
    // encodes fields positionally.
    return { ...(row.held ? { data: row.value } : {}), epoch: snapshot.epoch, revision: snapshot.revision }
}

export const getMany = (component: object, resource: RpcResource, params: RpcGetManyParams): RpcGetManyResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const rows = params.ids.map((id) => [id, valueAt(collection, id)] as const).filter(([, row]) => row.held)
    return { ids: rows.map(([id]) => id), data: rows.map(([, row]) => row.value), epoch: snapshot.epoch, revision: snapshot.revision }
}

/** How deep a recursive walk of a component's own record will go before it stops descending. */
const MAX_WALK_DEPTH = 32

/**
 * Every value beneath a record, at any depth, keyed by the path to it.
 *
 * What `recursive: true` means for a component's own props and state, where the hierarchy is the
 * shape of the data rather than something a provider browses. Ids are dotted paths - `zones.top.
 * setpoint` - because that is what identifies a leaf here and what a caller passes back to `getOne`.
 *
 * A plain object is descended into and everything else is a leaf, which puts arrays and dates on the
 * same side of the line as numbers. That is deliberate: an array's members are indices, and indices
 * are data in the way a record's keys are data - so it is one value here rather than a branch,
 * exactly as the scope tree treats it.
 *
 * Bounded, because this walks a value rather than a type and a value can be deeper than anybody
 * intended. At the limit the object itself is the leaf, which is a truthful answer rather than a
 * truncated one: the caller gets the thing, just not taken apart.
 */
const walkEntries = (from: RpcComponentData, prefix: string, depth: number): (readonly [string, unknown])[] =>
    projectionKeyOrder(from).flatMap((key) => {
        const value = from[key]
        const id = prefix ? `${prefix}.${key}` : key
        return groupingValue(value) && depth < MAX_WALK_DEPTH ? walkEntries(value, id, depth + 1) : [[id, value] as const]
    })

export const getList = (component: object, resource: RpcResource, params: RpcGetListParams): RpcGetListResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const beneath = params.under ? valueAt(collection, params.under) : { held: true, value: collection }
    const from = beneath.held && groupingValue(beneath.value) ? beneath.value : {}
    const prefix = params.under ?? ''
    return {
        ...pageEntries(
            // One level unless somebody asked for the depth, which is the change of default this
            // flag exists to make: the answer that costs more should be the one with a word in the
            // request. Filtering, ordering and paging then happen over whichever set was gathered,
            // in that order, exactly as they do for a flat one.
            params.recursive
                ? walkEntries(from, prefix, 0)
                : projectionKeyOrder(from).map((id) => [prefix ? `${prefix}.${id}` : id, from[id]] as const),
            params
        ),
        epoch: snapshot.epoch,
        revision: snapshot.revision
    }
}

/**
 * One level of the component provider's hierarchy.
 *
 * IDs stay relative to the resource root and therefore remain stable as the caller moves between
 * branches. `grouping` says which rows are scope; `hasChildren` separately says whether opening the
 * expander can currently reveal anything. An empty object is still a scope even though it has no
 * children, while a process reading is a leaf even though it carries fields.
 */
export const getChildren = (component: object, resource: RpcResource, params: RpcGetChildrenParams): RpcGetChildrenResult => {
    const snapshot = componentSnapshot(component)
    const collection = collectionAt(snapshot, resource) ?? {}
    const beneath = params.parentId ? valueAt(collection, params.parentId) : { held: true, value: collection }
    const from = beneath.held && groupingValue(beneath.value) ? beneath.value : {}
    const prefix = params.parentId ?? ''
    const page = pageEntries(
        projectionKeyOrder(from).map((id) => [prefix ? `${prefix}.${id}` : id, from[id]] as const),
        params
    )
    const grouping = page.data.map(groupingValue)
    return {
        ...page,
        grouping,
        hasChildren: page.data.map((value, at) => grouping[at] && Object.keys(value as RpcComponentData).length > 0),
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
