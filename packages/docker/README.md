# @source-repo/docker

**This package reads and never writes, and that is the whole of its design.**

Write access to the Docker socket is **root on the host**. There is no namespace to bound it to and no RBAC above it: a caller able to create a container can mount `/` and own the machine. That is a security posture with a support contract attached, and it is deliberately not this package. The engine client here issues `GET` and has no method that does anything else, and the container resource declares no actions, so a console draws no buttons.

Starting and stopping things belongs to a runtime provider — a different product, with the operational burden that goes with it. This is the other half: seeing what is running, which is small, useful on its own, and safe to reason about.

## What it is

A plant box with a handful of containers is far commoner than a cluster, and the question asked about one is nearly always the same: what is running, what stopped, and when. This answers that over the network the rest of the site already uses, rather than over SSH.

```typescript
import { DockerService } from '@source-repo/docker'

const docker = new DockerService()          // /var/run/docker.sock, counts every 10s
await docker.refresh()
server.exposeClassInstance(docker)
```

## The split it demonstrates

**How many is state. Which ones is a resource.**

`running`, `exited` and `total` are bounded facts the contract can name, so they are published as state and a console subscribes to them — they arrive by themselves and cost a handful of bytes.

*Which* containers exist is data: it changes as things are started elsewhere, and nothing in a contract could enumerate it. So it is a `dataResources()` collection a caller asks for a page of, filters (`state:exited`), orders and pages — using the library's own matcher and pager, so a search means the same thing here as over any other resource.

That is the boundary the whole component model draws, and this is about the smallest honest example of it.

## Reachability is a fact, not an exception

A host without Docker is an ordinary thing for this to be running on. It does not throw at whoever polled — it publishes `reachable: false` with a `problem` that says what to check:

```
no Docker daemon at /var/run/docker.sock - is Docker running, and is this process
allowed to reach its socket?
```

The permission half of that message is there because it is the likelier cause on a machine that does have Docker.

## No dependencies

Node's `http.request` takes a `socketPath`, which is all talking to the Docker daemon has ever required. A client library would be a dependency a plant node carries forever for the sake of a dozen lines.

## Tests

The suite runs without Docker: the "no daemon" behaviour is checked directly, and the live half skips. That is right on a laptop and wrong in CI, where a run reporting itself green having quietly skipped half of itself is the run somebody trusts — so `SOURCE_RPC_REQUIRE_DOCKER=1` turns the skip into a failure. Same guard, same reasoning, as the MQTT suites in the main package.

`DOCKER_SOCKET` points the tests somewhere other than the default.
