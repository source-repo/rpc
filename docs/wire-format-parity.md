# One frame model, two transports

**Status: proposal.** Nothing here is implemented. It exists because a peer written in another language currently has to implement msgrpc twice — once for MQTT 5, once for socket.io — and the two share no vocabulary.

## The thing that changes the order of the work

The obvious move is "make socket.io look like MQTT 5, since MQTT 5 is the documented one". That is the right destination and the wrong first step, because **the MQTT 5 frame is not a full expression of the protocol**. Four things travel over socket.io today and are lost on the way to MQTT 5, none of them noisily:

| carried in | what happens on MQTT 5 | consequence |
| --- | --- | --- |
| `RpcCallInstanceMethodPayload.fence` | no `mr-` property; dropped by `toOutboundFrame` | a fenced call arrives **unfenced**, `fenceRefusal` sees nothing to check, and the command runs under an ownership the caller did not observe |
| `RpcSuccessPayload.deferred` | dropped | the caller gets the ticket value as if it were the answer, and never hydrates it |
| `RpcMessageType.ticket` | no case in `toOutboundFrame` at all → `unroutable` | `defer()` never delivers its real answer; the caller waits out the ticket |
| `RpcEventPayload.seq` / `epoch` | dropped | the event cursor cannot say "gapless", only "saw nothing" |

The first is the one to act on independently of any interop work. A fence is a safety mechanism, it is silent when it fails, and it fails in exactly the direction a safety mechanism must not: a delayed or retried command executes under a reassigned owner. `RpcClientHandler` sets `fence` at line 415; nothing between there and the broker carries it.

None of the four is covered by `Mqtt5.test.ts`. `Ticket.test.ts` and `EventCursor.test.ts` run over socket.io only, which is why all of this is green.

So the order is: **fix the frame model, then map both transports onto it.** Aligning socket.io with a lossy model would standardise the loss.

## What an outside implementer actually pays today

Over MQTT 5, the spec's own summary holds — subscribe, read `mr-path` and `mr-method`, decode the payload as an argument array, publish to `responseTopic`. Four steps, no msgrpc-specific parsing.

Over socket.io the same peer must:

1. Speak socket.io, and receive `message` as binary.
2. **Find the header boundary by scanning JSON with its own quoting rules** — `findHeaderEnd` in `Core.ts` walks the bytes tracking brace depth, string state and backslash escapes, looking for the `}` whose next byte is `$`, giving up at `MAX_HEADER_LENGTH`. A plain `indexOf('$')` is wrong, and the tests recording why are `Framing.test.ts` and `Resilience.test.ts`.
3. `JSON.parse` the header for `source`, `target`, `hops`.
4. MsgPack-decode the remainder into `{type, payload}` — two encodings in one frame, and a doubly-nested envelope.
5. Know that `type: 'REQUEST'` and `payload.type: 'POST'` both mean call, that `path` is the instance name, that `method: 'on'` means subscribe, and that replies correlate on `payload.id` rather than on anything the transport knows about.
6. Emit `presence` with `{name}` and interpret `PresenceUpdate`, whose snapshot form and delta form are the same type with different fields set.

Step 2 is the expensive one and it is pure accident. It exists only because the header is JSON and the body is MsgPack, so the frame needs a boundary that neither encoding provides. Everything else on the list is vocabulary a document could fix; that one is a bespoke parser an implementer has to get byte-exact or drop frames silently.

## Proposal

### 1. Promote the neutral frame

`OutboundFrame` / `InboundFrame` in `Transports/Mqtt5Frame.ts` are already the transport-independent shape the MQTT 5 spec's *Implementation shape* section asked for — they are just filed under MQTT because MQTT was the only transport that needed them. Move them to `RPC/Frame.ts` as the shared vocabulary, and leave `Mqtt5Frame.ts` holding only the MQTT-specific half: the `mr-` names, the topic mapping, the canonical signed form.

Extend the frame to cover what the table above lists — `fence`, `deferred`, a `ticket` kind with its `outcome`, and event `seq` / `epoch`. That is where the model becomes complete, and both transports inherit it.

On MQTT that means new `mr-` properties. They decide what a receiver does, so they enter the signed canonical form, so **`mr-v` goes 2 → 3** by the same argument the 1 → 2 bump was made on. If that is judged too expensive right now, the honest alternative is not to keep dropping them silently: state the limitation in the spec and make `publishV5` emit `unroutable` for a frame carrying something it cannot represent, so a broken `defer()` looks broken.

### 2. A socket.io v2 frame: one MsgPack map

```
{ v, src, tgt, kind, corr, path, method, event, code, ver, ttl, idem, fence, seq, epoch, hops, body }
```

One encoding, one decode, no delimiter, no length limit on the header, no `findHeaderEnd`. Short keys keep it smaller than today's JSON header plus delimiter, and `body` stays exactly what MQTT 5 puts in the payload — the argument array for a request, the bare value for a result — so the two transports carry an identical `body` and an implementer writes that half once.

`kind` is the MQTT 5 vocabulary verbatim: `call` / `subscribe` / `unsubscribe` / `result` / `error` / `event`, plus `ticket`. `corr` is the request id, which on MQTT is correlation data. `src` and `tgt` stay in the frame because socket.io has no topic to carry addressing and relaying needs both.

No `nonce` or `sig`. socket.io authenticates once at the handshake and `SocketIoServerTransport` pins `header.source` to the authenticated identity; per-frame signing is the MQTT v4 path's business and nothing on this transport reads those fields.

### 3. Negotiate by event name, not by sniffing

Emit v2 frames on a socket.io event named `frame` rather than `message`. A peer emitting `frame` speaks v2, a peer emitting `message` speaks v1, and a server listening for both serves both with no version field to read and no bytes to sniff. Drop `message` once nothing sends it.

This is the part MQTT could not do cheaply — it needed a whole prefix change to `msgrpc/v2` to keep the two populations apart. socket.io has a handshake and a namespace of event names, so the migration costs one extra listener.

## What this does not fix

Presence stays different, and should. MQTT gets discovery from retained messages; socket.io gets it from a server that knows who is connected. Those are different mechanisms because the transports are different, and forcing one shape onto both would mean inventing retention socket.io does not need. Documenting the `presence` event properly is the whole job there.

socket.io itself is still a protocol an implementer has to obtain a library for, and that is a larger dependency than an MQTT client. For a C# node with a choice, MQTT 5 remains the cheaper wire — this proposal narrows the gap rather than closing it.

## Recommendation

Worth doing, in this order:

1. **`fence` over MQTT 5** — on its own, ahead of everything else here. It is a silent safety failure, not an interop inconvenience.
2. **The neutral frame plus the missing kinds**, with the `mr-v` bump. This is the part that makes "the protocol" a thing that exists in one place.
3. **The socket.io v2 frame**, which after step 2 is a mapping exercise rather than a design one.

Steps 1 and 2 are worth it even if nobody ever writes a non-TS peer, because they are the difference between four features that work and four features that work on one transport. Step 3 is the one that answers the original question, and it is the cheapest of the three.
