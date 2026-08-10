# @source-repo/document

**Source Document** serves an existing MongoDB database to a Source RPC network as DataProvider resources — real collections, paged, filtered and ordered on the database.

```
npm install @source-repo/document
```

- **One contract, a second backend.** The verb is `$data`, the same one a component's own record and [`@source-repo/relational`](./relational.md) answer. A console that can browse a SQL table can browse a Mongo collection with no code written for the difference.
- **Reads only** — `getList`, `getMany` and `getManyReference`. No `create`, `update` or `delete`, for the same reason as everywhere else here: a value is never written over this bus, a method is called.
- **It owns nothing.** Delete the node and nothing is lost but the ability to ask.

## Not only MongoDB

The driver is `mongodb`, so this serves anything that speaks the MongoDB wire protocol — and several databases do. [FerretDB](https://www.ferretdb.com/) (open source, PostgreSQL underneath), [Amazon DocumentDB](https://aws.amazon.com/documentdb/), [Azure Cosmos DB for MongoDB](https://learn.microsoft.com/azure/cosmos-db/mongodb/) and [Oracle Database API for MongoDB](https://docs.oracle.com/en/database/oracle/mongodb-api/) all present the same interface over quite different engines.

That is worth more here than it would be to most applications, because **this node uses very little of MongoDB**: `listCollections`, `find`, `sort`, `countDocuments`, and one `aggregate` pipeline. Compatibility layers implement that core first and best — it is the aggregation framework, transactions and change streams where they diverge, and none of those are on this path.

The honest caveat: the one pipeline uses `$unset` and a binary collation, which is the likeliest place a compatible-but-not-identical engine differs. So treat a non-MongoDB backend as **worth testing rather than assumed** — and note that when compatibility does fall short it fails visibly, as a query error naming the stage, rather than by quietly returning the wrong rows.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/document/README.md). On npm: [@source-repo/document](https://www.npmjs.com/package/@source-repo/document).
