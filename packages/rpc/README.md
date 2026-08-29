```
███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗███████╗
██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝██╔════╝
███████╗██║   ██║██║   ██║██████╔╝██║     █████╗
╚════██║██║   ██║██║   ██║██╔══██╗██║     ██╔══╝
███████║╚██████╔╝╚██████╔╝██║  ██║╚██████╗███████╗
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝
██████╗ ██████╗  ██████╗
██╔══██╗██╔══██╗██╔════╝
██████╔╝██████╔╝██║
██╔══██╗██╔═══╝ ██║
██║  ██║██║     ╚██████╗
╚═╝  ╚═╝╚═╝      ╚═════╝
```

# @source-repo/rpc

TypeScript RPC for a network of peers — a browser tab, a Node service, and a plant full of devices — over socket.io and MQTT 5, with one programming model across all of them.

A class is the contract: the server hands one live instance to `exposeClassInstance`, the client gets a typed proxy of the same class, and calling a method on the proxy runs it on that instance. No code generation and no schema files required, though there is a schema when you want arguments checked at runtime.

```
npm install @source-repo/rpc
```

ESM only, Node 22 or later, and it runs in the browser.

**Documentation: [source-repo.github.io/rpc](https://source-repo.github.io/rpc/)** — the guide, the tools and the operations pages, with search.

**If all you need is a browser talking to one backend, use [tRPC](https://trpc.io), typically with TanStack Query.** It is today the more battle-tested choice for a conventional web app, and we recommend it for that shape.

tRPC: the browser calls an application. Source RPC: the browser joins a system.

Source RPC is for systems: peers on both sides of the browser boundary, components with live observable state, multiple addressable services, and AI/MCP participation across the network. Use it when your app is, or is becoming, a distributed, MCP-enabled topology.

## Quick start

```typescript
// calculator.ts - nothing here is Source RPC-specific
export class Calculator {
    private memory = 0
    async square(n: number) { return n * n }
    async add(n: number) { this.memory += n; return this.memory }
}
```

```typescript
// The server. With no transports configured it listens on WebSocket (socket.io) port 7843.
import { RpcServer } from '@source-repo/rpc'
import { Calculator } from './calculator.js'

const server = new RpcServer()
server.exposeClassInstance(new Calculator(), 'calculator')
await server.ready()
```

```typescript
// A client - another process, a browser page, or the same process for testing.
import { RpcClient } from '@source-repo/rpc'
import type { Calculator } from './calculator.js'    // the type only: no implementation in the bundle

const client = new RpcClient('http://localhost:7843')
await client.ready()

const calculator = await client.proxy<Calculator>('calculator')
console.log(await calculator.square(3))      // 9
console.log(await calculator.add(10))        // 10
console.log(await calculator.add(5))         // 15 - one instance, holding its own state
```

## What is in it

- **[Command semantics for machinery.](https://source-repo.github.io/rpc/guide/commands)** A method declares whether repeating it is free, harmless or dangerous; a caller can tell *did not run* from *may have run*; a durable idempotency hook makes a redelivered command run once; declared commands serialise per instance behind a bounded mailbox, and setpoint-shaped commands can conflate.
- **[Observable components.](https://source-repo.github.io/rpc/guide/components)** Cached `props` and `state` snapshots with epoch/revision ordering, a per-channel status of `initializing | live | stale | closed` that keeps last-known data readable, and a store that plugs straight into `useSyncExternalStore`.
- **[Command authority.](https://source-repo.github.io/rpc/guide/authority)** `$acquire`/`$release` — the plant's arbitration concept: granted, visible in every snapshot, always expiring, with only declared methods ever gated, so an E-stop is never behind a held lease.
- **[Topology and context.](https://source-repo.github.io/rpc/guide/topology)** Every host answers for where its components sit — physically and logically — with durable epochs, an owner fence on calls, and [inherited context](https://source-repo.github.io/rpc/guide/context) resolved across hosts with atomic remounts.
- **[Three transports, one model.](https://source-repo.github.io/rpc/guide/connecting)** socket.io for browsers and anything that dials out; MQTT 5 for the plant, with a [documented wire format](https://source-repo.github.io/rpc/mqtt5-frame-spec) a plain MQTT.js peer can speak; SignalR for reaching a .NET host. Two wire formats carry one [neutral frame](https://source-repo.github.io/rpc/flat-frame-spec), so a call means the same thing on all three and only the spelling differs. Any peer can be a bus, and a browser tab can host a server.
- **[Contracts checked at runtime](https://source-repo.github.io/rpc/guide/contracts)**, compared between versions so a change that would break a deployed caller fails a build rather than a plant — and `describe()`, so a server reports what it exposes.
- **A component's logic can live on its own thread.** `RpcWorkerHost` runs one instance in a worker and `callable()` returns a forwarder that `exposeClassInstance` takes like any other object — the dispatch path does not know the difference, so deadlines, authority, ownership fencing and idempotency stay where calls arrive. What it buys is that the logic can be **stopped**: `Atomics.wait` parks a thread outright, and a component sharing a thread with its own socket cannot be parked without parking the socket. What it costs is stated rather than discovered — an exception crosses as its message, name and code, and one instance per worker, because a parked thread freezes everything on it. Arguments and results are checked against **`RpcValue`**, which is what *any* of this library's boundaries carries rather than what a worker happens to accept: a class instance would cross a thread and arrive with no methods, and would arrive at a remote peer the same way, so it is refused with the path named. The narrowest boundary decides, and that is what keeps placement unobservable — moving a component onto a thread does not widen what may be said to it, and moving it onto another host does not narrow it again.
- **A worker-hosted component is still a component.** `serveComponentInWorker` on one side and `host.component()` on the other divide it: the worker owns the executable logic and the private mutable state, and the supervisor owns identity, security, authority and the last published snapshot. The facade *is* an `RpcComponent`, so `exposeClassInstance` installs snapshot publication and accepts `sets` and `requiresAuthority` against it exactly as for any other — a commit in the worker becomes a snapshot here, and an event it emits reaches subscribers here. What falls out is worth having: while the logic is parked at a breakpoint, this side still answers and a console still reads the last snapshot the component published.
- **[Authentication both ways.](https://source-repo.github.io/rpc/guide/security)** Per-connection tokens where there is a connection, per-frame signing (HMAC or Ed25519) where there is not, `authorize()` on every call and subscription, TLS with a plant's own CA.

## Related packages

Everything here speaks the same protocol as this package, so a peer written against any of them is an ordinary peer to all the others.

**Tooling**

- [`@source-repo/rpc-cli`](https://www.npmjs.com/package/@source-repo/rpc-cli) — contract extraction, the browser console, taps, record/replay, fakes, an MCP server and find-by-capability.

**Serving something that already exists**

Each of these puts an existing system on the network as `DataProvider` resources, so a console or another peer browses it without knowing what is behind it.

- [`@source-repo/document`](https://www.npmjs.com/package/@source-repo/document) — an existing MongoDB database.
- [`@source-repo/relational`](https://www.npmjs.com/package/@source-repo/relational) — an existing SQL database, over Kysely.
- [`@source-repo/docker`](https://www.npmjs.com/package/@source-repo/docker) — containers, read-only, over the Engine API and nothing else.

**Beyond request and reply**

- [`@source-repo/queue`](https://www.npmjs.com/package/@source-repo/queue) — a lease-based work queue: every-value work with leases, retries, dead letters, and capacity that refuses rather than drops.
- [`@source-repo/sparkplug`](https://www.npmjs.com/package/@source-repo/sparkplug) — Sparkplug B. The session substrate is here: the vendored protobuf definition, topic helpers, birth/death payloads and the Edge Node sequence discipline. Projecting components as Edge Nodes, ingestion and controlled commands come after it.

**Reaching .NET**

A .NET process is a peer rather than a special case. Which package depends only on which way the connection is opened.

- [`@source-repo/signalr`](https://www.npmjs.com/package/@source-repo/signalr) — the TypeScript side: a client transport that dials into a C# hub.
- `SourceRpc` on NuGet is the .NET side — the frame, dispatcher, client, error model and telemetry, depending on nothing but the BCL — with `SourceRpc.SignalR` (a hub for a process others dial into, and a client for one that dials out), `SourceRpc.Mqtt` (a peer on a broker, speaking the `mr-` property layout so a plain MQTT client can take part) and `SourceRpc.SocketIo` (a client for a .NET process joining a TypeScript socket.io server). See [the .NET README](https://github.com/source-repo/rpc/blob/main/packages/csharp/README.md).

`@source-repo/conformance` is in the repository but deliberately unpublished: it is the normative `DataProvider` fixture and question set that the store-backed packages above test themselves against, and it is a development dependency rather than something to install.

Upgrading? [`CHANGELOG.md`](https://github.com/source-repo/rpc/blob/main/CHANGELOG.md) lists what changed, release by release, with the reasoning.
