# @source-repo/signalr

Source RPC over an ASP.NET Core SignalR hub, so a .NET process can be an ordinary peer.

## Why

The .NET world does not run socket.io servers. It runs SignalR — and a C# process that wants to join a Source RPC network can host a hub in a few lines, but cannot host a socket.io server without adopting a stack that is nobody's default there.

Without this, the only way to reach such a process is to put a broker between them and give it a topic of its own. That works, and it is a great deal of machinery for two programs on one machine — it makes a local integration depend on infrastructure being up, and it puts a network hop between a caller and a process it could have spoken to directly.

```ts
import { RpcClient } from '@source-repo/rpc'
import { SignalRClientTransport } from '@source-repo/signalr'

const client = new RpcClient(undefined, {
    name: 'hmi',
    defaultTarget: 'vs-automation',
    useMsgPack: false, // JSON hub protocol, which is what the C# reference assumes
    transport: new SignalRClientTransport('hmi', 'http://localhost:5217/rpc')
})

const solution = await client.proxy<{ open(path: string): Promise<void> }>('solution')
await solution.open('C:\\src\\Plant.sln')
```

## Client only

There is no `SignalRServerTransport`, and there will not be one: a SignalR server *is* ASP.NET Core, and there is nothing to host one with from Node. The direction is fixed — the .NET process is the hub and this dials in — which is the direction the problem has anyway, since the thing worth reaching is the .NET process.

## The hub side

[`csharp/`](csharp/) holds a reference implementation: the frame records, an `RpcHub` that routes between connected peers, an `IRpcResponder` for the methods this process serves, and `RpcEvents` for the ones it pushes. It compiles, and `csharp/testhost` runs it — see [`csharp/README.md`](csharp/README.md).

The transport speaks exactly what `SocketIoClientTransport` speaks, so the hub is implementing one documented protocol rather than a SignalR-shaped variant of one:

| | |
| --- | --- |
| `connection.send('frame', …)` | one flat frame, client to hub |
| `connection.send('presence', …)` | this peer's name and the layout it speaks |
| `Clients.*.SendAsync("frame", …)` | one flat frame, hub to client |
| `Clients.*.SendAsync("presence", …)` | who is here, and who came or went |

## The frame is an object, not bytes

Every other transport in this library encodes the frame itself, because MQTT carries a byte payload and socket.io carries whatever you hand it. SignalR is different: it *has* a serialization layer, and hub methods are typed. Encoding to bytes and passing the blob would mean the hub receives `byte[]` and decodes it by hand — throwing away the one thing SignalR does for a C# author.

So the frame goes as a frame, and `codec` picks the **hub protocol** rather than doing the encoding: MsgPack for `msgPackCodec`, SignalR's JSON otherwise. The difference that matters is binary inside `body` — MsgPack carries a byte array as one, JSON base64s it.

## Reconnection

SignalR does not reconnect unless asked, and its own default gives up after four attempts. This retries indefinitely, backing off to 30 seconds, because on a plant the far end may be down for a maintenance window and the link has to come back without anyone restarting anything. Pass `reconnectDelaysMs` to change the shape of that.

## Testing

`SignalRClientTransport.test.ts` runs anywhere: it drives the transport against a stubbed connection and asserts the frames it produces and accepts.

`Interop.test.ts` drives a real `RpcClient` against the real C# hub — a call, a thrown exception, a subscription, an unsubscribe, and the event cursor. It needs a .NET SDK, and skips without one:

```
npm run hub --workspace=@source-repo/signalr          # in one terminal

SOURCE_RPC_TEST_SIGNALR_HUB=http://127.0.0.1:5217/rpc \
SOURCE_RPC_REQUIRE_SIGNALR=1 npm test --workspace=@source-repo/signalr
```

`SOURCE_RPC_REQUIRE_SIGNALR=1` turns the skip into a failure, which is what CI wants: these tests reporting ✔ having run nothing is the one outcome worse than red.

## Limits

- **No per-frame signing.** Like socket.io, this trusts the connection: the hub authenticates it and should pin each frame's `src` to that identity. Unlike MQTT, there is no broker in the middle relaying a `source` field nobody checked. A hub with no authentication is one where every peer name is an unchecked claim.
- **The reference hub serves methods, publishes events and routes frames.** Tickets, deadlines, idempotency and owner fences are described in the frame spec and are yours to add where they earn their place.
