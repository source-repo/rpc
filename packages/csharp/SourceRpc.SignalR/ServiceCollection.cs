using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

using SourceRpc;

namespace SourceRpc.SignalR;

/// <summary>What <see cref="SourceRpcServiceCollectionExtensions.AddSourceRpc"/> returns, so registration reads as one statement.</summary>
public sealed class SourceRpcBuilder
{
    internal SourceRpcBuilder(IServiceCollection services) => Services = services;

    /// <summary>The underlying collection, for anything these extensions do not cover.</summary>
    public IServiceCollection Services { get; }

    /// <summary>
    /// Register the responder that serves this process's methods. Constructed by the container, so
    /// it may take a logger, a device client, <see cref="ISourceRpcEvents"/> or anything else.
    /// </summary>
    public SourceRpcBuilder AddResponder<T>() where T : class, ISourceRpcResponder
    {
        Services.AddSingleton<ISourceRpcResponder, T>();
        return this;
    }

    /// <summary>
    /// Record who owns each instance, so owner-fenced calls can be enforced.
    ///
    /// Without one, a call carrying a fence is **refused** - a peer that accepted a fence it could
    /// not check would be telling the caller its command had been guarded when nothing had.
    /// </summary>
    public SourceRpcBuilder AddOwnership<T>() where T : class, IRpcOwnership
    {
        Services.AddSingleton<IRpcOwnership, T>();
        return this;
    }

    /// <summary>
    /// Keep the outcomes of commands that carry an idempotency key, so a retry is answered rather
    /// than re-executed.
    ///
    /// Use <see cref="InMemoryIdempotencyStore"/> only where a restart forgetting an outcome is
    /// acceptable; a host that dispenses, advances a batch or starts a pump wants something durable.
    /// </summary>
    public SourceRpcBuilder AddIdempotencyStore<T>() where T : class, IRpcIdempotencyStore
    {
        Services.AddSingleton<IRpcIdempotencyStore, T>();
        return this;
    }

    /// <summary>Register an already-constructed responder.</summary>
    public SourceRpcBuilder AddResponder(ISourceRpcResponder responder)
    {
        Services.AddSingleton(responder);
        return this;
    }
}

/// <summary>Registration for a Source RPC hub.</summary>
public static class SourceRpcServiceCollectionExtensions
{
    /// <summary>
    /// Add everything a Source RPC hub needs.
    ///
    /// <code>
    /// builder.Services
    ///     .AddSourceRpc(options => options.Name = "vs-automation")
    ///     .AddResponder&lt;AutomationSurface&gt;();
    ///
    /// var app = builder.Build();
    /// app.MapSourceRpc("/rpc");
    /// </code>
    ///
    /// SignalR, both hub protocols, the routing and subscription tables, events and telemetry are
    /// registered here rather than by the caller. That is the whole point of the method: the tables
    /// are implementation and will change - carried peers and identity pinning already changed them
    /// once - and a consumer that had registered them by hand would be broken by that.
    /// </summary>
    public static SourceRpcBuilder AddSourceRpc(this IServiceCollection services, Action<SourceRpcOptions> configure)
    {
        services.AddOptions<SourceRpcOptions>()
            .Configure(configure)
            .Validate(options => !string.IsNullOrWhiteSpace(options.Name), "A Source RPC peer name is required: set options.Name.")
            .Validate(options => options.MaximumCarriedPeers > 0, "MaximumCarriedPeers must be greater than zero.")
            // Startup rather than first use. A plant service that cannot be addressed should fail
            // where somebody is watching, not become a peer nobody can reach for reasons that only
            // show up as other people's timeouts.
            .ValidateOnStart();

        var signalr = services.AddSignalR();
        // Read here rather than resolved, because protocol registration happens at registration
        // time and there is no options instance yet. The delegate is cheap and idempotent.
        var options = new SourceRpcOptions();
        configure(options);
        if (options.UseMessagePack)
            signalr.AddMessagePackProtocol();

        services.TryAddSingleton<RpcRouter>();
        services.TryAddSingleton<SubscriptionTable>();
        services.TryAddSingleton<SourceRpcTelemetry>();
        // One dispatcher for the process: it owns the subscription table, and two would mean two
        // halves of one answer to "who is watching this event".
        services.TryAddSingleton(provider => new RpcDispatcher(
            provider.GetRequiredService<IOptions<SourceRpcOptions>>().Value,
            provider.GetRequiredService<SubscriptionTable>(),
            provider.GetRequiredService<SourceRpcTelemetry>(),
            provider.GetService<ISourceRpcResponder>(),
            provider.GetRequiredService<ILoggerFactory>().CreateLogger<RpcDispatcher>(),
            // Optional, and their absence is meaningful rather than neutral: with no ownership
            // registered a fenced call is refused rather than run unchecked, and with no store an
            // idempotency key is carried and ignored. Both are the safe reading of "I cannot check".
            provider.GetService<IRpcOwnership>(),
            provider.GetService<IRpcIdempotencyStore>()));
        services.TryAddSingleton<ISourceRpcEvents, SourceRpcEvents>();

        return new SourceRpcBuilder(services);
    }
}

/// <summary>Mapping for a Source RPC hub.</summary>
public static class SourceRpcEndpointRouteBuilderExtensions
{
    /// <summary>
    /// Map the hub at a path. `/rpc` is the convention the TypeScript side's examples use.
    ///
    /// The hub type itself is internal, which is the point: it is where protocol handling lives and
    /// it will keep changing, so it is not something to build against.
    /// </summary>
    public static HubEndpointConventionBuilder MapSourceRpc(this IEndpointRouteBuilder endpoints, string pattern = "/rpc") =>
        endpoints.MapHub<RpcHub>(pattern);
}
