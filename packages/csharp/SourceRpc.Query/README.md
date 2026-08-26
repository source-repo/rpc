# SourceRpc.Query

The pull half of a [Source RPC](https://github.com/source-repo/rpc) network, for .NET: what a failure means, whether a call may be sent again, a deadline that is a budget across attempts, and a canonical cache key — over [Polly](https://www.pollydocs.org) and [FusionCache](https://github.com/ZiggyCreatures/FusionCache).

Beside `SourceRpc` rather than in it: the core depends on nothing but the BCL, and a device binding that never pulls should not carry a resilience engine and a cache to reach a network it only answers. Its own version line, because it is built against the core's public API rather than against its shape.

Two libraries rather than one because **Polly deliberately has no cache** — the v7 cache policy is gone and the project defers to caching libraries. Resilience is Polly's, storage is FusionCache's, and what is here is what neither can know.

```csharp
var budget = new RpcCallBudget(TimeSpan.FromSeconds(10));
var readings = await RpcResilience.ExecuteAsync(
    budget,
    (options, token) => client.CallAsync<Reading[]>("oven3", "plant", "readings", null, options, token),
    new RpcResilienceOptions { Semantics = RpcMethodSemantics.Query },
    cancellationToken: token);
```

**A deadline is a budget across every attempt.** Every resilience engine offers a timeout per attempt and almost none offers what remains — so three attempts under a "ten second timeout" that each restart the clock is a caller waiting thirty seconds having asked for ten. Each attempt is handed the options for this go with the ttl set to what is left, so the far end can refuse work that is already too late; a budget with nothing left refuses locally rather than sending a zero, because zero means *no deadline* on this wire.

**Retrying reads the error vocabulary rather than the exception type.** A `TransportError` is retried even for a non-repeatable command — it never left, so it has had no effect to repeat — and an `UnknownOutcome` is retried for nothing the caller did not declare repeatable. Undeclared means undeclared.

**The cache key is a port of the TypeScript encoder rather than an equivalent of it.** Two callers who built the same arguments differently are asking one question, and on the link this was written for asking twice is a screen that takes twice as long to draw. Its expected strings in `SourceRpc.Tests` were produced by the TypeScript implementation, so changing either encoder fails one of the two suites.

**What is deliberately absent is freshness from the publisher.** A page drawn at the revision a component channel currently holds is *confirmed current* rather than merely recently fetched, and a .NET peer cannot observe a component at all. Until that changes this is an age window, labelled as one.

## License

MIT
