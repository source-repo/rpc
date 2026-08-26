# @source-repo/diagnostics

Live values beside the source that declares them: the oldest way of looking at a machine, without a debugger and without instrumentation.

```
npm install @source-repo/diagnostics
```

- **No second data path** — this serves file names, hashes and positions; the values come from the component channel the viewer already had, through the permission check that was always there.
- **A build-time catalogue** — `source-rpc extract --bindings` records where each `props` and `state` path is declared, from the same resolved types the contract came from.
- **Nothing is drawn on the wrong source** — a value positioned by a line from an edited file is worse than no value, so the revision and the file hash are compared first, and the refusal is a sentence rather than a boolean.
- **Capabilities are advertised, including the ones that are false** — a viewer that finds `exactPause` absent cannot tell "this node cannot" from "this protocol version had not thought of it".
- **The node's own diagnostics are a component** — capabilities and the running revision are props, so a redeploy reaches every open editor without polling.
- **A sensitive field says so beside its declaration**, and a viewer draws a marker rather than the value.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/diagnostics/README.md). On npm: [@source-repo/diagnostics](https://www.npmjs.com/package/@source-repo/diagnostics).
