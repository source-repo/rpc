<!-- The wire identifiers here are the MQTT 5 property names with the `mr-` prefix removed, and that is deliberate rather than convenient: the two documents describe one protocol carried two ways, and a reader who has implemented either should recognise the other on sight. -->

# msgrpc over socket.io — frame layout

**Status: implemented.** `SocketIoClientTransport` and `SocketIoServerTransport` speak this by default. A server serves the older `$`-delimited layout at the same time, on a different socket.io event, so the two populations coexist without configuration. Verified with a vanilla `socket.io-client` and `@msgpack/msgpack` on the far side, in `src/SocketIoFrame.test.ts`.

## Why

An outsider wanting to call `meter.read('flow')` used to have to publish this, as one binary payload on the socket.io `message` event:

```
{"source":"hmi","target":"meterHost","time":1785187832623,"seq":0}$<msgpack>
```

Four things are wrong with it, and only the first is obvious.

**It is two encodings in one frame**, so the boundary between them has to be found before either can be read. **Finding the boundary needs a JSON parser**, because the header is JSON and a peer name containing a `$` puts one inside a quoted string, where it is data rather than punctuation. Splitting on the first `$` cut the header mid-string and handed the pieces to `JSON.parse`, which threw — on the MQTT path, into an unhandled rejection. So the real rule is: walk the bytes tracking brace depth, string state and backslash escapes, find the `}` whose next byte is `$`, and give up after 1024 bytes. That is `findHeaderEnd` in `Core.ts`, and `Framing.test.ts` and `Resilience.test.ts` exist because this library got it wrong first.

**The msgpack decodes to a doubly-nested envelope** — `{type: 'REQUEST', payload: {type: 'POST', id, path, method, params}}` — where the outer type is derivable from the inner one. And **the vocabulary is private**: `POST` means call, `path` is the instance name, `method: 'on'` means subscribe, and replies correlate on `payload.id`.

None of that is discoverable, and none of it resembles the MQTT 5 layout the same library documents. A peer written in another language therefore implements msgrpc twice.

## The frame

**One map, in one encoding.** MsgPack by default, JSON where a peer prefers it; the codec is the transport's, and both ends of a socket.io link agree on it at construction rather than per frame — unlike MQTT, where `contentType` travels on every packet, because there a peer may be answering a stranger.

```
socket.emit('frame', msgpack({
    v:      2,
    src:    'hmi',
    tgt:    'meterHost',
    kind:   'call',
    corr:   'c-1',
    path:   'meter',
    method: 'read',
    body:   ['flow']
}))
```

There is no delimiter, no length limit, no header, and nothing to scan. Reading a frame is `codec.decode(bytes)` — the call an implementer already has to make for the body.

| field | on | meaning |
| --- | --- | --- |
| `v` | all | frame format version, currently `2`. A frame announcing anything else is refused |
| `src` | all | sending peer name |
| `tgt` | all | addressee |
| `hops` | relayed frames | how many relays this frame has already passed through; absent means none |
| `kind` | all | `call` \| `subscribe` \| `unsubscribe` \| `result` \| `error` \| `event` \| `ticket` \| `batch` |
| `corr` | all but event | the request id, shared by a call and every later answer to it |
| `path` | call, subscribe, event | exposed instance name |
| `method` | call, subscribe | method name |
| `event` | event | event name |
| `code` | error | `RpcErrorCode` |
| `ver` | call, subscribe | contract version the caller declares |
| `ttl` | call, subscribe | milliseconds the caller will still wait, counted from sending |
| `idem` | call | names the command this is an attempt at, when the caller distinguishes the two |
| `fence` | call | the owner generation the caller observed for `path`, when it fences |
| `deferred` | result | `true` when this result is a receipt and the answer comes later as a `ticket` |
| `outcome` | ticket | `progress` \| `resolved` \| `rejected` |
| `seq`, `epoch` | event | this emission's position in the server's count, and the incarnation it counts within |
| `body` | all | arguments for a request, the value for a result, the emit arguments for an event |
| `batch` | batch | the frames this one carries |

`src` and `tgt` are in the frame because socket.io has one bidirectional link and no topic to carry addressing — the one place this layout must say something MQTT gets from its own protocol.

### Why the keys are words

They could be one character each and every frame would be smaller. The point of writing this down is that somebody implements it in a language nobody here has thought about, and `k`/`c`/`p` turn every debugging session into a lookup. The names are the MQTT 5 property names with `mr-` removed, so the two documents describe one protocol.

### What is deliberately absent

**`time` and `seq`** — the old header carried both and this transport read neither. They exist for the MQTT v1 signing canonicalisation.

**`nonce` and `sig`.** socket.io does not sign frames and does not need to: it authenticates the *connection* once at the handshake, and `SocketIoServerTransport` pins each frame's `src` to the identity that connection authenticated as. A peer therefore cannot send a frame claiming to be somebody else, which is what per-frame signing buys on MQTT — where there is no connection to attribute anything to, and the broker relays a `source` field written by whoever sent it. One check in one place beats a signature on every frame, when the transport can support it.

The security consequence is worth stating plainly: **a socket.io link with no `authenticate` is a link on which every peer name is an unchecked claim**, exactly as before. This layout changes nothing about that, in either direction.

## Deferred answers

A method that answers later replies twice on one `corr`: a `result` carrying `deferred: true`, whose body is the ticket rather than the answer, and then `ticket` frames whose `outcome` says whether the exchange is over. `progress` may arrive any number of times; `resolved` and `rejected` arrive once and end it.

```
{v:2, src:'jobHost', tgt:'hmi', kind:'result', corr:'c-9', deferred:true, body:{id:'c-9', expiresAt:…}}
{v:2, src:'jobHost', tgt:'hmi', kind:'ticket', corr:'c-9', outcome:'progress', body:50}
{v:2, src:'jobHost', tgt:'hmi', kind:'ticket', corr:'c-9', outcome:'resolved', body:{rows:100000}}
```

## Batch

Several calls in one frame, because twenty small calls in one envelope pay the envelope's cost once:

```
{v:2, src:'hmi', tgt:'meterHost', kind:'batch', batch:[
    {v:2, src:'hmi', tgt:'meterHost', kind:'call', corr:'c-1', path:'meter', method:'read', body:['a']},
    {v:2, src:'hmi', tgt:'meterHost', kind:'call', corr:'c-2', path:'meter', method:'read', body:['b']}
]}
```

**This is the one thing socket.io carries that MQTT 5 does not.** There, one publish pairs with one correlation through the protocol's own correlation data, and a batch has as many correlations as it has calls — so `MqttTransport` unpacks a batch into separate publishes and pays the overhead per call. Here there is one link and no correlation rule to break, so the saving is real. That asymmetry is why a batch is a field on this layout rather than a shape in the neutral frame: it is an envelope, and whether an envelope is worth anything is a property of the transport carrying it.

**A batch is not a transaction, and nothing should suggest it is.** No atomicity, no shared authorization, no ordering promise beyond the order the frames are dispatched in. Each carries its own `corr`, `ttl`, `idem` and `fence`, and each is answered separately. A batch carrying a frame that cannot be read is refused whole rather than partly dispatched — answering some of a caller's calls and leaving the rest to time out is the worst of the available outcomes to diagnose.

## Presence

Unchanged, on its own `presence` event, and deliberately not folded into the frame. It gains one field:

```
{name: 'hmi', v: 2, shape?: '…', carrying?: ['panel1']}
```

`v` exists because **a server has to address a peer it has not yet heard a frame from**. Frames negotiate by event name and need nothing announced, but an event pushed to a subscriber that announced itself and then only listened would otherwise have to be guessed at. Stated rather than defaulted, so the guess is never made.

The server answers an announcement with the peers it knows, which is socket.io's stand-in for the retained presence an MQTT subscriber is handed on subscribe.

## Version negotiation is the event name

A peer emitting `frame` speaks v2. A peer emitting `message` speaks the `$`-delimited v1. A server registers a listener for both and serves both, without reading a byte to tell them apart — socket.io hands an event to the listener registered for it, or to nobody.

That is cheaper than what MQTT needed, which was a whole topic-prefix change from `msgrpc/v1` to `msgrpc/v2` to keep its two populations from seeing each other. Here it costs one extra listener. A server replies to each peer in that peer's own dialect; an unknown dialect is v1, since a peer that has said nothing about itself is by definition not one that announced v2.

**The honest limit is the other direction.** A v2 client against a pre-v2 server emits an event that server has no listener for, and socket.io delivers it to nobody — so the call times out with nothing said. There is no handshake in which the client could have learned better before sending. That is why `SocketIoClientTransport` takes a `frameVersion`, and why `rpc` and the packages that track it version together.

## What a third party has to implement

A caller:

1. Connect with any socket.io client. Emit `presence` with `{name, v: 2}`.
2. Emit `frame` with `{v: 2, src, tgt, kind: 'call', corr, path, method, body: [...args]}`, encoded with the codec both ends agreed on.
3. Listen on `frame`. Decode. Match `corr` to the request. `kind` is `result` or `error`; `code` says which error.

A responder is the mirror image: listen on `frame`, read `path` and `method`, decode `body` as the argument array, and emit a `result` back with the same `corr` and `src`/`tgt` swapped. Honour `ttl` and `fence` the way [the MQTT spec](mqtt5-frame-spec.md) describes — the fields mean the same thing, which is the point of them having the same names.

No `$` splitting, no header parser, no nested envelope, no private vocabulary.

## Known limits

- **No per-frame signing**, by design — see above. A link crossing a trust boundary is secured by TLS and `authenticate`, not by signatures.
- **The codec is per link, not per frame.** A JSON-speaking third party sets the codec at construction; there is no `contentType` to negotiate per message, because both ends of a socket.io link are known to each other in a way an MQTT publisher and subscriber are not.
- **A v2 client cannot detect a v1-only server** before sending. See above.
- **Presence remains socket.io-shaped** and does not resemble MQTT's retained topics. Those are different mechanisms because the transports differ, and forcing one shape onto both would mean inventing retention socket.io does not need.
