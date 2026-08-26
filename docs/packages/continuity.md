# @source-repo/continuity

What a component keeps when the process implementing it is replaced: versioned state snapshots, adjacent forward migrations with reviewed defaults, and a record of every value that moved.

```
npm install @source-repo/continuity
```

- **Held state is explicit, and the rule is enforced** — state is structure-cloned before every step, so state living in a language's object layout is refused with the reason rather than discovered at a handoff.
- **One reviewed transform per adjacent version** — vK to vN walks the chain, which is one place per version where somebody had to decide what a new field means.
- **Three outcomes, not three degrees of success** — `total`, `defaulted` with the field, value and grounds recorded, and `impossible`, which refuses rather than inventing a value nothing downstream could tell from a measured one.
- **No separate dry run** — migration is a pure function of an immutable snapshot, so the thing that was checked is the thing that runs.
- **Determinism is checked, not assumed** — every step runs twice and its outputs are compared, which catches the two that actually happen: a clock and a random value.
- **It does not claim live replacement** — `admissibleForHandoff` refuses, because the obligations a running activation holds are not captured yet.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/continuity/README.md). On npm: [@source-repo/continuity](https://www.npmjs.com/package/@source-repo/continuity).
