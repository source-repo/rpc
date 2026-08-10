# @source-repo/docker

What is running on this host, as a Source RPC node — and, in two further tiers a host opts into separately, the ability to change it.

```
npm install @source-repo/docker
```

- **Three tiers, three namespaces, three imports.** `@source-repo/docker` reads. `@source-repo/docker/control` starts, stops, restarts and removes *existing* containers. `@source-repo/docker/create` makes them. Composed rather than subclassed, because two namespaces are two `authorize()` surfaces — an operator can grant reading to everyone and control to nobody.
- **The tiers are not the same risk.** Restarting a container that already exists escalates nothing: its image, mounts and privileges were chosen by whoever created it. *Creating* one is where a caller chooses those, so the create spec **cannot express an escape** — no bind mounts, no `privileged`, no capabilities, no devices, no host network — as a closed shape rather than a deny-list somebody has to keep complete.
- **Closed by default.** No manage rules means nothing controllable; no image allow-list means nothing creatable. Both refusals name which, rather than reporting whatever the daemon would have said.
- **The smallest honest example of the component split.** How many containers are running is a bounded fact a contract can name, so it is *state* and a console subscribes to it. *Which* containers exist is data that changes as things are started elsewhere, so it is a `dataResources()` collection a caller pages, filters and orders — through the library's own matcher, so `state:exited` means here what it means over any other resource.
- **No dependencies.** `http.request` takes a `socketPath`, which is all talking to the Docker daemon has ever required.

Reachability is published as a fact rather than thrown: a host without Docker is an ordinary thing for this to run on, and it says so with a message naming what to check.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/docker/README.md). On npm: [@source-repo/docker](https://www.npmjs.com/package/@source-repo/docker).
