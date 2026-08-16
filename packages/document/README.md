# @source-repo/document

**Source Document** serves an existing MongoDB database to a [Source RPC](https://github.com/source-repo/rpc) network as DataProvider resources. A console, a flow, a script or a model browses real collections — paged, filtered and ordered on the database rather than in the browser — without leaving the mesh.

The verb is `$data`, the same one a component's own record and [`@source-repo/relational`](../relational) already answer. One contract, a second backend.

## The one paragraph to read before trusting it

**This node owns nothing**, and `exposeDocument` serves **reads only** — `getList`, `getMany` and `getManyReference`. There is no `create`, `update` or `delete` on `$data`, and that is a rule rather than an omission: a value is never written over this bus, a method is called. Delete the node and nothing is lost but the ability to ask.

**Writes are a second node, and importing one is a visible line in a diff.** `@source-repo/document/writes` publishes `create`, `update` and `delete` as ordinary `@rpc` methods in a namespace of their own, which is what keeps the rule intact rather than bending it: `authorize()`, the deadline, the execution queue, the owner fence, the AI grants ladder and the idempotency store rule on each of them exactly as they do on any other command. It writes nothing without a permission document, and every change carries the stamp the document was read under. See [the write half](#the-write-half).

## Serving a database

```typescript
import { MongoClient } from 'mongodb'
import { RpcServer } from '@source-repo/rpc'
import { exposeDocument } from '@source-repo/document'

const client = new MongoClient(process.env.MONGO_URL!)
await client.connect()

const server = new RpcServer({ name: 'plantDocs', transports: [{ port: 7843 }] })
await exposeDocument(server, 'docs', {
    db: client.db('plant'),
    // A node points at a database somebody else owns, and "serve everything you can see" is
    // rarely what its operator meant.
    catalogue: { collections: (name) => !name.startsWith('system.') }
})
```

The `Db` is yours, so the connection string and its credentials are yours, and no connection string ever appears in a contract.

## What a document store can and cannot say about itself

This is the whole of what differs from the SQL node, and every difference is declared rather than smoothed over.

**A row shape is a declaration or a guess, and the answer says which.** A collection created with a `$jsonSchema` validator has a real declaration the server enforces on every write, and it is used as a table's columns are. Otherwise a bounded number of documents (twenty by default) are read and their fields collected — and that shape is labelled as inferred: the object is left **open**, a field seen in some documents and not others is **optional**, a field holding different kinds becomes a **union**, and `props.shapes` publishes where each shape came from and how many documents it was drawn from. A sampled shape presented as a contract would be the worst outcome available — a grid drawing columns from twenty documents over a collection whose twenty-first differs, with nothing saying the shape was a guess.

**There is nothing to check a field name against.** The SQL node whitelists every field against the columns it introspected, and that whitelist is what stands between a filter and an injected identifier. A collection has no such list — a field exists on the documents that happen to have it, and sampling can prove a field is *there*, never that it is not. So the defence is **structural rather than a lookup**: a segment beginning with `$` is an operator in a field position and is refused, an empty segment is a path nobody meant, a NUL cannot have been typed, and a path deeper than eight segments is a caller that built it wrongly. Anything well-formed is allowed through, including a field nobody has sampled — it simply matches nothing.

**A dot path reaches inside a value**, which the SQL node refuses precisely because it means something different there. That is a capability difference rather than a weaker version of the same thing.

**An ObjectId travels as its twenty-four hex characters** and is rebuilt on the way in. Without that, `{ _id: { $in: ['65…'] } }` is a perfectly valid query that matches nothing at all — silently, which is the failure that shape prevents. A collection whose `_id` kinds are mixed is compared as text, and says so in `props.shapes`.

## What it agrees with, and what that cost

The library's in-memory implementation is normative — its rules are written down and argued for in `DataProvider.ts` — and the same fifteen conformance questions are asked of this node and of SQLite, Postgres and MySQL, along with the nine that ask what a change does and one that asks what a stamp is a digest of. Two of the agreements are free here and two are not:

- **Free: `ne` matches a document that lacks the field.** The in-memory rule's deliberate exception — "not bad" means to see the documents that never reported a quality — and `$ne` already does it, where SQL has to spend a clause.
- **Free: ordered comparisons do not compare across kinds.** `{ age: { $gt: 20 } }` does not match `"abc"`, which is the same refusal to invent an order that the in-memory implementation makes and SQL would coerce its way through.
- **Paid: where a missing value belongs in an order.** MongoDB sorts missing and null before everything; the in-memory rule is that missing is the *greatest* value — last ascending, first descending. There is no `NULLS LAST` to ask for, so the nullness is computed into a field and ordered ahead of the real one, which makes every ordered page an aggregation rather than a `find`. It is the same trick MySQL needs, for the same reason.
- **Paid: escaping.** `contains` and `startsWith` become `$regex`, and an unescaped operand is a user-supplied regular expression evaluated per document — exactly the stall `DataProvider.ts` warns about, where the provider this design came from compiled an operator's search box straight into `new RegExp`. Every metacharacter is disarmed, and matching stays case-sensitive under the `simple` collation, named explicitly so a collection created with a locale collation cannot quietly answer differently.

**Ordering treats a missing field and a null one as the same**, because that is the only reading that agrees with SQL, where NULL is the only way to have no value. **Filtering keeps them apart**: `eq null` is about a value that is null, and a document that never had the field has no value to be equal to.

## The write half

Documents can be created, changed and removed — by a second node, from a second import, under a permission document, with a precondition on every change.

```typescript
import { exposeDocumentWrites } from '@source-repo/document/writes'

await exposeDocumentWrites(server, 'docs.write', {
    db,
    // Absent means nothing is writable. Data rather than a callback, for the reason the AI grants
    // document is data: a console can render it and a reviewer can diff it.
    writes: {
        workOrders: { verbs: ['create', 'update'], columns: ['status', 'note'] },
        recipes: { verbs: ['update'], columns: ['setpoint', 'limits.high'] }
    }
})
```

**A separate class in a separate namespace, from a separate import** — the same three-way split `@source-repo/relational` and `@source-repo/docker` make, and for the same reasons: two namespaces are two `authorize()` surfaces, a subclass would have made the read-only class's promise a lie by inheritance, and a subpath export makes turning it on visible in a diff. Everything is an ordinary `@rpc` method with declared `semantics` and `effect`, so there is no `$write` verb and nothing is special-cased.

### The precondition, and why it needs no transaction here

`update` and `delete` take the stamp the document was read under, and the only way to hold one is to have read the document:

```typescript
const read = await writer.getOne('workOrders', '4711')
await writer.update('workOrders', '4711', { status: 'done' }, read.stamp)
```

The values that stamp was taken over then travel **in the update's own filter**, so the compare and the set are one operation on the server and there is nothing to interleave between them. That is worth more here than the equivalent is over SQL, where the same guarantee costs a transaction and a `for update`: a multi-document transaction needs a replica set, and this node runs against a standalone `mongod` without one.

A stale stamp answers `{ status: 'conflict' }` and writes nothing, and the conflict carries **no** stamp — handing back the current one would put a blind overwrite a single call away, which is a compare-and-set comparing against itself. What the stamp covers is the fields the rule permits, so a field nobody may write moving underneath a caller is not a conflict.

### What is different from the SQL node

**There is nothing to check a value's *type* against.** The asymmetry the read half already declares runs one level deeper on this side: a SQL column has a type the database will enforce on every row, so `'80'` into a numeric setpoint can be refused at the boundary; a collection has a sampled shape or a validator, and a sample is a guess while a validator is enforced by the server in its own words. So there is no type check here, and a `$jsonSchema` validator is what refuses a wrong value where one exists — which is a real capability difference rather than a weaker version of the same thing.

**What *is* checked is representability**, and structurally rather than by lookup — the same defence the read half uses, applied one level down. A field path with a `$`-prefixed or empty segment, a NUL or more than eight segments is refused; every key of a patch must match an allow-listed field exactly, so a well-formed path nobody listed is refused rather than written; and inside a value, a key beginning with `$` or holding a dot is refused too, because MongoDB will happily store one and this node could then never filter on it or reach it by dot path — it would have written a field it cannot read back. A `bigint` is refused for the same reason it is coerced on the way out, and a value nested deeper than the walk that produces the wire shape is refused because what lies below it would be stamped as nothing, which would leave a precondition that does not describe what is stored.

**A dot path is a field here**, so `limits.high` is a legitimate thing to allow-list and to write, which the SQL node refuses because it would mean something different there.

## Counting, and when not to

`countDocuments` walks the predicate, which on a large collection is most of the request. Every answer reports `queryMs` and `countMs` apart so that is visible rather than inferred. Where a collection cannot afford it, `count: false` omits the count entirely — `total` is then **absent**, never zero, and `hasMore` carries the pager, answered by asking for one document more than the page.

## Development

**Every test in this package needs a server**, because there is no in-memory MongoDB:

```
docker compose -f docker-compose/docker-compose.yml up -d mongo
npm test --workspace=@source-repo/document
```

Without one the whole package skips itself, which is right on a laptop and would be silent in CI — so `SOURCE_RPC_REQUIRE_MONGO=1` turns that skip into a failure, and CI sets it. That guard matters more here than for the SQL node, which always has SQLite and would still notice most things.
