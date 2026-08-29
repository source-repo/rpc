import test, { type ExecutionContext } from 'ava'
import { fileURLToPath } from 'node:url'
import { RpcWorkerHost } from '@source-repo/rpc'
import { capabilitiesFor, RpcPauseSupervisor, type RpcPauseState } from './index.js'

/**
 * Stepping: the five commands of the design's section 23, each meaning what it says there.
 *
 * All five are one predicate evaluated where the logic is, over a frame depth the entry and exit
 * probes maintain - which is why this needed no new mechanism, only the arithmetic. The fixture's
 * `heat` calls `clamp`, both with entry, statement and exit gates, so *into* has somewhere deeper to
 * go and *over* has something to run past.
 *
 * The step command reaches a **parked** thread, so it travels through shared memory rather than as a
 * message: a parked thread does not read its queue. That is why a cursor is an index into a registry
 * both sides hold rather than a name.
 */

/**
 * Serial, and not for tidiness: each of these drives one debugger session through several round
 * trips between two threads, and ten of them at once turns a deadline meant to catch *the logic
 * reached no gate* into one that catches *the machine was busy*. A debugger session is sequential;
 * the tests for one should be too.
 */
const step = test.serial

const workerModule = fileURLToPath(new URL('../../rpc/dist/RPC/fixture/ovenWorker.js', import.meta.url))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Oven {
    heat(target: number): Promise<number>
}

const stood = async (t: ExecutionContext) => {
    const host = new RpcWorkerHost({ module: workerModule, callTimeoutMs: 10_000 })
    t.teardown(async () => {
        await host.close()
    })
    const oven = await host.callable<Oven>()
    const pauses = new RpcPauseSupervisor({
        componentId: 'oven3',
        semanticRevisionId: 'rev-7',
        activationEpoch: 'epoch-1',
        gate: host.gate,
        expiryAction: 'resume',
        maxPauseMs: 10_000,
        maxWaitForPauseMs: 2_000
    })
    // Requested before the call, so the logic meets it at its very first gate rather than racing it.
    const paused = pauses.requested('heat:entry')
    const heating = oven.heat(420)
    // A test that ends without resuming leaves this rejected when the host closes, and an unhandled
    // rejection is noise that hides the assertion that actually failed.
    heating.catch(() => undefined)
    t.truthy(await paused, 'it stopped at the first gate of the handler')

    const lease = pauses.acquire('session-1', 30_000)
    if ('why' in lease) throw new Error(lease.why)
    return { host, oven, pauses, heating, lease }
}

const stepped = async (t: ExecutionContext, outcome: RpcPauseState | undefined | { readonly why: string }) => {
    if (outcome && 'why' in outcome) return t.fail(outcome.why) as never
    return outcome
}

/** Walk a script of steps and report where each one landed, which is what a viewer would draw. */
const walk = async (t: ExecutionContext, pauses: RpcPauseSupervisor, leaseId: string, script: readonly (readonly [mode: 'into' | 'over' | 'out' | 'run-to-probe', target?: number])[]) => {
    const seen: string[] = []
    for (const [mode, target] of script) {
        const outcome = await pauses.step(leaseId, mode, target)
        if (outcome && 'why' in outcome) return t.fail(outcome.why) as never
        seen.push(outcome === undefined ? 'ran on' : `${outcome.probeId}@${outcome.frameDepth}`)
    }
    return seen
}

step('step into stops at the next point there is, and goes into the frame a line calls', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    t.deepEqual(
        await walk(t, pauses, lease.leaseId, [['into'], ['into'], ['into'], ['into'], ['into']]),
        ['heat:entry@1', 'heat:1@1', 'clamp:entry@2', 'clamp:1@2', 'clamp:exit@1'],
        'statement by statement, down into clamp and back out of it'
    )

    await pauses.step(lease.leaseId, 'continue')
    t.is(await heating, 300)
})

step('step over runs the call to its end and lands on the line after it', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    t.deepEqual(
        await walk(t, pauses, lease.leaseId, [['into'], ['into'], ['over'], ['over']]),
        ['heat:entry@1', 'heat:1@1', 'heat:2@1', 'heat:exit@0'],
        'clamp ran entirely without stopping, and stepping over the last statement landed on the exit'
    )

    await pauses.step(lease.leaseId, 'continue')
    t.is(await heating, 300)
})

step('step out leaves the frame it was standing in', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    t.deepEqual(
        await walk(t, pauses, lease.leaseId, [['into'], ['into'], ['into'], ['out']]),
        ['heat:entry@1', 'heat:1@1', 'clamp:entry@2', 'clamp:exit@1'],
        'from inside clamp to the point clamp leaves, which is where that frame ends'
    )

    await pauses.step(lease.leaseId, 'continue')
    t.is(await heating, 300)
})

step('run to cursor lands on the probe it named, by index rather than by name', async (t) => {
    const { host, pauses, lease, heating } = await stood(t)

    const target = host.indexOfProbe('heat:2')
    t.is(typeof target, 'number', 'the artifact carries this probe, so there is an index for it')

    const arrived = await stepped(t, await pauses.step(lease.leaseId, 'run-to-probe', target))
    t.is(arrived?.probeId, 'heat:2', 'it ran through heat:entry, heat:1 and all of clamp, and stopped at the cursor')

    await pauses.step(lease.leaseId, 'continue')
    t.is(await heating, 300)
})

step('a cursor the artifact does not carry is refused rather than resolved to the nearest thing', async (t) => {
    const { host, pauses, lease, heating } = await stood(t)

    t.is(host.indexOfProbe('somewhere:else'), undefined)
    const refusal = await pauses.step(lease.leaseId, 'run-to-probe')
    t.true(refusal !== undefined && 'why' in refusal)
    if (refusal && 'why' in refusal) t.regex(refusal.why, /a cursor the build does not have/)

    await pauses.step(lease.leaseId, 'continue')
    t.is(await heating, 300)
})

step('continue is not a step: it runs until something else stops it', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    t.is(await pauses.step(lease.leaseId, 'continue'), undefined, 'nothing to wait for, because nothing was asked to stop')
    t.falsy(pauses.state)
    t.is(await heating, 300, 'and the handler ran to its end')
})

step('stepping needs the lease, because every step resumes a component', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    const refusal = await pauses.step('lease-that-is-not-held', 'into')
    t.true(refusal !== undefined && 'why' in refusal)
    if (refusal && 'why' in refusal) t.regex(refusal.why, /an act somebody has to be named for/)
    t.truthy(pauses.state, 'and it is still standing where it was')

    await pauses.step(lease.leaseId, 'continue')
    await heating
})

step('a step off the end of the program leaves the component running rather than paused', async (t) => {
    const { pauses, lease, heating } = await stood(t)

    // Enough steps to walk past the last gate of the handler. What is left is a component that has
    // finished, which is where a program ends rather than a failure to stop.
    let outcome: RpcPauseState | undefined | { readonly why: string } = pauses.state
    for (let taken = 0; taken < 12 && !(outcome && 'why' in outcome); taken++) {
        outcome = await pauses.step(lease.leaseId, 'into')
        if (outcome === undefined) break
    }

    t.is(await heating, 300)
    t.falsy(pauses.state, 'nothing is holding it')
})

step('a barrier cannot step, and a node says so rather than offering a control that does nothing', async (t) => {
    const barrier = new RpcPauseSupervisor({
        componentId: 'oven3',
        semanticRevisionId: 'rev-7',
        activationEpoch: 'epoch-1',
        hold: () => ({ quiescent: Promise.resolve(), waiting: () => 0, release: () => undefined }),
        expiryAction: 'resume'
    })
    t.false(barrier.canStep)

    await barrier.requested('breakpoint:1')
    const lease = barrier.acquire('session-1', 10_000)
    if ('why' in lease) return t.fail(lease.why)

    const refusal = await barrier.step(lease.leaseId, 'into')
    t.true(refusal !== undefined && 'why' in refusal)
    if (refusal && 'why' in refusal) t.regex(refusal.why, /no frame stack to step over/)
})

step('stepping is advertised from the mechanism, like everything else here', async (t) => {
    const { pauses } = await stood(t)
    t.true(pauses.canStep)

    t.true(capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true, exactPause: true, stepping: true }).stepping)
    t.false(capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true, exactPause: true }).stepping, 'a pausable runtime that keeps no frame stack can pause and not step')
    t.false(capabilitiesFor({ sourceAvailable: true, safeBoundaryPause: true }).exactPause)

    await sleep(0)
})
