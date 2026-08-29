import test from 'ava'
import { instrumentSource } from './instrument.js'
import { provesDerivative, stripProbes, PROBE_RECEIVER } from './variant.js'

/**
 * A tracepoint captures without stopping, and its condition runs inside the component.
 *
 * That second half is the whole risk. A condition is evaluated on the component's own stack, between
 * its statements, every time the probe is reached - so a condition that could call something could
 * do the thing it was watching for, and the stripped program would still be identical, so the
 * derivative proof would pass. The grammar is the only place that catches it, which is why most of
 * these tests are conditions being refused.
 */

const FILE = 'oven.ts'
const REVISION = 'rev-7'
const WHOLE = [{ from: 1, to: 500 }]

const source = `export class Oven {
    async heat(target: number) {
        const clamped = target > 300 ? 300 : target
        this.setpoint = clamped
        return clamped
    }
}
`

const instrument = (tracepoints: Parameters<typeof instrumentSource>[4] extends infer O ? (O extends { tracepoints?: infer T } ? T : never) : never) =>
    instrumentSource(source, FILE, REVISION, WHOLE, { tracepoints })

test('a tracepoint is compiled in, and the variant still strips back to the approved program', async (t) => {
    const instrumented = instrument([{ line: 4, condition: 'clamped > 200', captureSymbols: ['clamped', 'target'], messageTemplate: 'clamped to {clamped} from {target}' }])
    const proof = await provesDerivative(source, instrumented.text, FILE, REVISION)

    t.true(proof.equivalent, proof.refusal?.why ?? 'a tracepoint is a probe, so removing it restores the program')
    t.true(instrumented.text.includes(`${PROBE_RECEIVER}.tracepoint(`))
    t.true(instrumented.text.includes('clamped > 200'), 'the condition is compiled in, where a reviewer can read it')

    const planned = instrumented.plan.find((probe) => probe.kind === 'breakpoint')
    t.is(planned?.mode, 'tracepoint')
    t.deepEqual(planned?.captureSymbols, ['clamped', 'target'])
    t.is(planned?.condition, 'clamped > 200', 'and it is on the plan, because the plan is what is approved')
})

test('the strip takes the condition and the capture with it, so neither is left in the program', (t) => {
    const instrumented = instrument([{ line: 4, condition: 'clamped > 200', captureSymbols: ['clamped'] }])
    const outcome = stripProbes(instrumented.text, FILE, REVISION)

    t.false('refusal' in outcome)
    if ('refusal' in outcome) return
    t.false(outcome.stripped.includes('clamped > 200'))
    t.false(outcome.stripped.includes(PROBE_RECEIVER))
})

test('a condition that could call something is refused, because calling is not observing', (t) => {
    const instrumented = instrument([{ line: 4, condition: 'readings.pop() > 3', captureSymbols: ['clamped'] }])

    t.is(instrumented.plan.filter((probe) => probe.kind === 'breakpoint').length, 0)
    const refusal = instrumented.unavailable.find((probe) => probe.kind === 'breakpoint')
    t.regex(refusal?.why ?? '', /may not call, assign or increment/)
})

test('a condition that assigns or increments is refused for the same reason', (t) => {
    for (const condition of ['clamped = 5', 'clamped++ > 2', 'clamped += 1']) {
        const instrumented = instrument([{ line: 4, condition, captureSymbols: ['clamped'] }])
        t.is(instrumented.plan.filter((probe) => probe.kind === 'breakpoint').length, 0, `${condition} should not compile`)
        t.truthy(instrumented.unavailable.find((probe) => probe.kind === 'breakpoint'))
    }
})

test('a condition may only speak about what the capture already names', (t) => {
    const instrumented = instrument([{ line: 4, condition: 'somethingElse > 1', captureSymbols: ['clamped'] }])
    t.regex(instrumented.unavailable.find((probe) => probe.kind === 'breakpoint')?.why ?? '', /not one of the captured locals/)
})

test('a capture list is not a way to read what is not a local of the function', (t) => {
    const instrumented = instrument([{ line: 4, captureSymbols: ['process'] }])
    t.regex(instrumented.unavailable.find((probe) => probe.kind === 'breakpoint')?.why ?? '', /not a local of this function/)
})

test('comparisons, logical operators and property access are what a condition is made of', async (t) => {
    const instrumented = instrument([{ line: 4, condition: '(clamped > 200 && target !== 0) || !clamped', captureSymbols: ['clamped', 'target'] }])
    t.is(instrumented.plan.filter((probe) => probe.kind === 'breakpoint').length, 1)
    const proof = await provesDerivative(source, instrumented.text, FILE, REVISION)
    t.true(proof.equivalent, proof.refusal?.why ?? '')
})

test('an unconditional tracepoint compiles, because true is a condition', async (t) => {
    const instrumented = instrument([{ line: 4, captureSymbols: ['clamped'] }])
    t.true(instrumented.text.includes(`${PROBE_RECEIVER}.tracepoint(`))
    const proof = await provesDerivative(source, instrumented.text, FILE, REVISION)
    t.true(proof.equivalent, proof.refusal?.why ?? '')
})
