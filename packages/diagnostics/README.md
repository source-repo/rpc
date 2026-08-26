# @source-repo/diagnostics

Live values beside the source that declares them, for a [Source RPC](https://github.com/source-repo/rpc) node. The oldest way of looking at a machine — the program on screen with what each thing currently is written next to it — without a debugger, without instrumentation, and without a second data path.

**Phase 1 of the node diagnostics design.** Probes, execution paths, tracepoints, breakpoints and stepping are later phases and are advertised here as `false` rather than left out.

## The whole economy of it

Props and state are **already observable**. A subscriber receives them, `authorize()` has already ruled on them, a projection has already narrowed them. So the only thing missing from a PLC-style live view is *where each one is declared* — and that is static, known at build time, and costs the running artifact nothing.

Which makes the design's third acceptance criterion — that a user cannot obtain a field through source view that they could not obtain through ordinary authorised observation — a fact about the architecture rather than a check somebody has to remember to write. **There is no second data path to secure, because there is no second data path.** This package serves file names, hashes and positions; the values come from the component channel the viewer already had.

## Building the catalogue

```
source-rpc extract --project tsconfig.json --out contract.json --bindings bindings.json
```

The same walk that produced the contract, from the same resolved types — so the paths a viewer overlays and the paths the contract publishes cannot be two different answers. It descends through objects and stops at records and arrays: a record's keys are data, so `tags` has a declaration and `tags['tag.007']` does not, and inventing a span for it would put a value beside a line that says nothing about it.

## Serving it

```typescript
import { exposeDiagnostics } from '@source-repo/diagnostics'

exposeDiagnostics(server, {
    catalogue: JSON.parse(readFileSync('bindings.json', 'utf8')),
    // Omit it and the node serves bindings and identity but no text. That is the right default for
    // a plant: where a value is declared and the source itself are different disclosures with
    // different audiences, and a viewer with its own checkout needs only the first.
    sourceRoot: 'src'
})
```

**It is a component**, because the design says so in the shape of its own contract: the illustrative `NodeDiagnostics` has `capabilities` and `activeSource` as readonly *properties*, and a readonly property a viewer watches is what an observable component already is here. So they are props — a viewer subscribes, and a redeploy that changes the running revision reaches every open editor without anybody polling for it.

`source()` is a separate method because it is a separate permission: a viewer may legitimately be allowed to know that `state.setpoint` is declared at line 34 and not be allowed to read the file that says so.

## Nothing is drawn on the wrong source

```typescript
const refusal = overlayRefusal(catalogue, identity, { fileId, contentHash })
if (refusal) return showTheFileWithoutValues(refusal)
```

A value positioned by a line number from a file that has since been edited is worse than no value: it is a number somebody will act on, sitting beside a declaration that is no longer the one it came from. So the comparison happens first, and it answers with a **sentence** rather than a boolean — three different problems live here, and a viewer that said "false" to all of them would leave a person guessing:

- the file on screen has been edited since the build
- the node has been redeployed and is running a revision this catalogue does not describe
- the file was never part of this build at all

## Sensitivity

A binding may carry a `sensitivity`, and a viewer draws a marker instead of a value. Read-only visibility is not harmless — a value can be a credential, a production quantity or somebody's name — and the classification belongs beside the declaration because that is where the person who knows is.

## License

MIT
