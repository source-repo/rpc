# Authentication and authorization

Both are off by default, so an unconfigured server accepts any peer and allows any exposed call. The management surface is *not* off by default in the same sense — it is simply never published unless asked for. See below.

### Authenticating peers

`authenticate` receives whatever the client sent as `credentials` and returns an identity to accept the peer, or `undefined` to reject it. Rejected peers never reach the RPC layer — the check runs as socket.io middleware, before the connection is established at all.

```typescript
const server = new RpcServer({
    transports: [{ port: 7843 }],
    authenticate: async (credentials) => {
        const user = await lookUpToken((credentials as { token?: string }).token)
        return user && { name: user.id, roles: user.roles }
    }
})

const client = new RpcClient('http://localhost:7843', {
    name: 'operator-17',              // must equal the identity's name, see below
    credentials: { token: 'a-token' }
})
```

**`RpcClientOptions.name` must match `RpcIdentity.name`.** The `source` field of a message is written by the sender, so it is a claim, not evidence. An authenticating transport pins each connection to the name it authenticated as and drops frames claiming any other source. Without that, an authenticated peer could address its calls as another peer and inherit its rights.

It pins the peer *registry* to the same rule. A frame's source is normally learned as it is parsed, which is how discovery works over MQTT — the broker is the authority there and there is no connection to check. Where there is one, a name is registered only once the connection has been checked, so a rejected frame cannot leave a peer that does not exist in the routing table.

### Tokens, without writing the authenticator

`createTokenAuthenticator` is the common case packaged: a map from bearer token to the peer it admits.

```typescript
import { createTokenAuthenticator, defaultWebSocketPort, RpcServer } from '@source-repo/rpc'

const server = new RpcServer({
    transports: [{ port: defaultWebSocketPort }],
    authenticate: createTokenAuthenticator({
        [process.env.PLANT_TOKEN!]: 'plantServer',
        [process.env.HMI_TOKEN!]: { name: 'hmi', roles: ['operator'] }
    })
})
```

**One token per peer, not one token for the bus.** A token that maps to a name is evidence of who is calling, and the rule above then does the rest: a holder that connects under any other name gets a socket and nothing else — its announcement is refused, so it is never listed, and its frames are dropped. A single token shared by everyone proves only that the caller is inside the fence, and any holder could then claim to be the peer whose commands matter. There is deliberately no single-secret form.

Blank tokens, grants with no name and an empty map all throw rather than construct, because each one would quietly admit more than it looks like it does.

### Authorizing calls

`authorize` runs for every call and every event subscription. Return false to reject with a `Forbidden` error.

```typescript
const server = new RpcServer({
    transports: [{ port: 7843 }],
    authenticate,
    authorize: ({ identity, instanceName, method, subscription }) => {
        if (subscription) return identity?.roles?.includes('observer') ?? false
        if (instanceName === 'plant' && method.startsWith('write')) return identity?.roles?.includes('engineer') ?? false
        return true
    }
})
```

An authorizer that throws denies the call. Failing open would turn a bug in the authorizer into an access-control bypass.

`requireAuthenticatedPeers` defaults to true when `authenticate` is set, rejecting calls from peers no transport can vouch for with an `Unauthorized` error.

### The management surface

`manageRpc` is **not exposed by default**. Enabling it publishes exactly one method, `createRpcInstance`, which constructs an instance of a class already passed to `exposeClass()`:

```typescript
const server = new RpcServer({ transports: [{ port: 7843 }], exposeManagement: true })
```

It is still subject to `authorize`, so you can restrict who may create instances. The `expose*` methods are never remotely reachable.

> Versions before 2.0.0 published all of `ManageRpc` under `manageRpc` with no authentication, so any peer that could reach the transport could construct any `exposeClass`'d class with chosen arguments, or overwrite an exposed name and deny service to every other client. If you are upgrading, treat both as having been reachable.

## A peer says what it can currently do that is dangerous

Before there is any mechanism for *granting* elevated access, there should be one for **seeing** it — because a gate whose state nobody can observe is a gate nobody can audit. Today the question "is anything on this network unlocked right now" should have an answer without calling anything.

`describe()` carries `elevated`, and a console shows it above everything else on the peer:

```
elevated   docker.create — may create containers from postgres, emqx/emqx · until someone closes it
```

**It announces and nothing more.** `authorize()`, the AI grants document and the capability's own allow-list decide what may happen, and would decide exactly the same with this field removed. What it buys is that the posture travels.

**It is asked of the instance, not remembered by the host.** A component that *is* an elevation implements `elevation()`, so composing it into a host is what makes the host announce it — the way `dataResources()` works. That matters because the failure this exists to catch is somebody forgetting, and an announcement you have to remember to make is one that will be missed exactly when it counts.

For a capability that is not an object — a mounted socket, a debug endpoint, a flag somebody passed — the host declares it directly:

```typescript
const held = server.elevate({ capability: 'debug.endpoint', reason: 'diagnosing', until: Date.now() + 2 * 3600_000, grantedBy: 'anders' })
// …later, or by itself when `until` passes
held.lower()
```

**The most important field is `until`, and the most important case is its absence.** An elevation nothing will close is one somebody has to remember to close — the taped-over key, opened for a reason that passed while nobody came back. A viewer draws that as worse than a bounded one rather than the same, and where an `until` is given it is enforced as well as announced, so the announcement cannot outlive the thing.

A lapsed elevation is not announced at all. Posture is what is true now; history belongs in the audit trail.

