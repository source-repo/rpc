# SourceRpc.Mqtt

Source RPC over MQTT 5 — a peer on a broker.

There is no server to write on this carrier, because the broker is the middle: a peer subscribes to its own topics and publishes to other peers'. It speaks the `mr-` property layout rather than putting a frame in the payload, which is what lets a plain MQTT client with no Source RPC code take part — and lets an operator see why a call failed in MQTT Explorer without decoding anything.

```csharp
await using var transport = new MqttTransport(
    new MqttTransportOptions { BrokerUrl = "mqtt://plant-broker:1883" },
    options);
```

**Frames can be signed.** MQTT is the one carrier with no connection to attribute a message to, so `mr-src` is only a claim until something checks it. HMAC signing, a replay guard and a reply-address policy are included, and the canonical bytes are byte-identical with the TypeScript library's.

Needs [`SourceRpc`](https://www.nuget.org/packages/SourceRpc), which comes with it. Documentation: [github.com/source-repo/rpc](https://github.com/source-repo/rpc/blob/main/packages/csharp/README.md).
