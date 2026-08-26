# @source-repo/relational

**Source Relational** serves an existing SQL database to a Source RPC network as DataProvider resources — real tables, paged, filtered and ordered *on the database* rather than in the browser.

```
npm install @source-repo/relational
```

- **The verb is `$data`**, the same one a component's own record already answers. This package adds a backend, not a protocol — so anything that can browse a component's tags can browse a table, without knowing a database is involved.
- **`$data` reads only**, and that is a rule rather than an omission: `getList`, `getMany` and `getManyReference`, with no `create`, `update` or `delete` on that verb. A value is never written over this bus; a method is called.
- **Writes are a separate node, in a separate namespace, closed by default.** `exposeRelationalWrites` publishes ordinary `@rpc` methods with declared semantics and effect, so `authorize()`, the owner fence, the deadline and idempotency rule on each one as they do on any other command — and two namespaces are two authorization surfaces, so reading can be granted to everyone and writing to nobody. Which tables and which columns is a permission document a reviewer can diff, absent means closed, and every change carries the stamp the row was read under. See [the write half](https://github.com/source-repo/rpc/blob/main/packages/relational/README.md#the-write-half).
- **A resource stamp, where both halves are wired together.** Share one `RpcResourceStamps` between the read node and the write node and every answer names the state of its table as far as writes this node served are concerned — which is what lets a caching reader tell page two of the same set from page two of a set that moved. Absent unless a writer claimed the table, because a stamp that does not move when the data does is worse than none.
- **It owns nothing.** It holds a connection to a database somebody else owns and answers questions about it. Delete the node and nothing is lost but the ability to ask — which is what makes serving somebody else's system of record an ecosystem tool rather than a product.
- **Filtering happens where the data is**, so a search matching nothing transfers nothing. That is the property no amount of client-side filtering can have, because discovering that nothing matched is exactly what a browser would have to receive everything to find out.

Built on [Kysely](https://kysely.dev/), so the dialect is the one your database already speaks.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/relational/README.md). On npm: [@source-repo/relational](https://www.npmjs.com/package/@source-repo/relational).
