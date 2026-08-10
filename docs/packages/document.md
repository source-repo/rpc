# @source-repo/document

**Source Document** serves an existing MongoDB database to a Source RPC network as DataProvider resources — real collections, paged, filtered and ordered on the database.

```
npm install @source-repo/document
```

- **One contract, a second backend.** The verb is `$data`, the same one a component's own record and [`@source-repo/relational`](./relational.md) answer. A console that can browse a SQL table can browse a Mongo collection with no code written for the difference.
- **Reads only** — `getList`, `getMany` and `getManyReference`. No `create`, `update` or `delete`, for the same reason as everywhere else here: a value is never written over this bus, a method is called.
- **It owns nothing.** Delete the node and nothing is lost but the ability to ask.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/document/README.md). On npm: [@source-repo/document](https://www.npmjs.com/package/@source-repo/document).
