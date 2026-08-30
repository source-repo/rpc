I think **OPC UA is a very good test of the new aspect model**, and it actually clarifies what an aspect should and should not be.

The important conclusion is:

> **An OPC UA interface should not itself be an aspect. But different useful arrangements/selections of the OPC UA objects absolutely can be aspects.**

That distinction fits the code you have remarkably well.

### What the current aspect model actually means

The README is already quite explicit: an aspect is a **named structure over stable objects**, inspired by IEC 81346. The same object can appear under functional, product, location, documentation, security, etc. The key sentence in the implementation is essentially “structure is an aspect, identity is not.” Aspects are also explicitly read models and deliberately separate from Source RPC's runtime `parent`/`owner` topology. ([GitHub][1])

And the implementation backs that up nicely:

```ts
interface AspectRef {
  provider: RpcRef
  resource: readonly string[]
  id: string
}

interface Occurrence {
  occurrenceId: string
  ref?: AspectRef
  title: string
  kind: string
  relation?: string
  hasChildren: boolean
  fields?: Readonly<Record<string, unknown>>
}
```

The separation of `AspectRef` from `Occurrence` is exactly right for OPC UA. One UA node has one identity, but it might appear in several places—or even several places in the same aspect. Grouping nodes don't even need object identities. ([GitHub][2])

Even more importantly, `AspectProvider` already turns every aspect into a lazy `shape: 'tree'` DataProvider resource, with paged `getChildren()`. That's almost tailor-made for a potentially huge OPC UA address space. ([GitHub][3])

So I would model it approximately like this:

```text
OPC UA server
    │
    ▼
OpcUaProvider
    │
    ├── canonical UA objects
    │     stable identity
    │
    ├── aspect: address-space
    │     Objects
    │       └─ Packaging
    │           └─ Filler01
    │
    ├── aspect: functional
    │     Filling
    │       └─ Filler01
    │
    ├── aspect: location
    │     Building A
    │       └─ Floor 1
    │           └─ Line 3
    │               └─ Filler01
    │
    └── aspect: engineering
          PLC_4
            └─ ...
```

Those are four arrangements of the same object universe.

That is precisely analogous to the documentation package you just added: it deliberately says that **documentation is the domain/aspect, Markdown is merely a format**, and then exposes `by folder` and `by topic` as different arrangements of the same documents. ([GitHub][4])

For OPC UA, similarly:

```text
OPC UA = source/interface/protocol
address-space = aspect
functional = aspect
location = aspect
maintenance = aspect
engineering = aspect
```

### Your idea about choosing which OPC UA objects appear

Yes, an aspect can select as well as arrange. `placements()` returning no occurrence means that an object simply isn't represented in that aspect. So something like this is perfectly valid:

```text
All OPC UA
    18,327 nodes

Operations
       412 relevant nodes

Maintenance
       691 relevant nodes

Energy
        83 relevant nodes
```

That is quite powerful.

But I would distinguish **selection as meaning** from **selection as configuration**.

For example:

```text
Operations aspect
```

means “these are the objects relevant when looking at the system operationally.” That's genuinely an aspect.

Whereas:

```text
objects currently enabled for MQTT publishing
```

is really interface configuration. You *could* expose a `published` aspect so humans can inspect it, but aspect membership should probably be the **read model of the configuration**, not the configuration itself.

That distinction will prevent aspects from slowly becoming a generic tagging/filtering mechanism.

## OPC UA reveals another axis that Source may eventually need

I think you were onto something when you said aspects might already be starting to look at interfaces. Looking at the code, though, I think the opposite is true: **the current aspect abstraction is still very cleanly structural**.

`AspectDescriptor` only knows things such as:

```ts
id
label
description
revision
preferredPresentation
defaultColumns
```

And `ObjectDetail` is currently:

```ts
interface ObjectDetail extends ObjectSummary {
  content?: readonly ContentBlock[]
  links?: readonly AspectLink[]
}
```

There is no concept there of “how can I interact with this object?” ([GitHub][2])

The README even has an interesting hint: a future `live-example` content block naming a method to run is mentioned, but deliberately not implemented yet. That's actually evidence that **interaction is adjacent to aspects but not part of what an aspect is**. ([GitHub][1])

I think OPC UA gives you a useful four-axis model:

```text
Identity
    What thing is this?

Aspect
    How am I looking at / organising this thing?

Origin
    Where did this knowledge come from?

Interface / Binding
    How can this thing be observed or acted upon?
```

And Source RPC already has the first three substantially represented.

For a pump you could conceptually have:

```text
Object
  Pump P-101

Identity
  plant-object:p101

Aspects
  functional → Cooling / Loop 12 / P-101
  location   → Hall 2 / Skid 7 / P-101
  product    → Pumps / Centrifugal / P-101

Origins
  OPC UA
  engineering documentation
  assessment

Interfaces
  OPC UA
  Sparkplug B
  Source RPC
```

That last dimension is different from an aspect.

### I would probably add `bindings`, eventually

OPC UA may be the first real use case strong enough to justify adding this.

Something along these lines—not necessarily exactly this API:

```ts
interface ObjectBinding {
  readonly kind: string

  readonly role:
    | 'observe'
    | 'command'
    | 'configure'
    | 'publish'

  readonly target: BindingTarget

  readonly fields?: Readonly<Record<string, unknown>>
}

type BindingTarget =
  | {
      readonly type: 'rpc'
      readonly ref: RpcRef
    }
  | {
      readonly type: 'external'
      readonly system: string
      readonly id: string
    }
```

Then:

```ts
interface ObjectDetail extends ObjectSummary {
  content?: readonly ContentBlock[]
  links?: readonly AspectLink[]
  bindings?: readonly ObjectBinding[]
}
```

An OPC UA object could say:

```ts
bindings: [
  {
    kind: 'opcua.node',
    role: 'observe',
    target: {
      type: 'external',
      system: 'opcua',
      id: 'nsu=urn:acme:filler;s=Filler01'
    }
  },
  {
    kind: 'source-rpc.component',
    role: 'command',
    target: {
      type: 'rpc',
      ref: {
        peer: 'line3-edge',
        instance: 'filler01'
      }
    }
  }
]
```

I wouldn't rush that addition solely because it seems theoretically tidy. Your current aspects README is wisely resisting vocabulary that nobody actually serves yet. But **when the OPC UA provider exists**, it would become a concrete requirement rather than speculative architecture.

And I'd call it `binding` or perhaps `surface`, rather than `interface`, because “interface” is overloaded badly enough already in TypeScript and OPC terminology.

## The OPC UA identity should map very naturally to `AspectRef`

I'd make the provider's object ID based on a portable OPC UA identifier, **not the browse path and not merely `ns=4`**.

The OPC UA standard specifically warns clients not to assume that a `NamespaceIndex` remains the same between sessions. The persistent identity is the identifier plus the namespace URI; the numeric index is just a compact session/server representation. ([reference.opcfoundation.org][5])

So conceptually:

```ts
const ref: AspectRef = {
  provider: opcUaProviderRef,
  resource: ['nodes'],
  id: encode({
    namespaceUri: 'urn:acme:filler',
    identifierType: 'string',
    identifier: 'Filler01'
  })
}
```

Rather than:

```ts
id: 'ns=4;s=Filler01' // not ideal as persistent identity
```

Then BrowseName, DisplayName, NodeClass, DataType, TypeDefinition, AccessLevel etc. are fields describing that object.

That also makes OPC UA browse paths exactly what your aspect package says structural paths should be: **a current placement, not identity**.

## And this changes my view of the virtual nodes

For the OPC UA case, I would **not make every UA node a Source RPC virtual node**.

Your `AspectProvider` already gives you an extremely good lazy virtual representation:

```text
OPC UA node
      ↓
AspectRef                     stable object
      ↓
Occurrence                    placement in one tree
      ↓
DataProvider getChildren()    lazy/paged browsing
```

That's better for browsing 20,000 or 200,000 UA nodes than creating 200,000 RPC component instances.

Then virtual Source RPC nodes become much more valuable if they mean something stronger:

```text
OPC UA address space
       │
       │ cheap, lazy discovery
       ▼
 AspectProvider
       │
       │ selected / interesting / operational
       ▼
Source RPC virtual node
       │
       ├─ props/state
       ├─ methods
       ├─ permissions
       └─ MCP-visible interface
```

So, for example:

```text
Objects
└─ Line1
   ├─ PLC diagnostics          Aspect occurrence only
   ├─ vendor metadata         Aspect occurrence only
   ├─ 3,000 internal vars     Aspect occurrences only
   │
   ├─ Filler01                promoted virtual RPC node
   │    state
   │      running
   │      speed
   │    methods
   │      start()
   │      stop()
   │
   └─ Tank12                  promoted virtual RPC node
        state
          level
```

That seems cleaner than treating virtual nodes and aspect occurrences as two competing ways of virtualising the entire foreign hierarchy.

I couldn't find an API literally named `VirtualNode` in the public `main` tree under that term, so I'm basing this particular distinction on the virtual-node behavior we've discussed rather than claiming a specific implementation detail from the repo. The aspect side, however, is directly reflected in the current code.

## This becomes especially nice with Sparkplug + OPC UA

I wouldn't rigidly say:

```text
factory floor = Sparkplug
upper floors  = OPC UA
```

because, as you say, OPC UA absolutely can live on the factory floor.

But there's a useful tendency:

```text
                         business / engineering
                                │
                         OPC UA / Source RPC
                     rich objects + semantics
                                │
                   ┌────────────┴────────────┐
                   │      the edge runtime   │
                   │ canonical plant objects│
                   └────────────┬────────────┘
                                │
                  Sparkplug B / OPC UA / ADS...
                                │
                         factory systems
```

Sparkplug is particularly good as a **live OT telemetry/state convention over MQTT**. OPC UA is particularly good where a rich browseable object model and standardized information models matter. Source RPC doesn't have to choose: the same Source-level object can eventually have both bindings.

That could produce a very elegant rule:

```text
Aspect answers:
"Where does this object appear in this way of looking at the system?"

Binding answers:
"Through what interface can I reach this object?"

Topology answers:
"Where does the active Source component live and who owns it?"

Authority answers:
"What am I allowed to do through that interface?"
```

That separation is strong.

### One model issue OPC UA exposes

There is one thing I would keep an eye on. `ObjectSummary` currently has a **singular**:

```ts
origin: AspectOrigin
```

and `AspectRef` identity is scoped to one provider. ([GitHub][2])

That's perfectly sensible for a documentation provider or an OPC-UA provider. But once a plant model starts saying:

> “This is the same Pump P-101 known from OPC UA, Sparkplug, the PLC project, the P&ID and the assessment”

you have crossed from a **source-specific object** to a **canonical system object**.

I wouldn't change `AspectRef` for that. Provider-scoped identity is a very good property.

Instead I'd eventually allow a higher-level provider to canonicalise:

```text
OPC UA provider                Sparkplug provider
   object A                        object B
       \                            /
        \    represents / same     /
         └─────────┬──────────────┘
                   ▼
             Plant model provider
                  P-101
                   │
        ┌──────────┼──────────┐
      OPC UA    Sparkplug   Source RPC
      binding    binding      binding
```

In other words, **don't make federation implicit**. Let a provider explicitly say that two foreign things represent one plant thing.

That seems particularly important for assessment, where “we believe these two things are the same asset” may itself need evidence rather than being silently inferred.

## So I would keep the aspect model essentially as it is

My current recommendation after reading it is actually **not to redesign aspects**. The recent abstraction is surprisingly well-positioned for OPC UA.

I would use:

```text
AspectRef      = stable identity within the OPC UA provider
Occurrence     = one placement of a UA object
Aspect         = meaningful arrangement/selection
AspectProvider = lazy UA model browser
Virtual node   = promoted operational Source RPC representation
Binding        = future orthogonal link to OPC UA/Sparkplug/RPC interfaces
```

The one likely model extension I see coming is **bindings/surfaces on an object**, not more responsibility in `AspectDescriptor`.

And OPC UA would be an excellent proving ground because it will stress all the right things: very large trees, objects in multiple structures, stable IDs versus browse paths, typed relationships, live properties, methods, configuration, and an external semantic model.

In fact, I think it may be a better second test of `@source-repo/aspects` than another knowledge system: documentation proves *one object in several human structures*; OPC UA would prove *one live industrial object in several machine/human structures*. That would tell you quite quickly whether the abstraction really is general.

[1]: https://github.com/source-repo/rpc/tree/main/packages/aspects "rpc/packages/aspects at main · source-repo/rpc · GitHub"
[2]: https://github.com/source-repo/rpc/blob/main/packages/aspects/src/Model.ts "rpc/packages/aspects/src/Model.ts at main · source-repo/rpc · GitHub"
[3]: https://github.com/source-repo/rpc/blob/main/packages/aspects/src/Provider.ts "rpc/packages/aspects/src/Provider.ts at main · source-repo/rpc · GitHub"
[4]: https://github.com/source-repo/rpc/tree/main/packages/documentation "rpc/packages/documentation at main · source-repo/rpc · GitHub"
[5]: https://reference.opcfoundation.org/specs/OPC-10000-3/8.2.2?utm_source=chatgpt.com "NamespaceIndex – OPC Unified Architecture - Part 3: Address Space Model"
