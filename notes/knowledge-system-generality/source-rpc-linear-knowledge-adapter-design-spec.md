# Source RPC Linear Knowledge Adapter — Design Specification

*Status: proposed first validation adapter, 2026-08-29. This specification depends on the separate [Source RPC General Knowledge System Extensions specification](./source-rpc-general-knowledge-system-design-spec.md).*

## 1. Executive decision

Linear is a good first test because it is immediately useful and architecturally demanding. It has stable external objects, Markdown descriptions, overlapping structures, deep links, filtering, cursor paging, permissions, rate limits, webhooks and tempting mutations. If the proposed knowledge contract can represent Linear cleanly without absorbing Linear's API, it has passed a meaningful test.

The adapter must remain optional and initially read-only:

- `@source-repo/linear` implements the generic knowledge-provider capability.
- It maps Linear objects into namespaced knowledge kinds and provider-owned projections.
- It does not add Linear types, GraphQL concepts, OAuth concepts or webhook concepts to Source RPC core or `@source-repo/knowledge`.
- It exposes virtual rows and occurrences, not one RPC component or worker per issue.
- It never exposes raw GraphQL, SDK objects, access tokens or generic mutation methods over RPC.
- A Linear issue remains an external object. It does not silently become Source's canonical `WorkItem` or execution state.

This is not a Linear clone and it is not the beginning of a universal task tracker. The first release is a useful browser for work descriptions and current activity that also validates the general knowledge model.

## 2. Monster test and change budget

Linear is allowed to prove only the following generic seams:

| Need demonstrated by Linear | Where it belongs |
|---|---|
| Stable object references and content blocks | `@source-repo/knowledge` |
| Several structures over the same issues | `@source-repo/knowledge` plus provider implementation |
| Projection-aware links | `@source-repo/knowledge` and console navigation |
| Lazy, page-sized tree branches | Completion of existing RPC `shape: 'tree'` support |
| Useful initial table fields | Optional `presentation.defaultColumns` hint |
| Buttons for explicit operations | Existing row actions and described RPC method form |
| View/edit behaviour on row activation | Generic knowledge affordances plus projection/workspace mode |
| OAuth, GraphQL, webhooks and rate handling | `@source-repo/linear` only |
| Spelling a write: verbs, permissions, outcome, row stamp | Already in `DataWrites.ts`; the adapter reuses it and adds nothing |
| Linear-specific layout polish | Locally installed console renderer only |

The adapter fails the anti-monster test if its useful read-only version requires another Source RPC core abstraction beyond lazy tree retrieval and default-column hints. Such a requirement stays in the adapter until a second unrelated provider proves it generic.

Conversely, forcing all Linear behaviour into a generic object is also failure. Provider-specific projection code, filtering translation, cache policy and webhook handling are healthy adapter responsibilities.

## 3. Goals

- Browse Linear issues, projects, initiatives, milestones, cycles and documents from the CLI web console
- Make issue descriptions and related context more prominent than a board
- Offer a focused Live projection for work currently in progress
- Navigate the same issue in team/work, strategy and live contexts without duplicating identity
- Preserve the source projection when following an issue-to-project, parent/sub-issue or document link where possible
- Reuse the existing tree-scoped list, server-side search/filter, paging and row-action mechanics
- Expose the same bounded information through MCP
- Preserve Linear URLs, ids, timestamps, provenance and freshness
- Enforce Source authorization in addition to the Linear installation's access
- Cope explicitly with rate limiting, stale caches, webhook gaps and API evolution
- Leave a safe path to a small set of explicit writes after the read model proves useful

## 4. Non-goals

- Reimplementing Linear's complete web application
- Making a Kanban board the primary experience
- Importing Linear's GraphQL schema into the Source contract
- Providing a generic `graphql`, `updateIssue(patch)` or `callLinearApi` method
- Treating Linear workflow state as Source execution truth
- Automatically creating a native Source `WorkItem` for every Linear issue
- Mirroring every comment, reaction, customer, view preference or notification in the first release
- Using Linear's preview agent APIs
- Requesting `admin` or write scopes for a read-only installation
- Polling Linear continuously when webhooks or deliberate refresh can maintain freshness
- Letting browser or MCP clients receive adapter credentials
- Assuming a Linear board, custom view or URL path is a stable object identity

## 5. Architecture

Linear's API and webhooks feed the adapter and its optional cache. The adapter implements the generic knowledge-provider capability consumed by the console, applications and MCP.

The adapter is one ordinary Source RPC component. It may use the official TypeScript SDK for ordinary access and narrow GraphQL queries where the SDK would over-fetch, but those choices do not appear in its RPC contract. Linear recommends its GraphQL API and official TypeScript SDK for programmatic access.

The component owns:

- One Linear OAuth installation or development API key
- Tenant and team scope configuration
- Mapping between Linear objects and `KnowledgeRef`
- Named structural projections
- Optional cache/index and synchronization cursor state
- Webhook verification, deduplication and invalidation
- Translation of Source filters and pages into bounded Linear queries
- Source-side row, field and method authorization

The component does not own:

- Linear itself as a source of truth
- Source's native work/execution model
- Viewer preferences
- User-interface code delivered at runtime
- Source RPC topology or context inheritance

## 6. Deployment and component contract

One provider instance represents one deliberately configured Linear installation and workspace. Multiple workspaces use multiple provider instances so credentials, caches and authorization do not accidentally merge.

Representative configuration and operational state:

```ts
export interface LinearKnowledgeProps {
  installation: string
  organizationId: string
  includedTeamIds?: readonly string[]
  mode: 'read-only' | 'explicit-writes'
  cache: 'read-through' | 'webhook-indexed'
}

export interface LinearKnowledgeState {
  status: 'initializing' | 'live' | 'stale' | 'degraded' | 'offline'
  workspaceName?: string
  lastSuccessfulReadAt?: string
  lastWebhookAt?: string
  lastReconciledAt?: string
  pendingInvalidations: number
  rateLimit?: {
    remaining?: number
    resetAt?: string
  }
  problem?: string
}
```

`installation` is an opaque secret-store lookup key, never a token. No credential, webhook secret or private asset authorization appears in props, state, logs, knowledge objects or diagnostic source.

The provider advertises the generic knowledge capability and publishes these initial data resources:

| Resource | Shape | Purpose |
|---|---|---|
| `issues` | list | Searchable/filterable issue summaries |
| `projects` | list | Project summaries |
| `documents` | list | Document summaries where allowed |
| `projections` | list | Projection descriptors |
| `linear-work` | tree | Team/project work structure |
| `linear-strategy` | tree | Initiative/project strategy structure |
| `linear-live` | tree | Currently active work structure |

Resource names are adapter implementation details returned in projection descriptors. Generic clients do not infer semantics from their spelling.

## 7. Identity and Source model boundary

### 7.1 Object identity

Linear's native UUID is the knowledge object's `id`. A human issue identifier such as `ENG-123` is display data and a search key; it is not used as identity because team keys and numbering can change.

Example:

```ts
const issueRef: KnowledgeRef = {
  provider: { peer: 'work', instance: 'linear-daritas' },
  resource: ['issues'],
  id: linearIssue.id
}
```

The Linear URL is retained in `origin.url`. `origin.externalId` carries the UUID, while fields may carry the human identifier. The adapter records `updatedAt`, `retrievedAt` and a provider revision.

### 7.2 Linear is not the native work model

A native Source work item should be able to connect an objective, evidence, constraints, permissions, affected systems, executor, execution context, acceptance and verification. Linear's issue model is useful but does not define those semantics.

The systems connect explicitly:

- A `source.work-item` may link to a `linear.issue` with relationship `external-ref`.
- A Linear issue may link back with `tracked-by` when the Source item is visible to the provider.
- Importing, creating or binding a native work item is an explicit operation, never a side effect of browsing.
- Linear status, assignee and cycle remain external planning facts. Source execution and verification remain native facts.

This keeps Linear replaceable and prevents the adapter from becoming the choke point for native execution, assessment or automation.

## 8. Concept mapping

| Linear concept | Knowledge kind | Representation |
|---|---|---|
| Workspace/organization | `linear.workspace` | Provider root object |
| Team | `linear.team` | Object and structural parent in work/live views |
| Initiative | `linear.initiative` | Object; may nest in strategy projection |
| Project | `linear.project` | Object; may occur under initiatives and teams |
| Project milestone | `linear.project-milestone` | Object or lightweight structural object under a project |
| Cycle | `linear.cycle` | Object and grouping context in live/work views |
| Workflow state | `linear.workflow-state` | Reference object or virtual group, depending on requested detail |
| Issue | `linear.issue` | Primary searchable object with Markdown content |
| Parent/sub-issue edge | `linear.issue-parent` | Relationship; child keeps its own identity |
| Document | `linear.document` | Markdown knowledge object linked to its Linear context |
| Comment | `linear.comment` | Initially paged content/relationship under issue detail, not a default tree node |
| User | `linear.user` | Reference object used by assignee/creator fields |
| Label | `linear.label` | Reference object and filter value |
| Attachment | `linear.attachment` | Safe attachment block or external link |
| Project/initiative update | `linear.update` | Deferred object kind; not required in the first slice |

Linear issues belong to a team and can belong to a project and cycle. Projects can span teams; therefore the same project may have several structural occurrences, while an issue's native team remains a field and relationship. The projection logic must not manufacture a second issue identity to make a tree convenient.

Descriptions and document bodies are emitted as Markdown blocks with their source metadata. The adapter may additionally recognize Linear entity URLs inside Markdown and publish typed links, but the original Markdown remains intact.

## 9. Structural projections

All projections are provider code in the first implementation. No general rule language is introduced.

### 9.1 Work projection — `linear.work`

Purpose: browse planned work from the teams that own issues.

Structure:

1. Workspace
2. Team
3. Project, plus an explicit **No project** virtual group
4. Project milestone where present
5. Issue
6. Sub-issue

A multi-team project may occur under each relevant team. Only issues whose own team matches the branch appear there. Issues outside the configured team scope do not appear even if their project is visible elsewhere.

Default list columns:

- Identifier
- Title
- Status
- Assignee
- Priority
- Cycle
- Updated at

### 9.2 Strategy projection — `linear.strategy`

Purpose: connect strategic initiatives to delivery work.

Structure:

1. Workspace
2. Initiative hierarchy
3. Project
4. Milestone
5. Issue
6. Sub-issue

Projects with no initiative appear under **Unattached projects**. This projection validates that one project and issue can occur in another structure without acquiring another object identity.

Default list columns:

- Title/identifier
- Team
- Project status
- Target date
- Issue status
- Lead/assignee
- Updated at

Fields absent for a particular kind render as empty; the row schema remains the source of selectable columns.

### 9.3 Live projection — `linear.live`

Purpose: show what is being actively worked, with descriptions and context immediately available. It is deliberately more important than a generic Kanban board for this use case.

Structure:

1. Workspace
2. Team
3. Current cycle, plus **Outside current cycle** where configured
4. Workflow state
5. Issue

Initial membership is conservative and source-backed:

- Include issues whose Linear workflow-state category is active/started.
- Optionally restrict to the current cycle per team.
- Do not infer “blocked,” “urgent” or “being coded now” from prose, recency or AI.
- A provider option may include unstarted assigned issues, but the UI labels that broader rule.

Default list columns:

- Identifier
- Title
- Status
- Assignee
- Priority
- Project
- Updated at

The detail panel shows the issue description, parent/sub-issues, project, cycle, labels, linked documents and comments. A board can later be a viewer presentation over the same rows; it is not a new provider model or an MVP requirement.

### 9.4 Deferred projections

Possible later projections include responsibility/assignee, labels, customer requests and an installation-access diagnostic view. They are added only for a real workflow. In particular, an “access” projection would describe visible configuration; it would not become authorization policy.

## 10. Projection occurrence rules

- `KnowledgeRef` identifies a Linear object across every view.
- `occurrenceId` identifies one placement in one projection revision.
- Virtual groups such as **No project** have no `KnowledgeRef` and cannot receive comments or mutations.
- Occurrence ids are deterministic from provider installation, projection id, parent occurrence, relation and object id. They must not include a mutable title.
- Moving an issue changes its occurrences but not its object reference.
- A saved object link resolves again against the current projection revision instead of trusting an obsolete tree path.
- Child counts are returned only after provider authorization; hidden branches and counts must not disclose private-team structure.

Branches use the generic `getChildren` resource verb with paging. The adapter must never fetch the entire workspace merely to expand one team or initiative.

## 11. Links and contextual navigation

The adapter publishes typed links for relationships including:

- Issue → team, project, cycle, workflow state and assignee
- Issue ↔ parent/sub-issue
- Issue ↔ linked document and attachment
- Project → initiative, milestones, teams and issues
- Initiative → parent/child initiative and projects
- Document → attached issue, project, initiative, team or cycle
- Linear object → native Source work item when an explicit binding exists

Links default to projection inheritance:

- Following a sub-issue from `linear.live` keeps `linear.live` if that sub-issue is active there.
- Following an issue's project from `linear.strategy` stays in the strategic occurrence nearest the source.
- Following a project from `linear.live` falls back visibly to the project's default work or strategy location if the live projection has no project occurrence.
- An explicit link may request another projection, for example “view in strategy.”

Recognized Linear URLs in Markdown produce a typed link in addition to the untouched external URL. Unrecognized URLs remain ordinary safe hyperlinks. Link resolution never uses URL parsing as the sole object identity when a UUID is available.

## 12. Detail and content retrieval

Tree and list rows remain compact. `getObject` retrieves full detail only when selected.

An issue detail contains:

- Title, human identifier and source URL
- Sanitized Markdown description
- Status, priority, estimate, dates and timestamps
- Team, project, cycle, milestone, assignee, creator and labels as fields/links
- Parent and sub-issue links
- Linked documents and attachments
- A separately paged initial comment section
- Origin, retrieval time and freshness status

Large descriptions, comment threads and attachments are independently bounded. Truncation is explicit and includes a continuation operation or the original Linear link; it must never look like complete content.

Private Linear assets often require authenticated access. The MVP displays a Linear link that the user opens under their own Linear session. It does not hand a bearer-authenticated asset URL or adapter token to the browser. A later authorized proxy or controlled mirror requires its own threat model, size limits, media allowlist and cache policy.

## 13. Query, filtering and paging

### 13.1 GraphQL boundary

The adapter uses narrow persisted query documents or SDK calls maintained inside the package. It does not accept query text, field selections or arbitrary filters from RPC callers.

Each query:

- Selects only fields required for the requested rows or object detail
- Has an adapter-defined complexity and page bound
- Translates only the closed Source filter operators it supports
- Refuses unsupported filters with a typed explanation instead of downloading everything
- Applies configured team/workspace scope in addition to caller filters
- Avoids per-row lookups by batching relationships needed for a page

Linear's API is unversioned and communicates changes through deprecations and its changelog. The adapter therefore isolates generated types and response mapping behind contract tests; no SDK type is exported as a Source type.

### 13.2 Pagination

Linear uses Relay-style cursor pagination with forward (`first`/`after`) and backward (`last`/`before`) traversal. Source's present page-number interface can be supported with a bounded cursor ledger keyed by normalized resource, scope, filter, sort and revision:

1. Page zero starts without a cursor.
2. Each result records the cursor for the next page.
3. A request for an uncached distant page walks cursors only up to a strict bound; otherwise it asks the client to restart or use search/filter to narrow the set.
4. A filter, sort, projection revision or epoch change invalidates the ledger.
5. Total count remains absent unless Linear returns it cheaply for that query.

The first adapter advertises a maximum page size of 50 even if the external service permits more. This matches Linear's normal pagination default and bounds API cost. Source must not invent a total or imply that a page is current after its cursor epoch changes.

### 13.3 Filtering and search

The `issues` resource initially supports bounded combinations of:

- Identifier/title `contains`
- Team, project, cycle, status, assignee, priority and label equality
- Created/updated date comparisons
- Sort by updated time, created time, priority or identifier where Linear supports it

Full-text or relevance search uses the optional knowledge-provider `search` method. Results return ordinary summaries with provenance and can be opened through `getObject`. Search never grants visibility that list or detail retrieval would deny.

## 14. Synchronization and freshness

### 14.1 Read-through first slice

The first useful implementation may query Linear on demand with a small time-bounded cache. This keeps webhook/index complexity out of the value proof. Provider state reports `live`, `stale`, `degraded` or `offline`; cached rows never masquerade as current.

### 14.2 Webhook-indexed mode

After the read model is useful, webhooks maintain a local index and invalidate details:

1. Read and retain the raw request body.
2. Check timestamp freshness.
3. Verify `Linear-Signature` using HMAC-SHA256 and a timing-safe comparison before accepting data.
4. Deduplicate the unique `Linear-Delivery` id.
5. Persist a small invalidation/event record and answer successfully within Linear's delivery deadline.
6. Refetch the affected authoritative objects asynchronously with bounded concurrency.
7. Apply only a revision at least as recent as the cached object's `updatedAt`.
8. Tombstone removed objects and invalidate affected projection branches.

The webhook payload is a change signal, not the permanent canonical cache record. Targeted refetch normalizes fields, applies current permissions and avoids making webhook schema a second adapter model.

Linear expects a successful webhook response within five seconds and retries failed delivery on a limited schedule. The HTTP endpoint therefore performs verification and durable enqueueing only; it never rebuilds a projection synchronously.

### 14.3 Reconciliation

Webhooks can be missed, disabled or arrive out of order. A resumable reconciliation pass compares objects updated since the last safe watermark and repairs tombstones and projection indexes. It runs on installation, after a detected gap and at a deliberately low cadence—not as high-frequency polling.

### 14.4 Rate limits

The adapter reads Linear's rate-limit response headers, maintains a shared budget per installation, and backs off before exhaustion. Interactive object detail has priority over background indexing. On exhaustion:

- Serve authorized cached data with a visible stale marker when allowed
- Refuse uncached reads with a retry time
- Pause reconciliation and nonessential enrichment
- Never spin, fan out retries or let each browser create an independent polling loop

Rate-limit constants remain configuration learned from responses and official constraints, not assumptions embedded in the knowledge protocol.

## 15. Security

### 15.1 OAuth and scopes

Production installation uses OAuth 2.0. The MVP requests `read` only. It does not request `admin`, `write`, `issues:create`, `comments:create` or time-scheduling scopes.

Webhook setup should use the OAuth application's configured webhook where practical. If installation requires an administrator to configure an endpoint, that is an explicit deployment step; the adapter must not request broad API authority merely to automate setup.

Development may use a personal API key in a local secret store, but that mode is labelled single-user and must not be the default shared deployment.

### 15.2 Tenant and identity isolation

- Cache keys include provider installation and workspace id.
- One provider instance never serves another installation's cache.
- Configured team scope is applied server-side to every query and projection.
- Source RPC authorization may be stricter than the Linear installation's access.
- The MVP does not claim per-user Linear impersonation. It exposes only the service installation's deliberately scoped data to Source principals explicitly authorized for that provider.
- Private-team names, counts and missing-object distinctions are not leaked through search, breadcrumbs, links, errors or MCP.
- Revocation makes the provider unavailable immediately and schedules secure cache purge according to retention policy.

### 15.3 Methods and actions

Read methods are `observe`. Future changes are explicitly named RPC methods and go through ordinary Source authorization, effect, deadline, idempotency and AI-grant checks. An action declaration only places an already authorized method beside a relevant row.

Neither Markdown links nor projection membership grant an operation. The browser never receives a Linear token to perform a mutation directly.

## 16. Console experience

The adapter uses the general knowledge workspace:

- Left: provider and projection picker with lazy tree
- Centre: tree-scoped, searchable, filterable and paged list
- Right: selected object's Markdown, fields, relationships, comments, provenance and freshness

The initial default projection is `linear.live` for day-to-day work, with `linear.work` and `linear.strategy` readily selectable. A workspace may choose another preference locally; the provider does not modify Linear to remember it.

The read-only test advertises view affordances only:

- An issue, project, initiative or document opens its generic knowledge detail.
- A virtual team, cycle, workflow-state or **No project** group only expands/scopes it.
- If a Linear object is explicitly bound to an executable Source component, a named contextual link can open that component; it does not silently replace the object's own detail.
- The adapter may focus a document block or relationship section, but cannot make activation call a mutation or load remote UI code.

When explicit writes are later installed, an issue may also advertise a typed edit affordance. `linear.work` and `linear.live` may then hint that edit is the natural activation mode, while `linear.strategy` remains view-oriented. A temporary user mode or saved workspace preference wins over that hint. If the issue is read-only or the caller lacks edit authority, activation falls back visibly to view.

Edit activation opens the editor; it does not save. The issue id is bound as argument zero, the remaining fields come from the described method contract, and an explicit Save invokes the method.

The row tail contains only declared actions. In the read-only MVP, “Open in Linear” is a safe source link, not a pretend RPC mutation. When writes are enabled later:

- A one-argument action can invoke directly under normal confirmation rules.
- An action whose method has further arguments opens the existing console method form.
- The issue id is prefilled and locked as argument zero.
- Remaining fields, enum choices and optionality come from method introspection.
- Success invalidates the declaring resource and refetches the issue; the UI does not mutate a row optimistically as if Linear had accepted it.

This reuses one invocation experience and avoids a Linear-specific dialog or action schema.

## 17. MCP exposure

MCP accesses the same provider contract and Source identity as the console. The preferred surface is the generic knowledge capability:

- List providers and projections
- Browse roots/children
- Search summaries
- Read object detail
- Resolve a contextual link
- Invoke explicitly authorized methods when write mode is installed

Convenience names may mention Linear for discoverability, but they delegate to those bounded operations. The adapter must not expose raw GraphQL, OAuth administration, unrestricted filter objects or arbitrary webhook replay as MCP tools.

Every answer includes object references, origin URLs where authorized, retrieval timestamps and provider freshness. AI summaries are derived text and are never stored as Linear evidence without an explicit operation.

## 18. Deferred explicit writes

Writes begin only after the read-only adapter has real use. They are separately enabled in provider props and OAuth scope, and are disabled by default.

Candidate methods, returning the outcome type the library already defines rather than one of this adapter's own:

```ts
import type { RpcWriteOutcome } from '@source-repo/rpc'

editIssue(issueId: string, edit: LinearIssueEdit): Promise<RpcWriteOutcome>
setIssueStatus(issueId: string, statusId: string): Promise<RpcWriteOutcome>
setIssuePriority(issueId: string, priority: LinearPriority): Promise<RpcWriteOutcome>
assignIssue(issueId: string, assigneeId?: string): Promise<RpcWriteOutcome>
moveIssueToProject(issueId: string, projectId?: string): Promise<RpcWriteOutcome>
addIssueComment(issueId: string, markdown: string): Promise<RpcWriteOutcome>
createIssue(input: CreateLinearIssueInput): Promise<RpcWriteOutcome>
```

An earlier draft of this section returned a `LinearIssueRevision` of the adapter's own. That is the mistake `DataWrites.ts` was written to prevent: a stamp or revision invented per node makes two nodes disagree about whether a row has changed while both of their suites stay green. The adapter computes its stamp with `rowStamp` over the fields it is prepared to edit, declares its permissions as an `RpcWritePermissions` document like Source Relational and Source Document do, and gains a conformance column instead of a private convention.

The one genuinely Linear-shaped question is what a stamp means over a row this node does not own. A stamp is a precondition, and Linear can change an issue between the read that produced it and the write that presents it. So a stamp here is computed from the fields the adapter mapped, `updatedAt` included, and a refused write reports the current row rather than retrying—which is the same answer the SQL stores give for a row changed underneath a caller, arrived at from a different direction.

Rules:

- `LinearIssueEdit` is a closed, versioned Source DTO containing only fields this installation is prepared to edit. It is not `Record<string, unknown>`, a Linear SDK input or an arbitrary patch.
- Use `editIssue` as the optional edit affordance; retain narrow methods for common row-tail actions and automations.
- Publish row actions for status, priority, assignment, project movement and comment where their first parameter is the row id. `createIssue` is not a row action.
- The console binds argument zero and draws the remainder from the normal described method schema.
- `addIssueComment` and `createIssue` are non-repeatable commands unless the adapter can prove an external idempotency strategy.
- An unknown external outcome is reported as unknown, then reconciled; it is never blindly retried as a new command.
- Request the narrowest OAuth scopes Linear offers for the enabled methods. Do not request general `write` when `issues:create` or `comments:create` is sufficient for the installed feature.
- A Source AI grant must name the exact method and parameter bounds; a general provider grant is insufficient.
- Creating or linking a native Source work item remains a separate Source operation.

The representative types above are adapter types, not additions to the general knowledge package.

## 19. Failure behaviour

| Failure | Required behaviour |
|---|---|
| Linear unreachable | Serve permitted cache as visibly stale or return typed offline error |
| OAuth revoked/expired | Stop external reads and writes; never loop refresh; mark provider unavailable |
| Rate limited | Respect reset/backoff, prioritize foreground reads, expose retry time |
| Webhook signature/timestamp invalid | Reject without parsing into domain state; record bounded security diagnostic |
| Duplicate webhook | Acknowledge once and do no duplicate work |
| Out-of-order update | Compare revision/update time and retain newer state |
| Object removed | Tombstone it, remove occurrences and make old links resolve visibly as unavailable |
| Team becomes inaccessible | Remove its rows, search entries, counts and occurrences from served results |
| Projection rebuilt | Increment projection revision and invalidate occurrence cursors |
| API field deprecated | Adapter contract test fails or degradation is reported; generic contract is unchanged |
| Unsupported Source filter | Refuse explicitly rather than client-side full-scan |
| Private asset unavailable | Retain safe metadata/source link; do not leak adapter credentials |
| Write outcome uncertain | Return unknown outcome and reconcile before another attempt |

## 20. Testing strategy

### 20.1 Unit and fixture tests

- Stable UUID-based `KnowledgeRef` mapping
- Markdown and typed-link extraction without changing source text
- Object identity across work, strategy and live occurrences
- Deterministic virtual group and occurrence ids
- Link inheritance, nearest occurrence and visible fallback
- Filter translation and refusal of unsupported operators
- Cursor-ledger paging, epoch invalidation and absent totals
- Default-column paths validated against row schemas
- Comment and content truncation boundaries
- No credentials in props, state, errors, logs, objects or serialized fixtures

### 20.2 Webhook and cache tests

- Valid signature and timestamp
- Invalid, replayed and stale deliveries
- Duplicate delivery id
- Out-of-order update and remove events
- Durable enqueue before acknowledgement
- Targeted refetch and projection invalidation
- Missed-event reconciliation
- Revocation and cache purge
- Rate exhaustion and backoff without request storms

### 20.3 Authorization tests

- Included and excluded team scope
- Hidden object absent from list, tree, search, link and MCP
- Hidden ancestor/count non-disclosure
- Source principal with narrower access than the Linear installation
- Read-only provider refusing every mutation
- Explicit-write provider still requiring exact RPC method authorization
- Row action and direct method invocation producing identical authorization decisions

### 20.4 Integration tests

A dedicated Linear test workspace exercises the official API behind an opt-in suite. Recorded fixtures are sanitized and versioned for deterministic CI. A contract probe runs against current Linear schema/deprecation information on a schedule but does not make ordinary unit tests depend on the network.

## 21. Delivery slices

### Slice A — Useful read-only browser on current RPC

- OAuth read installation and provider state
- List issues/projects/documents with schemas, paging and bounded filters
- Fetch Markdown detail and preserve Linear URLs
- Use the existing console scope/list/detail mechanics
- No webhooks, writes, board or general new projection protocol

### Slice B — General knowledge contract and three projections

- Map stable objects, content blocks, relationships and origins
- Implement work, strategy and live projection descriptors
- Resolve projection-aware links
- Use list resources temporarily where lazy tree support is not yet available

### Slice C — Lazy trees and presentation defaults

- Adopt generic `getChildren` for branch-sized retrieval
- Publish default columns
- Add projection selection and detail rendering to the console
- Reuse the method form for any multi-argument row action in test fixtures

### Slice D — Fresh indexed operation and MCP parity

- Verified webhooks, cache invalidation and reconciliation
- Rate-budget state and stale/offline UI
- Generic knowledge MCP operations with identical authorization
- Security and conformance suite

### Slice E — Narrow writes, only if justified

- Enable a small set of explicit methods and targeted OAuth scopes
- Present them through existing row actions and typed argument forms
- Add unknown-outcome reconciliation and exact AI grants
- Do not add a generic Linear update method

Each slice is independently deployable. Failure to justify Slice E does not diminish the value of the read-only knowledge adapter.

## 22. Acceptance criteria

The Linear adapter is accepted when:

1. It can be installed or removed without changing Source RPC core, the native work model or another provider.
2. Read-only usefulness is demonstrated before any write scope is requested.
3. An issue retains one `KnowledgeRef` across work, strategy and live projections.
4. Tree expansion and lists are bounded and never require a whole-workspace download.
5. Issue descriptions, relationships, origin and freshness are visible from one selection.
6. The Live projection is driven by explicit Linear fields rather than AI inference.
7. Projection-aware links inherit context and show any fallback.
8. Source-side policy can hide an issue consistently from tree, list, search, link and MCP.
9. No token or authenticated private asset URL reaches browser or MCP.
10. Rate limiting and external unavailability produce bounded, visible degradation.
11. Webhook replay, duplication and out-of-order delivery do not corrupt the cache.
12. Generic possible columns come from the row schema; only defaults are adapter hints.
13. The read-only test activates view only; later projection/workspace mode may open edit, but activation itself never saves or invokes a mutation.
14. A future edit or multi-argument action opens the standard typed method form with the issue id bound, while the underlying method retains all security and command semantics.
15. No Linear SDK or GraphQL type appears in the general knowledge package's public contract.
16. The implementation requires no Source RPC core feature beyond lazy tree retrieval and optional default columns.

If criterion 16 fails, implementation pauses for an anti-monster review. The default decision is to keep the new requirement Linear-specific until another provider independently needs it.

## 23. Rejected alternatives

### Model each issue as an RPC component

Rejected because external row count would become runtime topology and lifecycle count. Issues are passive virtual objects behind one provider.

### Mirror Linear into `RpcComponent.state`

Rejected because snapshots are the wrong transport for a large, filtered, paged, externally owned collection.

### Use the Linear board as the general knowledge UI

Rejected because the important experience is rich description plus current context. Board layout is one optional presentation over issues, not the information model.

### Expose GraphQL for flexibility

Rejected because it bypasses bounded schemas, stable contracts, cost controls and semantic authorization, and would couple every client to Linear.

### Add Linear-specific action dialogs

Rejected because the existing action identifies an RPC method and the console already knows how to draw its typed arguments. View/edit activation and row-tail actions can both bind the issue id as the first argument; the normal form handles the rest.

### Treat webhooks as authoritative records

Rejected because delivery may be duplicated, missed or reordered and webhook payload shape is not the adapter's stable Source contract. Webhooks invalidate; bounded refetch normalizes.

### Synchronize every issue into native Source work

Rejected because an external planning issue and an executable Source work item have different authority and lifecycle. Explicit links preserve that distinction.

## 24. Decision summary

Build Linear first, but make it earn every abstraction:

- A single optional adapter serves many passive objects.
- Three provider-owned projections validate contextual structure.
- Source RPC contributes only generic collection mechanics it nearly has already.
- The console reuses schemas, paging, filtering, links, higher-level view/edit mode, default actions and its method argument form.
- OAuth, GraphQL, webhooks, rate limits and Linear semantics remain inside the adapter.
- Read-only value comes first; narrow named writes come later, if at all.
- Native Source work and execution remain independent and explicitly linked.

Under these boundaries, Linear is not the first limb of a monster. It is a demanding conformance fixture with practical value.

## 25. References

- [Linear Developers overview](https://linear.app/developers)
- [Linear GraphQL API](https://linear.app/developers/graphql)
- [Linear TypeScript SDK](https://linear.app/developers/sdk)
- [Linear OAuth 2.0 authentication and scopes](https://linear.app/developers/oauth-2-0-authentication)
- [Linear pagination](https://linear.app/developers/pagination)
- [Linear filtering](https://linear.app/developers/filtering)
- [Linear rate limiting](https://linear.app/developers/rate-limiting)
- [Linear webhooks](https://linear.app/developers/webhooks)
- [Linear API deprecations](https://linear.app/developers/deprecations)
- [Linear conceptual model](https://linear.app/docs/conceptual-model)
- [Linear teams](https://linear.app/docs/teams)
- [Linear projects](https://linear.app/docs/projects)
- [Linear initiatives](https://linear.app/docs/initiatives)
- [Linear documents](https://linear.app/docs/documents)
- [Linear private asset handling](https://linear.app/developers/how-to-upload-a-file-to-linear)
