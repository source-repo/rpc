import test from 'ava'
import { digestText } from '@source-repo/rpc'
import { bindingsOf, bindingsOnLine, overlayRefusal, phaseOneCapabilities, type RpcActiveSourceIdentity, type RpcSourceCatalogue } from './Catalogue.js'

/**
 * What a viewer is allowed to draw, and what it must refuse to.
 *
 * A value beside source that is not the source that is running is worse than no value at all: it is
 * a number somebody will act on, positioned by a line that means something else. Everything here is
 * about making that impossible to do by accident.
 */

const catalogue = async (over: Partial<RpcSourceCatalogue> = {}): Promise<RpcSourceCatalogue> => ({
    catalogueVersion: 1,
    semanticRevisionId: 'rev-a',
    sourceBundleHash: 'bundle-a',
    files: [{ fileId: 'oven.ts', contentHash: await digestText('interface OvenState { setpoint: number }\n'), lines: 1 }],
    components: {
        oven: [
            { sourceRpcPath: 'state.setpoint', fileId: 'oven.ts', spans: [{ startLine: 1, startColumn: 22, endLine: 1, endColumn: 39 }], declaredType: 'number' },
            { sourceRpcPath: 'state.secret', fileId: 'oven.ts', spans: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 20 }], declaredType: 'string', sensitivity: 'credential' }
        ]
    },
    ...over
})

const identity = (over: Partial<RpcActiveSourceIdentity> = {}): RpcActiveSourceIdentity => ({
    componentType: 'oven',
    semanticRevisionId: 'rev-a',
    sourceBundleHash: 'bundle-a',
    activationEpoch: 'e1',
    ...over
})

test('a document that matches the running revision may be overlaid', async (t) => {
    const known = await catalogue()
    t.is(overlayRefusal(known, identity(), { fileId: 'oven.ts', contentHash: known.files[0].contentHash }), undefined)
})

test('an edited document never receives live overlays, and is told why', async (t) => {
    // The failure this exists to prevent: the file on screen has a line the running program does not
    // have, and a value drawn against it is positioned by a number that means something else now.
    const known = await catalogue()
    const refusal = overlayRefusal(known, identity(), { fileId: 'oven.ts', contentHash: await digestText('interface OvenState { setpoint: number; extra: boolean }\n') })
    t.regex(refusal!, /has been edited since revision/)
})

test('a catalogue describing a revision the node is not running is refused', async (t) => {
    // A redeploy while an editor is open, which is the ordinary way this happens.
    const known = await catalogue()
    const refusal = overlayRefusal(known, identity({ semanticRevisionId: 'rev-b' }), { fileId: 'oven.ts', contentHash: known.files[0].contentHash })
    t.regex(refusal!, /describes revision rev-a and oven is running rev-b/)
})

test('a file the build never saw is refused rather than assumed', async (t) => {
    const known = await catalogue()
    t.regex(overlayRefusal(known, identity(), { fileId: 'other.ts', contentHash: 'x' })!, /is not a file revision/)
})

test('a refusal is a sentence, because somebody has to be told which of these it is', async (t) => {
    // Three different problems - an edited file, a redeployed node, a file that was never part of
    // the build - and a viewer that answered "false" to all three would leave a person guessing.
    const known = await catalogue()
    const reasons = new Set([
        overlayRefusal(known, identity({ semanticRevisionId: 'rev-b' }), { fileId: 'oven.ts', contentHash: known.files[0].contentHash }),
        overlayRefusal(known, identity(), { fileId: 'oven.ts', contentHash: 'edited' }),
        overlayRefusal(known, identity(), { fileId: 'other.ts', contentHash: 'x' })
    ])
    t.is(reasons.size, 3)
})

test('what a line binds to is what a viewer asks for, per row', async (t) => {
    const known = await catalogue()
    const bindings = bindingsOf(known, 'oven')
    t.deepEqual(
        bindingsOnLine(bindings, 'oven.ts', 1).map((binding) => binding.sourceRpcPath),
        ['state.setpoint']
    )
    t.deepEqual(bindingsOnLine(bindings, 'oven.ts', 9), [])
    t.deepEqual(bindingsOf(known, 'nothing-here'), [])
})

test('a sensitive field says so beside its declaration, which is where the person who knows is', async (t) => {
    const known = await catalogue()
    const secret = bindingsOf(known, 'oven').find((binding) => binding.sourceRpcPath === 'state.secret')
    t.is(secret!.sensitivity, 'credential')
})

test('every later phase is advertised as false rather than left out', (t) => {
    // A viewer that finds `exactPause` absent cannot tell "this node cannot" from "this protocol
    // version had not thought of it". One that finds it false can.
    const capabilities = phaseOneCapabilities(true)
    t.true(capabilities.sourceLinkedProps)
    t.true(capabilities.sourceLinkedState)
    t.true(capabilities.sourceAvailable)
    for (const later of ['diagnosticVariants', 'valueProbes', 'statementHits', 'branchOutcomes', 'orderedTrace', 'tracepoints', 'safeBoundaryPause', 'exactPause', 'stepping'] as const)
        t.false(capabilities[later], later)
    t.false(phaseOneCapabilities(false).sourceAvailable, 'a node with no source root says so rather than failing when asked')
})
