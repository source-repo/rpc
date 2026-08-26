using System.Security.Claims;
using SourceRpc;

namespace SourceRpc.Tests;

/// <summary>
/// May you, as distinct from are you really.
///
/// Pinning a name to an authenticated identity says the name is not a lie. It says nothing about
/// what the holder may do with it - and nothing at all when the connection never authenticated,
/// which is why "pinning is on" and "authentication is required" had to stop being one setting.
/// </summary>
public class AuthorizationTests
{
    private sealed class Responder : ISourceRpcResponder
    {
        public ValueTask<object?> InvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<object?>("ran");
    }

    private sealed class Policy(
        Func<RpcInvocation, bool>? invoke = null,
        Func<string, string, bool>? subscribe = null) : ISourceRpcAuthorization
    {
        public ValueTask<bool> CanAnnounceAsync(ClaimsPrincipal? principal, string peer, CancellationToken cancellationToken = default) => new(true);
        public ValueTask<bool> CanCarryAsync(ClaimsPrincipal? principal, string bridge, string carried, CancellationToken cancellationToken = default) => new(true);
        public ValueTask<bool> CanInvokeAsync(RpcInvocation invocation, CancellationToken cancellationToken = default) => new(invoke?.Invoke(invocation) ?? true);
        public ValueTask<bool> CanSubscribeAsync(string caller, ClaimsPrincipal? principal, string path, string eventName, CancellationToken cancellationToken = default) =>
            new(subscribe?.Invoke(path, eventName) ?? true);
    }

    private static RpcDispatcher Dispatcher(ISourceRpcAuthorization policy) =>
        new(new SourceRpcOptions { Name = "plant" }, new SubscriptionTable(), new SourceRpcTelemetry(), new Responder(), null, null, null, policy);

    private static RpcCaller Caller() => new("hmi", null, CancellationToken.None, _ => Task.CompletedTask);

    [Fact]
    public async Task A_caller_the_policy_refuses_does_not_reach_the_method()
    {
        var dispatcher = Dispatcher(new Policy(invoke: call => call.Method != "open"));

        var allowed = await dispatcher.HandleAsync(
            new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "call", Corr = "c-1", Path = "valve", Method = "read", Body = Array.Empty<object?>() },
            Caller());
        Assert.Equal("result", allowed!.Kind);

        var refused = await dispatcher.HandleAsync(
            new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "call", Corr = "c-2", Path = "valve", Method = "open", Body = Array.Empty<object?>() },
            Caller());
        Assert.Equal("error", refused!.Kind);
        Assert.Equal(nameof(RpcErrorCode.Forbidden), refused.Code);
    }

    /// <summary>
    /// Events are authorised separately, because a write-protected method and a readable event
    /// stream from the same instance can carry the same production data.
    /// </summary>
    [Fact]
    public async Task A_subscription_can_be_refused_even_where_calls_are_allowed()
    {
        var dispatcher = Dispatcher(new Policy(subscribe: (path, _) => path != "recipe"));

        var allowed = await dispatcher.HandleAsync(
            new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "subscribe", Corr = "s-1", Path = "meter", Body = new object?[] { "tick" } },
            Caller());
        Assert.Equal("result", allowed!.Kind);

        var refused = await dispatcher.HandleAsync(
            new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "subscribe", Corr = "s-2", Path = "recipe", Body = new object?[] { "changed" } },
            Caller());
        Assert.Equal(nameof(RpcErrorCode.Forbidden), refused!.Code);
    }

    [Fact]
    public async Task With_no_policy_configured_everything_is_permitted_as_before()
    {
        var dispatcher = new RpcDispatcher(new SourceRpcOptions { Name = "plant" }, new SubscriptionTable(), new SourceRpcTelemetry(), new Responder());
        var answer = await dispatcher.HandleAsync(
            new RpcFrame { Src = "hmi", Tgt = "plant", Kind = "call", Corr = "c-1", Path = "valve", Method = "open", Body = Array.Empty<object?>() },
            Caller());
        Assert.Equal("result", answer!.Kind);
    }
}
