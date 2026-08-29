# @source-repo/rpc

The library: classes as contracts over socket.io and MQTT 5, with the machinery a plant needs and a browser tolerates.

```
npm install @source-repo/rpc
```

- **Command semantics** — `query`, `idempotent-command`, `non-repeatable-command` declared on the contract; graded execution defaults, a bounded mailbox, conflation for setpoint-shaped commands, and a durable idempotency hook.
- **Observable components** — `RpcComponent<Props, State>` with cached snapshots, epoch/revision ordering, per-channel `initializing | live | stale | closed`, and a store that plugs into `useSyncExternalStore`.
- **Command authority** — `$acquire`/`$release`, the plant's arbitration concept: granted, visible in every snapshot, always expiring, with only declared methods ever gated.
- **Topology** — every host answers for its components' `parent` and `owner` with durable epochs, CAS mutations, and an owner fence on calls (`$with({ ownerEpoch })`).
- **Structural context** — `defineRpcContext` tokens resolved through one declared axis, across hosts, with atomic remounts and bounded, explicit capture.
- **Security** — per-connection authentication, per-frame signing (HMAC or Ed25519), `authorize()` on every call and subscription, TLS with a plant's own CA.
- **One rule for what may cross a boundary** — `RpcValue` checks a value against what *every* placement carries rather than what the nearest one happens to accept, so a class instance, a cycle or a shared buffer is refused with its path named instead of arriving flattened, or crossing a thread and failing at a host. The narrowest boundary decides, which is what keeps placement unobservable.
- **A worker-hosted component is still a component** — the worker owns the logic and the private state; the supervisor owns identity, authority and the last published snapshot. The facade is a real `RpcComponent`, so the server exposes it, publishes its snapshots and gates its declared methods without knowing where the logic runs. While that logic is parked at a breakpoint, a console still reads the last snapshot it published.
- **Logic can be hosted on its own thread** — `RpcWorkerHost` runs one instance in a worker and hands back a forwarder the ordinary exposure takes, so the whole policy stack stays on the transport's thread and only the handler crosses. That is what makes a component stoppable mid-handler: a thread parked by `Atomics.wait` is parked outright, so a component that shares a thread with its socket cannot be paused without pausing the socket.

Full documentation: [the guide](../guide/getting-started.md) and the [CHANGELOG](https://github.com/source-repo/rpc/blob/main/CHANGELOG.md). On npm: [@source-repo/rpc](https://www.npmjs.com/package/@source-repo/rpc).
