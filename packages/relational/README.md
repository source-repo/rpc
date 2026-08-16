# @source-repo/relational

**Source Relational** serves an existing SQL database to a [Source RPC](https://github.com/source-repo/rpc) network as DataProvider resources. A console, a flow, a script or a model browses real tables — paged, filtered and ordered on the database rather than in the browser — without leaving the mesh and without anything between it and the table knowing that a database is involved.

The verb is `$data`, the same one a component's own record already answers. That is the point: this package adds a backend, not a protocol.

This is a tool node in the sense `@source-repo/queue` established — its own package with its own version, deliberately *not* bound to the rpc/rpc-cli versions-together rule, built against the library's public APIs only.

## The one paragraph to read before trusting it

**This node owns nothing.** It holds a connection to a database somebody else owns and answers questions about it; delete the node and nothing is lost but the ability to ask. `exposeRelational` serves **reads only** — `getList`, `getMany` and `getManyReference`. There is no `create`, `update` or `delete` on `$data`, and that is a rule rather than an omission: a value is never written over this bus, a method is called.

**Writes are a second node, and importing one is a visible line in a diff.** `@source-repo/relational/writes` publishes `create`, `update` and `delete` as ordinary `@rpc` methods in a namespace of their own, which is what keeps the rule intact rather than bending it: `authorize()`, the deadline, the execution queue, the owner fence, the AI grants ladder and the idempotency store rule on each of them exactly as they do on any other command. It writes nothing without a permission document, every change carries the stamp the row was read under, and something holding a `RelationalService` can never turn out to have been holding a writable one. See [the write half](#the-write-half).

## Serving a database

```typescript
import { Kysely, PostgresDialect } from 'kysely'
import { RpcServer } from '@source-repo/rpc'
import { exposeRelational } from '@source-repo/relational'

const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
const server = new RpcServer({ name: 'plantDb', transports: [{ port: 7843 }] })

await exposeRelational(server, 'sql', {
    db,
    flavour: 'postgres',
    // A node points at a database somebody else owns, and "serve everything you can see" is
    // rarely what its operator meant.
    catalogue: { tables: (name) => name.startsWith('plant_') }
})
```

`exposeRelational` is asynchronous where the queue's equivalent is synchronous, because it has to go and look: exposing first and introspecting after would publish a peer that briefly claims to serve nothing, which a console would cache.

The Kysely instance is yours, so the driver and the credentials are yours. This package depends on `kysely` and on nothing else — `pg`, `mysql2` and the rest are your choice, and no connection string ever appears in a contract.

## What arrives without being written

`db.introspection.getTables()` fills the resource list and the column types fill each row's shape, so a viewer draws columns for a table nobody wrote a contract for. Nothing is written twice and nothing drifts — `@source-repo/queue` maintains its row type by hand and its own comment calls that "a real cost of this interface". Here the database already knows.

The primary key comes from the flavour rather than from Kysely, which reports columns and says nothing about keys. A table without a **single-column** key cannot name a row, so it is **not served** — and it is listed in `props.unserved` with the reason, because a table missing from a scope tree is otherwise indistinguishable from a table that does not exist. Views are excluded by default and have no key at all; both they and composite-key tables become servable by declaring which column identifies a row:

```typescript
catalogue: { views: true, ids: { active_customers: 'id', reading: 'reading_id' } }
```

Being wrong there is not a rendering glitch — an id that is not unique makes `getMany` answer one row for a question about another — so it is declared by whoever runs the node rather than inferred.

## Dialects, and what "several flavours" honestly means

One package, three flavours: `postgres`, `mysql` and `sqlite`, behind one contract. That is the one-contract-many-backends rule arriving as configuration rather than as three packages.

A flavour carries exactly three things, because they are the only ones that change an *answer* rather than the syntax around it — Kysely absorbs the rest.

**Matching text is case-sensitive, whatever the database would have done.** `LIKE` is case-sensitive on Postgres and case-insensitive under both SQLite's default and MySQL's usual collation, so Postgres and MySQL disagree with each other before a document store is anywhere near the conversation. The library's in-memory implementation uses `String.prototype.includes`, so case-sensitive is normative here and each flavour pays what that costs it: `strpos`/`starts_with` on Postgres, `instr`/`substr` on SQLite, `locate` over a binary cast on MySQL. Each is also chosen to need **no escaping**, so a `%` typed into a filter box is a percent sign rather than a wildcard.

**Ordering is by byte, and a missing value is the greatest one.** The same disagreement wearing a different hat, and easy to fix for `contains` and forget for `ORDER BY`. The in-memory comparator is `String(a) < String(b)`, so ordering is by UTF-16 code unit — capitals before lowercase — and an absent value sorts after everything ascending, first descending. Postgres orders by the database's locale and MySQL's usual collation is case-insensitive, so a text column is ordered under an explicit binary collation on all three; and SQLite and MySQL both call NULL the *smallest* value, so both are told otherwise — `NULLS LAST` on SQLite, and `ORDER BY (col IS NULL), col` on MySQL, which has no such syntax at all.

**Finding the primary key**: `pragma_table_info` on SQLite, `information_schema` on the other two.

## Conformance

`Servers.sql.test.ts` asks all three backends the same thirteen questions and compares the answers against what the library's in-memory implementation would have said. That comparison is the only thing that makes "one contract, many backends" more than a claim, and it earns itself: three of the thirteen fail on at least one engine's defaults.

**The write half is asked nine more**, and they are the ones where a divergence costs something irreversible: a change under a fresh stamp, the same stamp twice, a stamp belonging to another row, a field outside the rule, a removal and then a second one, and a change to a row that has gone. A stamp meaning one thing on one engine and another elsewhere would be a compare-and-set that holds on one and not the other, and its only symptom is a lost update. Alongside them one question about the stamp itself: that a node digests exactly the fields its rule permits, over the row **as it published it** — stamp what the driver returned instead and this fails on SQLite, where a boolean comes back as 1 and the resource says boolean. All ten are asked of MongoDB too.

SQLite always runs — `node:sqlite`, no server, no native module — so the suite is never entirely skipped. Postgres and MySQL run when they are up:

```
docker compose -f docker-compose/docker-compose.yml up -d
npm test --workspace=@source-repo/relational
```

and are skipped with a reason when they are not. `SOURCE_RPC_REQUIRE_SQL=1` turns that skip into a failure, which is what CI sets alongside the servers it starts — a run that reports itself green having quietly compared one backend against itself is worth nothing.

**One divergence survives and is declared rather than hidden.** MySQL's `boolean` is an alias for `tinyint(1)`, and the introspector reports `tinyint` with the width already gone — so nothing at this level can tell a flag from a small number, and such a column is published honestly as a number rather than dishonestly as a boolean. On SQLite, which has no boolean type either but keeps the declared name, the column is a boolean and the 1 and 0 coming back are corrected to match.

## What it refuses, and why refusing is the feature

The wire's filter language is a closed set of facts about a comparison — eight operators, `all`/`any`, operands that can only be a string, a number, a boolean or null. Translating it is nearly mechanical. Three things are not, and each is refused rather than guessed:

- **A field that is not a column.** Kysely binds values and does not bind identifiers, so a column reference is a string that becomes SQL. Every field is checked against the catalogue first; quoting is the second line of defence, not the first.
- **A dot path.** Native in a document store, meaningful in SQL only inside a JSON column, and meaningless otherwise. Serving it would mean the same query returning different rows on two backends with no error anywhere.
- **A comparison between kinds that do not compare.** `name > 20` answers false in memory, because `20 > '9'` having an answer at all is how a threshold silently stops working. Over a table it is refused instead — a column has one type, so a mismatched operand is never a partial match, and a filter that quietly matches nothing looks exactly like one that worked.

A refusal crosses the wire as an error naming what would have been right, and is counted apart from a query that reached the database and failed there.

## Two things this deliberately does not hide

**`ne` matches a row whose column is NULL.** The in-memory rule is that a missing field never matches *except* under `ne`, because an operator asking for "not bad" means to see the rows that never reported a quality at all. SQL's `<>` drops NULL rows, so that agreement costs an extra clause here — it is not something the database does on its own.

**Offset paging renumbers rows underneath a pager.** `page * pageSize` becomes `OFFSET`, and a table being written to while somebody pages it will show a row twice or not at all. Every order is made total by appending the key, which removes the far more common version of this failure — a sort on a column half the rows share — but nothing here can make a moving table hold still. The `epoch` and `revision` on every answer say *this peer restarted*, not *the data changed*; do not read them as covering this.

**A mistyped table name is an error, not an empty table.** `$data` otherwise falls back to serving a path out of a component's own props and state, which is right for a record that may not have been populated yet and wrong for a database, whose tables are a closed published list — `total: 0` for `custmers` would render as a table that exists and holds nothing. The refusal names what is served.

## The write half

Rows can be created, changed and removed — by a second node, from a second import, under a permission document, with a precondition on every change.

```typescript
import { exposeRelationalWrites } from '@source-repo/relational/writes'

await exposeRelationalWrites(server, 'sql.write', {
    db,
    flavour: 'postgres',
    // Absent means nothing is writable. This is the whole of the permission model, and it is data
    // rather than a callback for the reason the AI grants document is: a console can render data,
    // and a reviewer can diff it.
    writes: {
        work_orders: { verbs: ['create', 'update'], columns: ['status', 'note', 'assigned_to'] },
        recipes: { verbs: ['update'], columns: ['setpoint'] }
    }
})
```

**It is a separate class in a separate namespace, and that is the design rather than tidiness.** Two namespaces are two `authorize()` surfaces, so an operator can grant reading to everyone and writing to nobody. A subclass would have made "may call the database" one permission and would have made the read-only class's promise a lie by inheritance — code holding a `RelationalService` could have been holding a writable one. And the subpath export means importing it shows up in a diff instead of being an option somebody set. It is the split [`@source-repo/docker`](./../docker/README.md) already makes between reading containers, controlling them and creating them.

**The rule about writes is intact rather than bent.** Every method here is an ordinary `@rpc` method with declared `semantics` and `effect`, so the deadline, the execution queue, the owner fence, `authorize()` with the table and the patch visible in `params`, the [AI grants](../../docs/ai-in-the-plant.md) ladder and the idempotency store all apply as they do to any other command. There is no `$write` verb beside `$data` and there is not going to be: a dispatch-level write would sit outside every one of those gates unless each were re-invoked by hand, which is a list somebody has to keep complete.

**Nothing is writable by default**, and composing the node in with a usable document is what says otherwise: it announces itself through [`elevation()`](../../docs/security-model.md#changing-somebody-elses-store), so a console watching a plant can say "this node can write `work_orders`" without calling anything.

### The precondition

`update` and `delete` take a **stamp**, and it is required rather than optional:

```typescript
const read = await writer.getOne('work_orders', '4711')          // { status: 'ok', row, stamp }
await writer.update('work_orders', '4711', { status: 'done' }, read.stamp)
```

A stamp is a digest of the row's writable fields, its id and its resource. The only way to hold one is to have read the row, which is what makes a change compare against what was actually looked at — and an optional precondition is one that gets omitted the first time somebody is in a hurry, while the failure it prevents leaves no trace anywhere for anyone to find. It is the same mandatory compare-and-set `msgrpc.updateTopology`'s `expectedVersion` is, for the same reason.

A stale stamp answers `{ status: 'conflict' }` and writes nothing. **The conflict carries no stamp**, deliberately: handing back the current one would put a blind overwrite a single call away, which is a compare-and-set comparing against itself. A caller that means to proceed reads the row again and decides again.

What the stamp covers falls out of the permission document rather than being a second decision: it is the fields the rule permits, so a trigger touching `updated_at` is not a conflict — a precondition that fails for a reason nobody can act on is one that gets switched off within a week — while two callers writing different permitted fields of the same row do conflict, and the second re-reads before deciding.

The comparison is made under whatever hold the engine offers. Postgres and MySQL take `for update`, because under their default isolation two callers can otherwise both read the row, both find the stamp they expected, and both write — the precondition failing to be a precondition, silently, in exactly the case it exists for. SQLite needs nothing, because this package's dialect serialises every statement onto one connection; that is a property of the dialect rather than of SQLite, so the flavour states it rather than the service assuming it.

### What it refuses

- **A table nobody listed**, naming what is writable — which is the answer to "can I change this", and is often no.
- **A rule that names something the database does not have.** A rule is honoured whole or dropped whole and the reason lands in `props.refused`, because a misspelled table otherwise produces a node that refuses every edit to it, which reads exactly like a deliberate policy with nothing anywhere to say the policy was never loaded.
- **A view**, whose writability is the engine's business rather than this node's.
- **A field outside the rule** — refused rather than ignored, and the whole patch is refused with it. A patch half-applied and then rejected leaves a row in a state nobody asked for, and the error names none of it.
- **A value the column cannot hold.** Checked rather than converted: `'80'` into a numeric setpoint is what JavaScript and MySQL will both happily make 80, and the one time the string is `'8O'` the column ends up holding 0 with nothing reporting it. A date arrives as an ISO string and never as a number, since epoch seconds and epoch milliseconds are both ordinary conventions and a number does not say which.
- **A `bytes` column**, because a JSON row has no declared encoding for one and both candidates are defensible.
- **An update that names the id.** A row that renames itself leaves every reference to it dangling. The same column stays creatable, which is what a natural key needs.
- **A required column a `create` omitted**, named here rather than by three engines in three different sentences none of which was written for whoever is holding the console.

### `getOne`, and why this one is worth the wire

The read side declines to serve `getOne` and is right to: a caller wanting one row asks `getMany` for one id, and a verb existing only to be a worse version of another is not worth the wire. The one here is a different verb wearing the same name — it answers the **precondition**, which `getMany` does not carry at all, and since the only way to hold a stamp is to have read the row, it is what makes compare-and-set possible rather than a parameter callers invent.

### What is not here

**No `updateMany` or `deleteMany`.** react-admin has both and a grid's multi-select wants them, but a bulk delete over a filter is the single most dangerous call this surface could offer and the one where a mistaken predicate is indistinguishable from a correct one until the rows are gone. Fifty changes are fifty calls, each with its own precondition, each individually refusable and individually visible in an audit line.

**No per-table effect.** The three verbs all declare `effect: 'operate'`, so an AI principal granted `ai.tool.write` may write any allow-listed table. The allow-list is the granularity, and a table whose writes should need a programming grant belongs on a node of its own with a credential of its own. `authorize()` still sees the table name in `params` and can rule per table. The one method that is *not* `operate` is `refresh`, which declares `program` — it decides what the node is able to write for every call after it, so its blast radius is not one row, and a principal permitted to edit rows all day is still not permitted to re-resolve the permission document.

**Execution stays at least once without an idempotency store.** All three verbs declare `non-repeatable-command`, so a host with a store answers a redelivered frame from the record; a host without one has the same honest limit every command on this bus has. The precondition makes a repeated `update` or `delete` answer `conflict` rather than apply twice, which is safe but is not the same as correct — a repeated `create` is the one that inserts a second row.

## Counting, and when not to

`total` is what a pager needs to say "3 of 47", and most tables can afford it. On a large one it is the expensive half: `LIMIT 50` is answered from an index and `COUNT(*)` over the same predicate walks it. Every answer reports `queryMs` and `countMs` apart precisely so that is visible rather than inferred — a fast page behind a slow count wants the count asked for less often, and a slow page wants an index.

Where a table cannot afford it, `count: false` omits the count entirely. `total` is then **absent** — never zero — and `hasMore` carries the pager on its own, answered by asking for one row more than the page and seeing whether it arrives. The console pages on either.

## Development

```
npm test        # SQLite only: no server, no native module
```

The test fixture is chosen for the disagreements rather than for realism: two rows differing only in case, a null column, a table with a composite key and one with no key at all, and a key that is not called `id`.
