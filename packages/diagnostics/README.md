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

## A diagnostic variant can be proved to be one, which is not building one

The next phase generates probes into the node's own source and runs the result. That is a licence to put *different code* on a plant in order to watch the code that was approved, and the whole design rests on one claim: **the variant differs from the approved revision in probes and nothing else.**

Nothing about a build checks that. A transformer with a bug, a hand-edited artifact and a deliberately altered one all produce a file that compiles and runs. So the check is the reverse operation — strip every recognised probe and see whether what is left is the approved program — and it is the reverse operation precisely because it does not trust the forward one.

```typescript
const proof = await provesDerivative(base, variant, 'oven.ts', 'rev-7')   // in @source-repo/rpc-cli
const refusal = await admissibleVariant(manifest, approved, {
    baseSemanticDigest: proof.baseSemanticDigest,
    strippedSemanticDigest: proof.strippedSemanticDigest,
    plan,                                                    // what a reviewer approved and a viewer is served
    found: proof.probes.map(({ probeId, kind }) => ({ probeId, kind })),   // what the artifact carries
    addedCapabilities: []
})
```

**The node holds hashes and compares them; the compiler does the walk.** `admissibleVariant` runs the rules and refuses on the first, each in its own sentence because they are separate conversations: source that has moved on, a base artifact that is not the one running, a stripped variant that is not the base, a changed contract, a changed persistent state schema, changed non-diagnostic capabilities, and a plan that does not match the artifact. The only capability a variant may add is `diagnostics.telemetry` — anything else is an artifact using instrumentation to widen its own authority.

**The plan and the artifact are two different lists on purpose.** The plan's spans are spans of the approved source, because that is the file a viewer is reading; the strip reports what is compiled in, by identity and kind. Neither can be derived from the other, and comparing them is the check: a probe in the artifact that no plan names is an observation point nobody reviewed, and a plan naming a probe the artifact lacks is an overlay that will never fire while looking exactly like one that has not been reached yet.

**What counts as a probe is defined by the verifier, not by the generator.** A probe is a call on the reserved receiver `__rpcProbe` in one of six recognised shapes; anything else mentioning that name is a refusal rather than something to strip. The wrapping forms — `value` and `condition` — take the observed expression as an argument and evaluate to it, so it appears exactly once and "evaluated exactly once, with unchanged results and exception behaviour" is a property of the shape rather than a promise about a generator. A strip that skipped what it did not recognise would leave it in the output and report *the transformer changed the program*, which is true and points at the wrong thing; one that deleted anything mentioning the receiver would delete code somebody wrote.

Programs are compared reprinted from their parse trees, so two files differing only in where the newlines fall are the same program and **comments are not part of the comparison** — a probe legitimately arrives with one attached. The cost is real and worth naming: a variant may change a comment and this will not see it. What it exists to catch is a changed program, and a comment cannot be one.

`diagnosticVariants` stays `false` in the advertised capabilities. Verification is not activation, and a flag that ran ahead of the code would be the one thing the capability set exists to prevent.

## Generating the probes the verifier accepts

`instrumentSource` in `@source-repo/rpc-cli` is the other half, and it was written second on purpose — a transformer that also defined what counted as correct would be marking its own homework. Every test it has ends by handing its output to `provesDerivative`.

```typescript
const instrumented = instrumentSource(source, 'oven.ts', 'rev-7', [{ from: 40, to: 60 }])
```

**A viewport is expanded to the containing function**, which is the design's default unit and not a convenience. A viewport begins in the middle of a condition as often as not, and instrumenting from there would put an entry probe inside an expression. It also makes the result stable while somebody scrolls: a plan built for a function does not change because two more of its lines came into view, so the variant already running stays the right one, and two viewports over one function are one region.

**Spans in the plan are spans of the approved source**, recorded before emit, because the person reading is looking at the approved file and not at the instrumented copy. Probe ids are derived from those positions rather than counted, so the same source produces the same plan however the walk reached it — and they are not stable across revisions, because a position is exactly what an edit moves.

**Unavailable rather than uncertain.** A missing probe is a screen with one fewer value on it; a transform that was nearly equivalent is a plant running code nobody approved. So an initialiser holding a function body is reported rather than wrapped — the arrow inside it is instrumented as its own region, and a probe around it would have to be rewritten as another probe rewrote its inside — and a single-statement `if` branch is reported rather than given braces, because adding braces is a change to the program even where it reads as the same one. Loops and `try` bodies are probed as the statements they are: a coverage limit, stated, not an equivalence risk.

The invariants that matter are tested by **running** the instrumented code against a recording stub, because "evaluated exactly once" and "short-circuit preserved" are claims about execution that no comparison of syntax trees can check. Conditions are wrapped whole and never by operand, so `a && b` short-circuits exactly as it did. Returns are found by their own scan at every depth, so entry and exit pair up even when the return is inside a block, a loop or a `try` — otherwise an overlay shows a function that was entered and never left.

## License

MIT
