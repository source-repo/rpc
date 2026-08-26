# The public API baseline

`PublicAPI.Shipped.txt` next to each packable project is the public surface of that package, one line
per member. The analyzer compares the real surface against it and fails the build on any difference —
`RS0016` for something public that is not written down, `RS0017` for something written down that is no
longer public.

**It is a review artifact, not bookkeeping.** These are packages: a public signature that changes
without anyone noticing reaches a consumer as a compile error after they upgrade, and the first time
anybody finds out is when somebody else's build breaks. Having the surface in a committed file means
adding to it is a line in a diff that a reviewer can see, and removing from it is impossible to do by
accident.

## When the build fails on RS0016 or RS0017

Decide which happened, because the two are very different:

- **You meant to add an API.** Put the symbol the diagnostic names into `PublicAPI.Unshipped.txt`,
  copying the text between the quotes verbatim. It moves to `Shipped.txt` at the next release.
- **You meant to remove or change one.** That is a breaking change for anyone who has the package.
  It needs a major version, and the old line comes out of `Shipped.txt` as part of doing that.
- **You did not mean to expose it at all.** Make it `internal`. Most RS0016 hits are this: a helper
  that only needed to be reachable from one place and was made public because that was easiest.

## Regenerating from scratch

Only when starting a baseline over, not to make a failure go away — regenerating turns a breaking
change into a silent one, which is the thing this exists to prevent.

```
dotnet build packages/csharp/SourceRpc.sln -c Release 2>&1 | grep "error RS0016" > /tmp/rs.txt
for d in SourceRpc SourceRpc.SignalR SourceRpc.Mqtt SourceRpc.SocketIo; do
    grep -F "packages/csharp/$d/$d.csproj]" /tmp/rs.txt \
        | grep -oP "(?<=Symbol ')[^']+" >> packages/csharp/$d/PublicAPI.Shipped.txt
    sort -u -o packages/csharp/$d/PublicAPI.Shipped.txt packages/csharp/$d/PublicAPI.Shipped.txt
done
```

Run it twice: a binding cannot be analysed while the core it depends on is failing to build, so the
first pass only ever finds the core's surface.
