# @source-repo/document

**Source Document** serves an existing MongoDB database to a [Source RPC](https://github.com/source-repo/rpc) network as DataProvider resources. A console, a flow, a script or a model browses real collections — paged, filtered and ordered on the database rather than in the browser — without leaving the mesh.

The verb is `$data`, the same one a component's own record and [`@source-repo/relational`](../relational) already answer. One contract, a second backend.

## The one paragraph to read before trusting it

**This node owns nothing** and serves **reads only** — `getList`, `getMany` and `getManyReference`. There is no `create`, `update` or `delete`, and that is a rule rather than an omission: a value is never written over this bus, a method is called. Delete the node and nothing is lost but the ability to ask.

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

The library's in-memory implementation is normative — its rules are written down and argued for in `DataProvider.ts` — and the same fifteen conformance questions are asked of this node and of SQLite, Postgres and MySQL. Two of the agreements are free here and two are not:

- **Free: `ne` matches a document that lacks the field.** The in-memory rule's deliberate exception — "not bad" means to see the documents that never reported a quality — and `$ne` already does it, where SQL has to spend a clause.
- **Free: ordered comparisons do not compare across kinds.** `{ age: { $gt: 20 } }` does not match `"abc"`, which is the same refusal to invent an order that the in-memory implementation makes and SQL would coerce its way through.
- **Paid: where a missing value belongs in an order.** MongoDB sorts missing and null before everything; the in-memory rule is that missing is the *greatest* value — last ascending, first descending. There is no `NULLS LAST` to ask for, so the nullness is computed into a field and ordered ahead of the real one, which makes every ordered page an aggregation rather than a `find`. It is the same trick MySQL needs, for the same reason.
- **Paid: escaping.** `contains` and `startsWith` become `$regex`, and an unescaped operand is a user-supplied regular expression evaluated per document — exactly the stall `DataProvider.ts` warns about, where the provider this design came from compiled an operator's search box straight into `new RegExp`. Every metacharacter is disarmed, and matching stays case-sensitive under the `simple` collation, named explicitly so a collection created with a locale collation cannot quietly answer differently.

**Ordering treats a missing field and a null one as the same**, because that is the only reading that agrees with SQL, where NULL is the only way to have no value. **Filtering keeps them apart**: `eq null` is about a value that is null, and a document that never had the field has no value to be equal to.

## Counting, and when not to

`countDocuments` walks the predicate, which on a large collection is most of the request. Every answer reports `queryMs` and `countMs` apart so that is visible rather than inferred. Where a collection cannot afford it, `count: false` omits the count entirely — `total` is then **absent**, never zero, and `hasMore` carries the pager, answered by asking for one document more than the page.

## Development

**Every test in this package needs a server**, because there is no in-memory MongoDB:

```
docker compose -f docker-compose/docker-compose.yml up -d mongo
npm test --workspace=@source-repo/document
```

Without one the whole package skips itself, which is right on a laptop and would be silent in CI — so `SOURCE_RPC_REQUIRE_MONGO=1` turns that skip into a failure, and CI sets it. That guard matters more here than for the SQL node, which always has SQLite and would still notice most things.
