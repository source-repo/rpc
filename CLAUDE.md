# Working in this repository

## Never put a control character in a source file

Write `\u0000` (or `\x1b`, or whatever it is), never the byte itself — including inside a template literal, where it is invisible in review.

NUL is the one that keeps happening, because it is a good separator: it cannot occur in a peer name, a namespace or an idempotency key, so `` `${a}\u0000${b}` `` cannot be forged by choosing a clever `a`. Keep using it. Just escape it.

A literal NUL makes the file **binary** to every tool that decides by content sniffing:

- `grep` matches but prints nothing — no error, no "Binary file matches" when piped. Searches for a symbol in that file come back empty and look authoritative. This is the one that costs time.
- `file` reports `data`, and anything else sniffing content agrees.
- `git diff` shows `Binary files differ`, but only when the NUL lands in the first 8000 bytes, which is as far as git looks. Put one near the end of a long file and git keeps diffing it happily while grep has already gone silent — so a working `git diff` is not evidence the file is clean.

`RpcServerHandler.ts` and `Idempotency.ts` both had one. `eventProxyKey` in the same file had the escape and read identically. Check with:

```
git ls-files -z | xargs -0 grep -laP '\x00'
```

## Conventions worth knowing before editing

**Ports.** `defaultWebSocketPort` (7843, `rpc`) and `defaultWebPort` (7844, `console`) live in `packages/rpc/src/RPC/Rpc.ts`, with `defaultSecureWebSocketPort` (8843, `rpc-tls`) and `defaultSecureWebPort` (8844, `console-tls`) beside them. Nothing else should hardcode them — the CLI reads the constants for its `--port` defaults, and `--cert`/`--key` select the encrypted pair. A thousand apart rather than adjacent so no firewall range spans a plain port and an encrypted one.

**Comments carry the reasoning, not the mechanics.** The house style explains *why* a thing is the way it is, and especially what breaks if it is changed back. Match the surrounding density; a file here has more prose than most codebases and that is deliberate.

**Contracts are committed and checked.** `packages/cli/src/*.types.json` are extracted from source by `npm run contract` and verified by `npm run check:contract`. Change a service in `bus.ts` or `console.ts` and re-extract, or the check fails.

**`rpc`, `rpc-cli`, `conformance`, `continuity`, `diagnostics`, `query`, `docker`, `document`, `relational`, `signalr` and `sparkplug` version together**, since the CLI depends on the library's exact shape and the rest are still moving with it. They joined the rule rather than being exceptions to it, and for a reason with an end date: **until the interface and the wire format are stable**, a package that tracks them is easier to reason about pinned to the version it was built against than carrying its own number that says nothing about which library it agrees with. A newly published `0.2.0` cannot tell anybody whether it needs 4.5 or 4.7; `4.6.0` can. When the shapes settle, a package can be let out of the rule one at a time — and doing that is a deliberate act, not a drift. `continuity`, `diagnostics` and `query` joined it at 5.2.0, their first published version, by that same rule read forwards: each tracks the library's internals rather than its public API - continuity through `handOver`, diagnostics through the pause gate and the worker host - so a `0.1.0` of any of them could not have said which library it agreed with.

`packages/queue` is deliberately **not** part of it and never was: it versions on its own, because it depends only on the library's public API — it is the first external consumer of the schema compatibility policy, and pinning it to the library's version would un-prove exactly what it exists to prove. It is also the only one of the four published, which is what makes that independence cost something real.

`packages/aspects` and `packages/documentation` are outside the rule for the same reason, and were from their first commit: both depend on the library's public API rather than on its shape. `documentation` does pin `aspects` by version, which is a different relationship - one is a provider of the other's contract, and that agreement is worth stating precisely.

**Markdown is one line per paragraph.** Do not hard-wrap prose at a column, and do not re-wrap what is here. A single newline inside a paragraph is a space to CommonMark, so wrapped and unwrapped source render identically — the difference is only what happens when the file is edited. Hard wrapping keeps diffs small, but it needs every editor to re-wrap after a change or the margin drifts, and the WYSIWYG editors used on this repo preserve existing breaks without adding new ones. Unwrapped is the convention that survives being edited by anything.

Table rows, headings and fenced blocks are one line each already and are not prose. A deliberate line break inside a paragraph is `<br/>`, or two trailing spaces — a bare newline will not do it.

**Make the diffs readable.** The cost of that convention is that changing one word reports the whole paragraph as rewritten. `tools/md-sentences.py` is a textconv filter that breaks prose onto one line per sentence *for diffing only* — the file on disk never changes, and only what git compares does. Wire it up once per clone:

```
git config diff.markdown.textconv      "$PWD/tools/md-sentences.py"
git config diff.markdown.cachetextconv true
```

`.gitattributes` already points `*.md` at that driver. The command itself has to be local rather than committed, because git refuses to let a repository specify programs it will run — a clone should never execute something that arrived with it.

Two things to know. A textconv diff is for reading, not applying: `git apply` will reject one, and `git diff --no-textconv` is how to get a real patch. And `git diff --word-diff` needs no setup at all, so it stays the answer for a one-off look.

## Commands

The workspace scripts run in **dependency order, and it is written out rather than derived**: `rpc` first, then `conformance`, then everything that depends on either. A package is compiled against its dependency's *emitted declarations*, so a workspace built before the one it imports fails with `Cannot find module '@source-repo/rpc'` - and only on a clean checkout, because a stale `dist` from a previous run makes the wrong order look fine on a laptop and break in CI. When a workspace is added, put it after what it imports.

```
npm run build        # both workspaces
npm run typecheck
npm run lint         # eslint, --max-warnings 0
npm test             # needs an MQTT broker, Postgres and MySQL for the relational suite,
                     # and MongoDB for the document one:
                     # docker compose -f docker-compose/docker-compose.yml up -d
```

Without a server the tests that need one skip themselves, which is right on a laptop and wrong in CI - a run that reports itself green having quietly skipped a third of the suite is the run somebody trusts. `SOURCE_RPC_REQUIRE_BROKER=1`, `SOURCE_RPC_REQUIRE_SQL=1` and `SOURCE_RPC_REQUIRE_MONGO=1` turn those skips into failures, and `.github/workflows/ci.yml` sets all three alongside the servers it starts. A new test file that talks to one needs the same guard in its `test.before`; the ones that have it are near-identical, so copy the nearest.

The broker itself is named by `MSGRPC_TEST_BROKER`, which defaults to `mqtt://localhost:1883` - where the compose file puts EMQX. A broker already running is a matter of pointing that at it rather than starting a second one: `MSGRPC_TEST_BROKER=mqtt://localhost:1884 npm test` for a mosquitto on 1884, which is the usual reason to override it. Whatever it names has to accept an **anonymous** CONNECT, because no peer in the suite sends credentials - that is what `EMQX_AUTHENTICATION: '[]'` in the compose file buys, and a mosquitto needs `allow_anonymous true` for the same reason. A broker that accepts the TCP connection and then refuses the MQTT one looks like a working broker until the first frame, which is the slow way to find this out.

The SQL half is deliberately not all-or-nothing: `packages/relational`'s conformance suite always runs **SQLite**, over Node's built-in `node:sqlite`, so it needs no server and can never skip itself entirely. What a missing Postgres or MySQL costs is the cross-backend comparison - the part that catches one engine answering a question differently from the other two.

`packages/document` has no such floor, because there is no in-memory MongoDB: without a server **every test in it skips**, and the package reports itself green having run nothing. `SOURCE_RPC_REQUIRE_MONGO` is therefore the load-bearing one of the three.

**The questions those suites ask live in `packages/conformance`**, which is private and never published. It is the specification rather than a test helper: the claim that one contract works over many backends is only a claim until one fixture is asked of all of them and the answers are compared, and a copy of the questions in each package is exactly how two implementations drift while both of their suites stay green. A new store-backed node adds a column to that comparison rather than a suite of its own.

**Write the lock file with npm 12**, which `engines.npm` states and every workflow installs before `npm ci`. A lock file is a function of the npm that wrote it: npm 10, the one Node 22 bundles, resolves `@docsearch/react`'s peer range of react `>= 16.8.0 < 19.0.0` against this workspace's React 19 by wanting a nested React 18 that an npm 12 lock does not record, and refuses the entire install with *Missing: react@18.3.1 from lock file*. Regenerating under npm 10 does not settle it either - the entries come back out the next time npm 12 runs `npm install`, so the two have to be the same npm rather than meet in the middle. Node stays at 22 in CI because that is what the packages claim to support; only the installer is pinned.
