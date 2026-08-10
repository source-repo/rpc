# @source-repo/docker

**Three tiers, in three namespaces, behind three imports — and that separation is the design.**

| import | namespace | what it can do | gate |
| --- | --- | --- | --- |
| `@source-repo/docker` | `docker` | read | none beyond reaching the socket |
| `@source-repo/docker/control` | `docker.control` | start, stop, restart, remove **existing** containers | a name or label allow-list |
| `@source-repo/docker/create` | `docker.create` | create and pull | an image allow-list, and a spec that cannot escape |

Two namespaces are two `authorize()` surfaces, which is why these are composed rather than subclassed: an operator can grant reading to everyone and control to nobody. A subclass would have made "may call docker" one permission, and would have made the read-only class's promise a lie by inheritance.

**The tiers are not the same risk, and saying "the Docker socket is root on the host" as though they were is where this usually goes wrong.** Restarting a container that already exists escalates nothing — its image, its mounts and its privileges were chosen by whoever created it. *Creating* one is where a caller chooses those, and where the escape actually lives.

So the create spec **cannot express an escape**: no bind mounts, no `privileged`, no added capabilities, no devices, no host network, no host PID namespace. Not a deny-list — a closed shape with nowhere to put them, which is the same move the filter grammar makes. A deny-list is a list somebody has to keep complete; a closed shape is one nobody can add to from outside. What remains is roughly "run this allow-listed image", which is about as dangerous as the image, and the allow-list is what that is for.

**Everything is closed by default.** No manage rules, nothing controllable. No image allow-list, nothing creatable. Both refusals say which it is rather than reporting a daemon error. And a rule that constrains nothing is refused where it was written, because an empty rule read as "no constraints" is read as "everything".

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
