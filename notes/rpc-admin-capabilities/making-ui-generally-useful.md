<!--
Design input, scrubbed: the commercial application layer above Source RPC is not this repository's
to name, so the example component id carries a neutral owner and the renderer personalities are
described by role. The convention the example is showing - that a logical component name is
owner-prefixed - is the point, and it survives.
-->

## Design input: ViewSpec, MCP Apps, reusable UI composition

The generic console viewer/editor work has a broader role than improving `rpc-cli`: it can raise the abstraction level for MCP and become a declarative UI layer over Source RPC.

### Core idea

MCP should ideally work at the level of:

* show this resource
* compose these resources
* use this saved view
* bind this view to this resource
* expose the declared actions

rather than generating field controls, RPC bindings, validation, forms, retries, etc.

Source already knows most of those details through `TypeNode`, `$data`, write contracts, actions, representation, references and command semantics.

A declarative **ViewSpec** can describe only the composition/intent.

### ViewSpec is a fragment, not a page

A ViewSpec should be a composable UI fragment.

It may be:

* a few fields
* a table
* a record view
* a form/action panel
* a group/grid/stack
* a reference to another saved ViewSpec
* a navigation link to another ViewSpec

Higher-level views compose smaller ones.

For example:

```text
Line overview
 ├─ line-status
 ├─ alarm-summary
 ├─ motor-status bound to M101
 ├─ motor-status bound to M102
 └─ link → detailed diagnostics
```

This is closer to a declarative component system than a dashboard/page format.

### Context and binding

Reusable ViewSpecs should normally be context-independent.

A `motor-status` fragment might say:

```json
{
  "kind": "fields",
  "source": "$motor",
  "fields": ["state", "speed", "current", "temperature"]
}
```

A parent binds it to a real Source resource.

Conceptually this is similar to:

```tsx
<MotorStatus motor={M104} />
```

A future ViewSpec definition may therefore expose typed inputs/parameters.

### Embed vs navigate

Two distinct operations are useful:

**Embed another ViewSpec**

Use a saved fragment as part of the current composition.

**Link/navigate to another ViewSpec**

Open a higher-detail or otherwise separate view.

Both may reference views/resources on other Source RPC nodes.

This means a higher-level UI can span the Source network without pretending the underlying resources reside on one server.

### MCP Apps

MCP Apps is useful mainly as a **view host**: a web application that an MCP client can display interactively and that can communicate back through MCP.

Do not make:

```text
one ViewSpec = one MCP App/web page
```

Instead prefer:

```text
one generic Source MCP App
        ↓
renders arbitrary ViewSpecs
        ↓
resolves resources/views across Source RPC
```

An early `rpc-cli` experiment should therefore test whether MCP can:

1. create a small ViewSpec;
2. render it immediately in an MCP App;
3. modify it;
4. save it;
5. reopen it later or from another session;
6. compose it into a larger ViewSpec;
7. follow/embed a ViewSpec residing elsewhere in the Source network.

The architectural question being tested is:

> Can MCP create useful Source applications by composing typed semantic resources instead of generating application code?

### Saving views

Saved UIs should be structured resources, not generated HTML.

A saved view could initially just contain:

```ts
interface SavedView {
    id: string
    name: string
    description?: string
    spec: ViewSpec
}
```

They could later naturally gain:

* permissions
* representation
* references
* search
* revisions
* audit
* aspects

The location of a saved ViewSpec and the location of the resources it displays are independent.

### Do not duplicate Source contracts in ViewSpec

ViewSpec should reference Source semantics, not copy them.

Prefer:

```json
{
  "field": "temperature"
}
```

over:

```json
{
  "field": "temperature",
  "type": "number",
  "unit": "C",
  "min": 0,
  "max": 100
}
```

if those facts already exist in the resource's TypeNode/metadata.

Likewise an action reference should not copy its arguments, validation or command semantics.

Rule:

> ViewSpec says what to compose. Source contracts say what those things mean.

### Framework independence

ViewSpec should not be React-specific.

For example:

```json
{
  "kind": "resourceTable",
  "source": "...",
  "fields": ["name", "value", "quality"]
}
```

rather than:

```json
{
  "component": "ReactDataGrid"
}
```

A React renderer may map this to React components, but another renderer could map the same ViewSpec to Web Components, native UI, text/debug output, etc.

This suggests three logical layers:

```text
Source RPC contract
    data/types/actions/semantics

ViewSpec
    framework-independent composition

Renderer/UI host
    React, Web Components, MCP App, etc.
```

### Standard primitives vs custom components

ViewSpec should contain a small framework-independent set of standard primitives, e.g.:

```text
stack
grid
tabs
text
record
resourceTable
tree
form
action
view
viewLink
conditional
```

Most UIs should be expressible with these.

But pure JSON should not be required to express every possible custom visualization.

For richer components, ViewSpec can reference a **logical UI component**:

```json
{
  "kind": "component",
  "component": "plant.motor-gauge",
  "props": {
    "motor": "$motor"
  }
}
```

The logical component name should not imply React.

### UI component repository/server

Custom executable UI code should preferably not live all over the Source RPC network.

Some Source nodes may be unreliable, transient, embedded, development laptops, or powered down. They should not need React runtimes, frontend dependencies or custom TSX just because a UI refers to their resources.

A more robust model is:

```text
Source nodes
    resources/types/actions
    optional framework-neutral built-in ViewSpecs

Reliable View/UI repository
    saved ViewSpecs
    reusable compositions
    custom component manifests
    React implementation/assets

View host
    resolves ViewSpec + components
    talks to Source network
```

A node being unavailable should make its data unavailable, not make the definition of the UI disappear as well.

Node-provided default ViewSpecs are still useful, but should preferably remain framework-neutral metadata rather than executable React.

### Renderer-specific component implementations

A logical component can have renderer implementations:

```text
plant.motor-gauge
    React implementation
    Web Component implementation
    generic ViewSpec fallback
```

The same saved ViewSpec can therefore be rendered by different UI servers.

This also permits different UI personalities:

```text
same ViewSpec
    → a product's polished renderer
    → Source engineering console
    → customer-specific renderer
```

### Fallbacks

Custom components should ideally offer a generic ViewSpec fallback.

For example, a rich motor gauge might fall back to:

```text
state
speed
current
temperature
```

This gives graceful degradation in renderers that do not support the custom component.

### React and TSX

React remains a useful escape hatch, but should not be the interchange model.

Preferred hierarchy:

```text
generic Source rendering
        ↓
declarative ViewSpec
        ↓
reuse existing custom component
        ↓
create TSX/React only when genuinely needed
```

Potentially, JSX/TSX could also become an ergonomic authoring syntax for ViewSpec:

```tsx
<Stack>
  <Heading>Filler 1</Heading>
  <ResourceTable source={...} fields={...} />
  <View ref="drive-summary" />
</Stack>
```

If it uses only standard Source UI primitives, it could compile to ViewSpec JSON.

Only genuinely custom React code remains executable code.

### Trust boundary

There should be a clear distinction between:

**Declarative ViewSpec**

* data only
* structurally inspectable
* safe to persist/edit/diff
* suitable for MCP generation

and:

**Executable UI components**

* TS/JS/React
* dependencies/code execution
* require sandboxing/trust/review as appropriate

Custom UI code must not become authoritative for Source semantics.

A component may render a writable value beautifully, but it does not decide that the value is writable.

Authority remains:

```text
Source contract + authorization + command semantics
```

The ViewSpec/component only determines presentation/composition.

### Important security/property for MCP

The AI may sometimes be able to create the **lens** without receiving all the live data visible through that lens.

For example:

```text
AI creates ViewSpec
        ↓
browser/MCP App renders it
        ↓
browser accesses Source RPC
under the human user's permissions
```

This can reduce:

* unnecessary disclosure to the model
* token/context usage
* latency
* coupling between AI and realtime values

It also keeps interactive Source actions deterministic: the AI may create a view containing an action, but the action is still an existing Source RPC operation governed by normal authorization and command semantics.

### Early experiment

After basic representation/semantic rendering exists, add a small MCP Apps spike to `rpc-cli`.

Do not build a full ViewSpec framework first.

Start with perhaps:

```text
text
fields/record
table
stack/grid
view reference
view link
```

Test a flow such as:

```text
"Make a diagnostic UI for Filler01"
→ MCP creates ViewSpec
→ render
→ "Add quality"
→ JSON changes
→ save as Filler diagnostics
→ reopen
→ compose into line overview
→ embed/link to drive diagnostics on another node
```

If the same ViewSpec can also be interpreted by a simple non-React/debug renderer, that is a useful check that the specification is truly framework-independent.

### Likely eventual ownership

Do not create packages prematurely, but the logical separation may eventually become:

```text
@source-repo/rpc
    resource/type/action semantics

@source-repo/view
    ViewSpec types, validation, references, composition

@source-repo/react
    React renderer + standard component implementations

rpc-cli
    console + MCP App host

reliable UI/View service
    saved views, custom component registry, assets
```

The immediate implementation should remain experimental until the model has been exercised from at least the console and MCP Apps.

---

## Review

*Appended after the note was read against the repository as it stands at `a9e6ca7`, and after the question it provoked: should a node's UI be part of `describe()`.*

### Where it lands correctly

The rule at its centre - *ViewSpec says what to compose, Source contracts say what those things mean* - is the same split `notes/generic-viewer.md` arrives at from the other direction, and the two were written without reference to each other, which is the best evidence either of them is right.

The trust boundary states it better than that note does: **a component may render a writable value beautifully, but it does not decide that the value is writable.** That sentence should survive into whatever gets built.

And the strongest idea here is the one furthest down: the model can compose the **lens** without ever receiving the data seen through it. Less disclosure, less context, no coupling between a model and live plant values, and the actions in the view remain ordinary operations under ordinary authorization. That property alone would justify the format; it deserves to be the argument rather than a closing observation.

### Should the UI be part of `describe()`

Yes, and it already is. `sets` puts an editor on a field. `actions`, with `appliesTo`, `kinds` and `confirm`, put buttons on rows and decide which rows get them. `shape`, `grouping`, `hasChildren` and `defaultChild` decide how a node is navigated. `defaultColumns` and `representation` decide what a row shows and what it is called. Every one of those is UI, every one is in `describe()`, and not one of them is a layout. The question was never whether a node may describe itself in terms a viewer uses - it is where that stops.

The line is a test rather than a rule:

> If a second, unrelated renderer would use the fact, it is **semantics** and belongs in `describe()`. If only a screen would use it, it is **composition** and belongs in a ViewSpec resource.

Grouping passes it: the CLI groups its questions, MCP asks them in a sensible order, a browser draws an accordion. So `presentation.sections` is describe material, and it is real node knowledge - which four of two hundred fields belong together is not derivable from their types by anybody downstream. Semantic formats pass. References pass. *Gauge, top-left, three hundred pixels, second tab* fails, because nothing but a screen wants it.

Two things follow that are worth stating separately.

**`describe()` is bounded by what a node can speak for.** It describes itself. A view that composes three peers and links to a fourth is not a fact about any one of them, and a node offering one would be speaking for machines it does not own.

**A node-attached default view is self-defeating.** If it is expressible in the node's own semantics it adds nothing that rendering those semantics would not, and if it is not expressible in them it is precisely the layout that must not travel. So the useful version of "nodes should describe themselves in a UI" is *more semantics in describe*, and the version to refuse is *a composition attached to a resource* - which would turn the presentation hint into the layout engine its own comment exists to keep it from becoming.

### What I would change

**Drop `conditional` from the primitives.** That is the seam where a declarative format becomes a programming language: a conditional wants comparisons, comparisons want expressions, expressions want iteration. This repository has already made the call once, for filters, and the reason applies unchanged - a bounded operator vocabulary because the thing evaluating it may be a small plant computer. If conditionality ever earns its place it should reuse `RpcFilter`, not invent a second dialect that means almost the same thing.

**Make the generic fallback required rather than ideal.** The multi-renderer premise fails without it: a custom component with no fallback is a view some renderers cannot draw at all. Required in the manifest, graceful degradation becomes a property of the format instead of a courtesy of whoever wrote the component.

**Say which aspect a binding is in.** `motor-status bound to M104` does not say through which arrangement, and this system's navigation model is that one object appears in several. `follow()` exists precisely to carry a reader's arrangement across a hop. Either a binding carries an aspect or the format says plainly that it does not care and the host decides - left implicit, every renderer resolves it differently and two of them will disagree about what the same saved view meant.

**Give an AI-composed view that carries actions its provenance.** The action stays governed, which is right. But the model also chose which action sits beside which reading, and somebody pressing it is trusting that composition. A view built by a model and carrying actions should say so on its face.

**Authorize a saved view from the start, not "later".** A view names peers, resources and fields; it leaks structure with no data in it at all, and structure on a plant network is reconnaissance of the same order as `describe()` itself, which is why that is opt-in.

### Sequencing

A throwaway spike now is fine and the note is right to want one. Settling the format should wait for references and the record editor, because a view that cannot yet express a reference or a write is a view that gets redesigned the week after they land.
