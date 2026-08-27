#!/usr/bin/env bash
# Install the packages that were just built into a fresh project, and compile against them.
#
# Packing proves a file was produced. It does not prove the file is usable: a missing dependency,
# a target framework nobody can consume, a type left internal, an assembly that will not load - all
# of those pack perfectly and fail at whoever installs them first. The only way to find out is to
# be that person, from a clean cache, before the package reaches a registry where the version can
# never be reused.
set -euo pipefail

packages="${1:?usage: smoke-test.sh <directory of .nupkg files>}"
packages="$(cd "$packages" && pwd)"
version="${2:-}"
if [ -z "$version" ]; then
    version="$(basename "$(ls "$packages"/SourceRpc.[0-9]*.nupkg | head -1)" .nupkg)"
    version="${version#SourceRpc.}"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# A cache of its own, so a package already restored on this machine cannot stand in for the one
# just built - which is exactly how a broken package passes on the machine that produced it.
export NUGET_PACKAGES="$work/cache"

echo "smoke-testing SourceRpc $version from $packages"
cd "$work"
dotnet new console -o consumer --force >/dev/null
cd consumer
cat > nuget.config <<XML
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="built" value="$packages" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
XML

for package in SourceRpc SourceRpc.SignalR SourceRpc.Mqtt SourceRpc.SocketIo; do
    dotnet add package "$package" --version "$version" >/dev/null
    echo "  installed $package"
done

# On version lines of their own, so they cannot ride the loop above. Each version comes from the
# package that was just built, for the same reason the shared one does: reading the csproj would test
# what the repository says rather than what was actually produced.
for own in SourceRpc.Query SourceRpc.Continuity; do
    ownVersion="$(basename "$(ls "$packages"/$own.[0-9]*.nupkg | head -1)" .nupkg)"
    ownVersion="${ownVersion#$own.}"
    dotnet add package "$own" --version "$ownVersion" >/dev/null
    echo "  installed $own $ownVersion"
done

# Compiled against, not merely restored. A package can resolve and still be unusable - the types
# public, the assembly loadable and the reference actually satisfying the compiler is the claim.
cat > Program.cs <<'CS'
using SourceRpc;
using SourceRpc.Continuity;
using SourceRpc.Mqtt;
using SourceRpc.Query;
using SourceRpc.SignalR;
using SourceRpc.SocketIo;

var options = new SourceRpcOptions { Name = "smoke" };

// One of each binding, so a package that installs but cannot be constructed is caught here.
await using var mqtt = new MqttTransport(new MqttTransportOptions { BrokerUrl = "mqtt://127.0.0.1:1883" }, options);
await using var socketIo = new SocketIoClientTransport("http://127.0.0.1:3000", options);
await using var signalR = new SignalRClientTransport("http://127.0.0.1:5217/rpc", options);

// And the core surface a consumer actually writes against.
var frame = new RpcFrame { Src = "a", Tgt = "b", Kind = "call", Path = "meter", Method = "read", Body = new object?[] { 7 } };
var call = new RpcCallOptions { IdempotencyKey = "once", Timeout = TimeSpan.FromSeconds(5) };
var store = new InMemoryIdempotencyStore();

if (frame.RequiredArg<int>(0) != 7) throw new Exception("argument conversion is wrong");
if (await store.BeginAsync("k") is not RpcIdempotencyClaim.Acquired) throw new Exception("idempotency is wrong");
if (call.IdempotencyKey != "once") throw new Exception("call options are wrong");
if (mqtt.Name != "smoke" || socketIo.Name != "smoke" || signalR.Name != "smoke") throw new Exception("naming is wrong");

// The pull half, which brings dependencies of its own - so "it packed" says even less about it than
// it does about the others: a Polly or FusionCache reference that failed to travel fails here.
var budget = new RpcCallBudget(TimeSpan.FromSeconds(5));
if (budget.Remaining <= TimeSpan.Zero) throw new Exception("the budget is wrong");
if (RpcCanonical.Text(new { b = 2, a = 1 }) != """["o",[["a",["d",1]],["b",["d",2]]]]""") throw new Exception("the canonical encoder is wrong");
if (!RpcOutcomes.MayHaveRun(RpcErrorCode.UnknownOutcome)) throw new Exception("the outcome rules are wrong");

// And the cross-language half, which is the one a consumer reaches for with a file in hand: if the
// reader packed but the canonical encoder it depends on did not travel, this is where that shows.
var portable = @"{
    ""snapshotFormatVersion"": 1,
    ""snapshotId"": ""smoke"",
    ""captureKind"": ""held-state-only"",
    ""componentType"": ""oven"",
    ""componentId"": ""oven3"",
    ""sourceRevision"": ""rev-1"",
    ""stateSchemaId"": ""oven.state"",
    ""stateVersion"": 1,
    ""stateSchemaHash"": ""hash"",
    ""heldState"": { ""setpoint"": 180 },
    ""provenance"": [],
    ""capturedAt"": ""2026-08-27T09:15:00.000Z"",
    ""contentHash"": ""not-the-hash""
}";
var smoke = RpcPortableSnapshot.Read(portable);
if (smoke.ComponentId != "oven3") throw new Exception("the snapshot reader is wrong");
if (RpcSnapshots.Verify(smoke) is null) throw new Exception("a snapshot with the wrong hash verified");
if (RpcSnapshots.AdmissibleForHandoff(smoke) is null) throw new Exception("a held-state-only capture was admissible for handoff");

Console.WriteLine("SMOKE-OK");
CS

dotnet run --nologo | tee output.txt
grep -q SMOKE-OK output.txt
echo "smoke test passed"
