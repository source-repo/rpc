# @source-repo/query

The pull half of a control network: a [TanStack Query](https://tanstack.com/query) cache over `$data`, whose freshness comes from the publisher rather than from a clock. Its own version line, built against the library's public APIs only.

```
npm install @source-repo/query
```

- **Confirmed current, not "probably still good"** — a page drawn at the revision the component channel currently holds has had nothing published over it, which is a fact from the source rather than a policy computed from a timer.
- **Three states, never two** — `current`, `possibly-changed`, and `unknown` for where nothing is watching. A `current` that is sometimes a guess would be worth nothing.
- **A period that costs nothing while the plant is quiet** — a tick over a `current` page asks for nothing at all, and the same period behaves exactly as before against a moving one.
- **`semantics` decides whether a retry is safe** — a cache retries three times by default, which is right only because a `query` is a query; undeclared means undeclared, and nothing is retried.
- **A deadline is a budget across attempts** — every attempt gets what remains of what the caller declared, and one that arrives with none left is refused rather than sent.
- **Not a browser thing** — `@tanstack/query-core` is framework-agnostic, so two Node services pulling from a third get the same dedup, arithmetic and freshness.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/query/README.md). On npm: [@source-repo/query](https://www.npmjs.com/package/@source-repo/query).
