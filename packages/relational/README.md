# @source-repo/relational

**Source Relational** serves an existing SQL database to a [Source RPC](https://github.com/source-repo/rpc) network as DataProvider resources. A console, a flow, a script or a model browses real tables — paged, filtered and ordered on the database rather than in the browser — without leaving the mesh and without anything between it and the table knowing that a database is involved.

The verb is `$data`, the same one a component's own record already answers. That is the point: this package adds a backend, not a protocol.

This is a tool node in the sense `@source-repo/queue` established — its own package with its own version, deliberately *not* bound to the rpc/rpc-cli versions-together rule, built against the library's public APIs only.

## The one paragraph to read before trusting it

**This node owns nothing.** It holds a connection to a database somebody else owns and answers questions about it; delete the node and nothing is lost but the ability to ask. It serves **reads only** — `getList`, `getMany` and `getManyReference`. There is no `create`, `update` or `delete`, and that is a rule rather than an omission: a value is never written over this bus, a method is called. A node that should accept writes declares ordinary `@rpc` methods for them, which `authorize()`, the owner fence and idempotency already rule on.

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

## Counting, and when not to

`total` is what a pager needs to say "3 of 47", and most tables can afford it. On a large one it is the expensive half: `LIMIT 50` is answered from an index and `COUNT(*)` over the same predicate walks it. Every answer reports `queryMs` and `countMs` apart precisely so that is visible rather than inferred — a fast page behind a slow count wants the count asked for less often, and a slow page wants an index.

Where a table cannot afford it, `count: false` omits the count entirely. `total` is then **absent** — never zero — and `hasMore` carries the pager on its own, answered by asking for one row more than the page and seeing whether it arrives. The console pages on either.

## Development

```
npm test        # SQLite only: no server, no native module
```

The test fixture is chosen for the disagreements rather than for realism: two rows differing only in case, a null column, a table with a composite key and one with no key at all, and a key that is not called `id`.
