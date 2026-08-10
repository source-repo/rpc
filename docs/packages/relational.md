# @source-repo/relational

**Source Relational** serves an existing SQL database to a Source RPC network as DataProvider resources — real tables, paged, filtered and ordered *on the database* rather than in the browser.

```
npm install @source-repo/relational
```

- **The verb is `$data`**, the same one a component's own record already answers. This package adds a backend, not a protocol — so anything that can browse a component's tags can browse a table, without knowing a database is involved.
- **Reads only**, and that is a rule rather than an omission: `getList`, `getMany` and `getManyReference`, with no `create`, `update` or `delete`. A value is never written over this bus; a method is called. A node that should accept writes declares ordinary `@rpc` methods, which `authorize()`, the owner fence and idempotency already rule on.
- **It owns nothing.** It holds a connection to a database somebody else owns and answers questions about it. Delete the node and nothing is lost but the ability to ask — which is what makes serving somebody else's system of record an ecosystem tool rather than a product.
- **Filtering happens where the data is**, so a search matching nothing transfers nothing. That is the property no amount of client-side filtering can have, because discovering that nothing matched is exactly what a browser would have to receive everything to find out.

Built on [Kysely](https://kysely.dev/), so the dialect is the one your database already speaks.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/relational/README.md). On npm: [@source-repo/relational](https://www.npmjs.com/package/@source-repo/relational).
