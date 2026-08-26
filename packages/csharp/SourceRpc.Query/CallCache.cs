using ZiggyCreatures.Caching.Fusion;

namespace SourceRpc.Query;

/// <summary>One question: which peer, which instance, which method, which arguments.</summary>
/// <param name="Target">The peer, by the name it answers to. Never a connection - that is the addressing model.</param>
/// <param name="Path">The instance on that peer.</param>
/// <param name="Method">The method.</param>
/// <param name="Arguments">What it is being asked with. Encoded canonically, so two callers who built the same question differently ask it once.</param>
public sealed record RpcQuestion(string Target, string Path, string Method, object? Arguments = null);

/// <summary>
/// What identifies a question, so that two of them can be the same question.
///
/// A cache is a key and some machinery, and the machinery is not ours. The key is, because it is the
/// part that has to agree with the protocol: two callers asking a peer the same thing with the same
/// arguments are asking one question however their argument objects happened to be built, and a key
/// that said otherwise would ask the plant twice for an answer it is already holding. On the link
/// this library was written for that is not an inefficiency, it is a screen that takes twice as long
/// to draw.
/// </summary>
public static class RpcQueryKey
{
    /// <summary>Names the library, so an application's own cache entries and these cannot collide.</summary>
    public const string Root = "source-rpc";

    /// <summary>The key for one question.</summary>
    public static string For(RpcQuestion question) =>
        $"{Root}|{question.Target}|{question.Path}|{question.Method}|{RpcCanonical.Text(question.Arguments)}";

    /// <summary>
    /// Everything cached from one peer, as a tag.
    ///
    /// Tags rather than a key prefix, because a prefix scan is a scan: FusionCache expires by tag in
    /// one operation and does it across the backplane, which is what makes "this peer went away" a
    /// cheap statement rather than a walk of every entry.
    /// </summary>
    public static string PeerTag(string target) => $"{Root}:peer:{target}";

    /// <summary>Everything cached from one instance on one peer.</summary>
    public static string PathTag(string target, string path) => $"{Root}:path:{target}/{path}";
}

/// <summary>
/// Answers held, and asked for once.
///
/// **What is theirs and what is ours.** Stampede protection, storage, eviction, fail-safe, soft
/// timeouts, tagging and the backplane are FusionCache's, and none of it is interesting while all of
/// it is fiddly. What is ours is the key above, what a failure means, and the budget - the parts a
/// cache cannot know because they are facts about this protocol rather than about caching.
///
/// Two of FusionCache's features are worth naming because this repository arrived at them
/// independently before adopting them, which is the strongest reason to take a dependency:
///
/// - **Fail-safe** reuses an expired entry as a temporary fallback when the factory fails. That is
///   the rule the console's polling loop already had written down - a failure annotates the previous
///   answer rather than clearing it - because a link that dropped is not a collection that emptied,
///   and drawing it as one is a lie an operator cannot see through.
/// - **A soft timeout** answers with the stale value while the refresh continues in the background,
///   which is what a screen on a slow link wants and what a bare cache cannot express.
///
/// What is deliberately **not** here is freshness from the publisher. A page drawn at the revision a
/// component channel currently holds is *confirmed current* rather than merely recently fetched, and
/// that is unavailable in .NET until a peer here can observe a component at all - which it cannot.
/// See the README's gap list. Until then this is an age window, honestly labelled as one.
/// </summary>
public sealed class RpcCallCache
{
    private readonly IFusionCache _cache;

    /// <summary>Wrap a cache the application already has, or one built by <see cref="Create"/>.</summary>
    public RpcCallCache(IFusionCache cache) => _cache = cache;

    /// <summary>
    /// A cache with the defaults this library would choose, for an application that has no opinion.
    ///
    /// Every one of them is a judgement rather than a number pulled from the air, so each is stated:
    /// the duration is short because an age window is all there is without a publisher to ask; the
    /// fail-safe window is long because last-known-with-an-age beats a blank by a wide margin on a
    /// plant; and the soft timeout exists so a screen redraws with what it had rather than waiting
    /// out a link that has gone quiet.
    /// </summary>
    public static RpcCallCache Create(TimeSpan? duration = null) =>
        new(new FusionCache(new FusionCacheOptions
        {
            CacheName = RpcQueryKey.Root,
            DefaultEntryOptions = new FusionCacheEntryOptions
            {
                Duration = duration ?? TimeSpan.FromSeconds(5),
                IsFailSafeEnabled = true,
                FailSafeMaxDuration = TimeSpan.FromHours(1),
                FailSafeThrottleDuration = TimeSpan.FromSeconds(5),
                FactorySoftTimeout = TimeSpan.FromSeconds(1),
                // No hard timeout: the caller's budget is the deadline, and a second one here would
                // be a number nobody declared cutting off a call somebody did.
                AllowTimedOutFactoryBackgroundCompletion = true
            }
        }));

    /// <summary>The cache underneath, for an application that wants FusionCache's own surface.</summary>
    public IFusionCache Cache => _cache;

    /// <summary>
    /// Ask, or answer from what is held.
    ///
    /// Two callers asking the same question while one request is in flight get the one answer, which
    /// is stampede protection the cache does by construction and is most of why this is worth
    /// integrating rather than writing.
    ///
    /// The question is tagged by peer and by instance, so a peer going away or an instance being
    /// re-exposed can expire what came from it in one operation rather than by walking every entry.
    /// </summary>
    public ValueTask<T> GetOrAskAsync<T>(
        RpcQuestion question,
        Func<CancellationToken, Task<T>> ask,
        FusionCacheEntryOptions? options = null,
        CancellationToken cancellationToken = default) =>
        _cache.GetOrSetAsync<T>(
            RpcQueryKey.For(question),
            async (_, token) => await ask(token),
            options,
            tags: [RpcQueryKey.PeerTag(question.Target), RpcQueryKey.PathTag(question.Target, question.Path)],
            token: cancellationToken);

    /// <summary>Everything held from one peer is no longer to be believed - it went away, or came back new.</summary>
    public ValueTask ForgetPeerAsync(string target, CancellationToken cancellationToken = default) =>
        _cache.RemoveByTagAsync(RpcQueryKey.PeerTag(target), token: cancellationToken);

    /// <summary>
    /// Everything held from one instance, after a call that changed it.
    ///
    /// The narrowing a settled command wants, and it must be the caller who names the instance: a
    /// cache cannot know what a method did, and one that guessed would either re-ask everything - a
    /// round trip per entry, on the link least able to spare it - or nothing.
    /// </summary>
    public ValueTask ForgetPathAsync(string target, string path, CancellationToken cancellationToken = default) =>
        _cache.RemoveByTagAsync(RpcQueryKey.PathTag(target, path), token: cancellationToken);

    /// <summary>
    /// One question, forgotten.
    ///
    /// Named apart from <see cref="ForgetPathAsync"/> rather than overloading it, which the public
    /// API analyzer refuses and is right to: two overloads that both carry optional parameters can
    /// become ambiguous at a call site the moment either grows another one, and that is a break
    /// discovered by whoever upgrades rather than by whoever wrote it.
    /// </summary>
    public ValueTask ForgetAsync(RpcQuestion question, CancellationToken cancellationToken = default) =>
        _cache.RemoveAsync(RpcQueryKey.For(question), token: cancellationToken);
}
