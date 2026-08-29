import test from 'ava'
import { admissibleVariant, probePlanHash, sealVariantManifest, type RpcApprovedRevision } from '@source-repo/diagnostics/variant'
import { expandToRegions, instrumentSource, unionOfRegions } from './instrument.js'
import { provesDerivative, stripProbes, PROBE_RECEIVER } from './variant.js'

/**
 * Generating probes, and proving the result is still the program.
 *
 * Two kinds of test here and both are needed. The round trips hand every generated artifact to
 * `provesDerivative`, which was written first and without knowing what this would emit - a
 * transformer checked only by its own idea of correctness is a transformer that agrees with itself.
 * The others **run** the instrumented code with a recording stub in place of the probe helper,
 * because "evaluates each expression exactly once" and "preserves short-circuit behaviour" are
 * claims about execution, and no amount of comparing syntax trees tests them.
 */

const FILE = 'oven.ts'
const REVISION = 'rev-7'
const WHOLE = [{ from: 1, to: 500 }]

const source = `import { rpc } from '@source-repo/rpc'

export class Oven {
    async heat(target: number) {
        const clamped = target > 300 ? 300 : target
        if (clamped < this.ambient) {
            return this.setpoint
        }
        this.setpoint = clamped
        return clamped
    }
}
`

test('the whole containing function is the unit, not the lines somebody happens to be looking at', (t) => {
    // A viewport landing in the middle of the if, which is the case that makes line ranges useless.
    const regions = expandToRegions(source, FILE, [{ from: 6, to: 6 }])
    t.is(regions.length, 1)
    t.is(regions[0]?.label, 'heat')
    t.is(regions[0]?.span.startLine, 4, 'expanded up to the method that contains it')
})

test('two viewports over one function are one region, so scrolling does not build a plan per position', (t) => {
    const regions = unionOfRegions([...expandToRegions(source, FILE, [{ from: 5, to: 5 }]), ...expandToRegions(source, FILE, [{ from: 9, to: 9 }])])
    t.is(regions.length, 1)
})

test('a generated variant strips back to the approved program', async (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, WHOLE)
    const proof = await provesDerivative(source, instrumented.text, FILE, REVISION)

    t.true(proof.equivalent, proof.refusal?.why ?? 'the generated variant should reduce to the source it was generated from')
    t.deepEqual(
        [...new Set(instrumented.plan.map((probe) => probe.kind))].sort(),
        ['branch', 'condition', 'function-entry', 'function-exit', 'statement', 'value'],
        'and every probe kind this phase claims is actually generated'
    )
})

test('what the artifact carries is exactly what the plan names', async (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, WHOLE)
    const outcome = stripProbes(instrumented.text, FILE, REVISION)
    t.false('refusal' in outcome)
    if ('refusal' in outcome) return

    t.deepEqual(
        outcome.probes.map((probe) => probe.probeId).sort(),
        instrumented.plan.map((probe) => probe.probeId).sort(),
        'the ids in the artifact are the ids in the plan'
    )
})

test("a plan's spans are spans of the approved source, not of the file with probes in it", (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, WHOLE)
    const entry = instrumented.plan.find((probe) => probe.kind === 'value')

    t.truthy(entry)
    const line = source.split('\n')[(entry?.span.startLine ?? 1) - 1]
    t.true(line?.includes('target > 300 ? 300 : target'), 'the span points at the expression in the file the viewer is reading')
})

test('the same source produces the same plan, so a probe id does not move because a walk changed', async (t) => {
    const once = instrumentSource(source, FILE, REVISION, WHOLE)
    const again = instrumentSource(source, FILE, REVISION, WHOLE)
    t.is(await probePlanHash(once.plan), await probePlanHash(again.plan))
    t.is(once.text, again.text)
})

test('an edit above a function moves its probe ids, which is why they are not stable across revisions', (t) => {
    const shifted = instrumentSource(`// a line somebody added\n${source}`, FILE, REVISION, WHOLE)
    const original = instrumentSource(source, FILE, REVISION, WHOLE)
    t.notDeepEqual(
        shifted.plan.map((probe) => probe.probeId),
        original.plan.map((probe) => probe.probeId)
    )
})

/** The probe helper as the artifact will see it, recording every call so a test can read it back. */
const recorder = () => {
    const calls: string[] = []
    return {
        calls,
        stub: {
            entry: (id: string) => void calls.push(`entry:${id}`),
            exit: (id: string) => void calls.push(`exit:${id}`),
            statement: (id: string) => void calls.push(`statement:${id}`),
            branch: (id: string) => void calls.push(`branch:${id}`),
            value: <T>(id: string, observed: T): T => {
                calls.push(`value:${id}`)
                return observed
            },
            condition: (observedId: string, observed: boolean): boolean => {
                calls.push(`condition:${observedId}`)
                return observed
            }
        }
    }
}

/** Run a snippet before and after instrumentation and compare what the program did, not how it reads. */
const ran = (body: string, argument: unknown) => {
    const program = `function subject(input) {\n${body}\n}\n`
    const instrumented = instrumentSource(program, 'subject.js', REVISION, WHOLE)
    const stripped = instrumented.text.replace(/^import .*\n/m, '')
    const recording = recorder()
    const before = new Function(`${program}; return subject`)()(argument)
    const after = new Function(PROBE_RECEIVER, `${stripped}; return subject`)(recording.stub)(argument)
    return { before, after, calls: recording.calls, plan: instrumented.plan, unavailable: instrumented.unavailable }
}

test('a wrapped expression is evaluated exactly once, and the probe returns it unchanged', (t) => {
    const outcome = ran(
        `    let evaluations = 0
    const measure = () => { evaluations = evaluations + 1; return 7 }
    const reading = measure() + input
    return { reading, evaluations }`,
        3
    )

    t.deepEqual(outcome.before, { reading: 10, evaluations: 1 })
    t.deepEqual(outcome.after, { reading: 10, evaluations: 1 }, 'once instrumented and once not, the program did the same thing the same number of times')
})

test('short-circuit behaviour survives, because the whole condition is wrapped and never its operands', (t) => {
    const outcome = ran(
        `    let touched = false
    const right = () => { touched = true; return true }
    if (input && right()) {
        return { taken: true, touched }
    }
    return { taken: false, touched }`,
        false
    )

    t.deepEqual(outcome.before, { taken: false, touched: false })
    t.deepEqual(outcome.after, { taken: false, touched: false }, 'the right-hand side was not reached, instrumented or not')
})

test('an exception leaves by the same path, and the probes that had run are the ones that had run', (t) => {
    const program = `function subject() {\n    const bad = JSON.parse('{')\n    return bad\n}\n`
    const instrumented = instrumentSource(program, 'subject.js', REVISION, WHOLE).text.replace(/^import .*\n/m, '')
    const recording = recorder()
    const subject = new Function(PROBE_RECEIVER, `${instrumented}; return subject`)(recording.stub)

    t.throws(() => subject(), { instanceOf: SyntaxError }, 'the exception is the one the program threw, not one the instrumentation added')
    t.true(recording.calls.some((call) => call.startsWith('entry:')))
    t.false(
        recording.calls.some((call) => call.startsWith('exit:')),
        'and nothing claimed the function returned'
    )
})

test('probes fire in the order the program ran, which is what an execution overlay draws', (t) => {
    const outcome = ran(
        `    const doubled = input * 2
    if (doubled > 4) {
        return 'high'
    }
    return 'low'`,
        3
    )

    t.is(outcome.after, 'high')
    t.deepEqual(
        outcome.calls.map((call) => call.split(':')[0]),
        ['entry', 'statement', 'value', 'statement', 'condition', 'branch', 'exit'],
        'entry, the declaration and its value, the if and its condition, the branch taken, and the exit'
    )
})

test('an initialiser holding a function body is reported unavailable rather than wrapped uncertainly', (t) => {
    const outcome = ran(
        `    const compute = () => { return input + 1 }
    return compute()`,
        1
    )

    t.is(outcome.after, 2)
    t.true(
        outcome.unavailable.some((probe) => probe.kind === 'value' && /instrumented as its own region/.test(probe.why)),
        'the value probe is refused with its reason'
    )
    t.false(
        outcome.plan.some((probe) => probe.kind === 'value' && probe.displayText === 'compute'),
        'and no probe was generated around it'
    )
})

test('a single-statement branch would need braces to probe, so it is reported instead of rewritten', (t) => {
    const outcome = ran(
        `    if (input) return 'yes'
    return 'no'`,
        true
    )

    t.is(outcome.after, 'yes')
    t.true(outcome.unavailable.some((probe) => probe.kind === 'branch' && /adding braces/.test(probe.why)))
})

test('the probe budget is a bound, and reaching it is said out loud rather than truncated quietly', (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, WHOLE, { maxProbes: 3 })
    t.is(instrumented.plan.length, 3)
    t.true(instrumented.unavailable.some((probe) => /budget it was given/.test(probe.why)))
})

test('a viewport touching nothing instrumentable leaves the source exactly as it was', (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, [{ from: 1, to: 2 }])
    t.is(instrumented.text, source, 'no probes, no import, no rewrite')
    t.is(instrumented.plan.length, 0)
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

test('a generated variant is admissible on the evidence the two halves produce between them', async (t) => {
    const instrumented = instrumentSource(source, FILE, REVISION, WHOLE)
    const proof = await provesDerivative(source, instrumented.text, FILE, REVISION)
    const manifest = await sealVariantManifest({
        componentId: approved.componentId,
        semanticRevisionId: approved.semanticRevisionId,
        sourceBundleHash: approved.sourceBundleHash,
        baseArtifactHash: approved.artifactHash,
        artifactVariantId: 'oven3-diag-1',
        artifactVariantHash: 'sha256-variant-artifact',
        probePlanId: 'plan-1',
        probePlanHash: await probePlanHash(instrumented.plan),
        contractHash: approved.contractHash,
        persistentStateSchemaHash: approved.persistentStateSchemaHash,
        nonDiagnosticCapabilityHash: approved.nonDiagnosticCapabilityHash,
        diagnosticsAdapter: { language: 'typescript', adapterVersion: '0.1.0' }
    })

    const refusal = await admissibleVariant(manifest, approved, {
        baseSemanticDigest: proof.baseSemanticDigest,
        strippedSemanticDigest: proof.strippedSemanticDigest,
        plan: instrumented.plan,
        found: proof.probes.map((probe) => ({ probeId: probe.probeId, kind: probe.kind })),
        addedCapabilities: ['diagnostics.telemetry']
    })

    t.is(refusal, undefined, refusal ?? 'the generator and the verifier should agree, having been written apart')
})
