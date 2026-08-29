import test from 'ava'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
    admissibleForHandoff,
    authorised,
    fromPortable,
    planRestore,
    portableState,
    reconcile,
    RpcSnapshotRefused,
    sealManifest,
    sealSnapshot,
    toPortable,
    verifyManifest,
    verifyJournal,
    verifySnapshot,
    fromPortableJournal,
    replayableFrom,
    type RpcPortableJournalEntry,
    type RpcPortableSnapshot,
    type RpcRevisionManifest
} from './index.js'

/**
 * The documents both languages read.
 *
 * Committed rather than constructed, for the golden snapshots' reason: a fixture the code builds
 * agrees with whatever the code now does. What makes these different from the golden ones is that a
 * second implementation reads the same bytes, so agreeing with them is agreeing with each other.
 */
const fixture = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../conformance/fixtures/continuity/${name}`, import.meta.url)), 'utf8')) as T

const handoff = () => fixture<RpcPortableSnapshot>('mixer-handoff.json')

test('a position past 2^53 crosses as a string and comes back as the integer it was', async (t) => {
    const portable = handoff()
    // The bytes on the wire. A JSON number here would already be the wrong value by the time
    // anything read it, and there would be nothing to compare it against afterwards.
    t.is(portable.lastAppliedInputSequence, '9007199254740993')
    t.is(Number(portable.lastAppliedInputSequence), 9007199254740992, 'which is what a double makes of it, and why the field is not one')

    const snapshot = fromPortable(handoff())
    t.is(snapshot.lastAppliedInputSequence, 9007199254740993n)
    t.is(snapshot.obligations!.subscriptions[0].lastAcknowledgedSequence, 9007199254740991n)
    t.is(snapshot.obligations!.sequences[0].position, 9007199254740990n)
    // Nested, and the one a top-level walk would have missed.
    t.is(snapshot.obligations!.timers[0].periodic!.interval, 60_000n)
})

test('the committed fixture verifies to the hash it carries', async (t) => {
    // The claim the whole phase rests on, from this side. The .NET suite asks the same of the same
    // file, and two implementations that both compute a digest are not two implementations of one
    // digest until one file has been asked of both.
    const snapshot = fromPortable(handoff())
    t.is(await verifySnapshot(snapshot), undefined)
    t.is(snapshot.contentHash, 'McY0gkGLUUc6KlTfmIudWcLKdJ9nXG2S3qhO_iBMw9o')
})

test('a snapshot written out and read back is the snapshot that went in', async (t) => {
    const snapshot = fromPortable(handoff())
    const round = fromPortable(toPortable(snapshot))
    t.deepEqual(round, snapshot)
    t.is(await verifySnapshot(round), undefined, 'and it still verifies, which is what says the trip changed nothing that is hashed')
})

test('a position that arrived as a JSON number is refused rather than converted', async (t) => {
    // Converting it would launder a rounding error into an authoritative sequence position. There is
    // no way to tell here whether the value was small enough to have survived, and guessing wrong
    // means a successor that skips input or replays it.
    // Through `Number` rather than as a literal, which is both what a lenient parser would do and
    // the only way to write it: eslint's no-loss-of-precision refuses the literal, for exactly the
    // reason this test exists.
    const wrong = { ...handoff(), lastAppliedInputSequence: Number('9007199254740993') as unknown as string }
    const refusal = t.throws(() => fromPortable(wrong), { instanceOf: RpcSnapshotRefused })
    t.regex(refusal!.message, /has already been through a double/)
})

test('a held-state-only capture is not admissible in either language, and says why', async (t) => {
    const held = fromPortable(fixture<RpcPortableSnapshot>('mixer-held-state-only.json'))
    t.is(await verifySnapshot(held), undefined)
    t.regex(admissibleForHandoff(held)!, /says what the values were, not where the component had got to/)
})

test('state that clones perfectly and cannot be written down is refused, naming the path', async (t) => {
    // Phase 1's rule was that state must survive structuredClone, because a closure cannot be handed
    // to another process. This is the stronger one: a Date, a Uint8Array, a Map and a bigint all
    // clone and none of them cross a language boundary as themselves.
    // The whole sentence, not the first clause: without the Date branch this falls through to the
    // class check, whose message also begins "is a Date" - and a test that matched that would pass
    // against an implementation that had lost the rule and the advice with it.
    t.regex(portableState({ calibratedAt: new Date() })!, /is a Date: cross a language boundary as an ISO-8601 string/)
    t.regex(portableState({ signature: new Uint8Array([1, 2]) })!, /heldState\.signature is binary/)
    t.regex(portableState({ zones: new Map() })!, /is a Map, which clones and does not travel/)

    // A class instance is the general case the three above are instances of: what crosses is its
    // data, and the class is the part the far side has to rebuild from that data - possibly in a
    // language that has no such class at all.
    class Zone {
        constructor(readonly targetC: number) {}
    }
    t.regex(portableState({ main: new Zone(200) })!, /heldState\.main is a Zone: what crosses is its data/)
    t.regex(portableState({ count: 1n })!, /heldState\.count is a bigint/)
    t.regex(portableState({ ratio: Number.NaN })!, /heldState\.ratio is NaN/)
    t.regex(portableState({ rows: [{ at: new Date() }] })!, /heldState\.rows\[0\]\.at is a Date/)

    const held = { setpoint: 180, mode: 'heating', zones: [{ targetC: 200 }], operator: null }
    t.is(portableState(held), undefined)
})

test('a snapshot whose state cannot be written down refuses at the point of writing', async (t) => {
    const snapshot = await sealSnapshot({
        captureKind: 'held-state-only',
        componentType: 'oven',
        componentId: 'oven3',
        sourceRevision: 'rev-1',
        stateSchemaId: 'oven.state',
        stateVersion: 1,
        stateSchemaHash: 'hash',
        heldState: { calibratedAt: new Date('2026-01-01T00:00:00.000Z') },
        provenance: [],
        capturedAt: '2026-08-27T09:15:00.000Z'
    })
    // Rather than at the point of reading, which is a different process, possibly in a different
    // language, days later, with nothing to point at.
    const refusal = t.throws(() => toPortable(snapshot), { instanceOf: RpcSnapshotRefused })
    t.is(refusal!.path, 'heldState')
    t.regex(refusal!.message, /cannot be written down/)
})

test('a .NET manifest and a TypeScript snapshot agree about what state they are talking about', async (t) => {
    const manifest = fixture<RpcRevisionManifest>('dotnet-rev-2.manifest.json')
    const snapshot = fromPortable(handoff())
    t.is(await verifyManifest(manifest), undefined)
    t.is(manifest.artifactType, 'dotnet')
    t.is(manifest.manifestHash, 'v4cabJGjDJIqz9dHPCmZ-S52RpEkJO1A_JOv4L7jzF0')

    const agreed = reconcile(manifest, snapshot)
    t.true(agreed.agreed)
    if (!agreed.agreed) return
    t.false(agreed.migrationNeeded, 'the same schema at the same version, so there is nothing to migrate')
})

test('two revisions that claim one schema version and describe it differently are refused', async (t) => {
    const manifest = fixture<RpcRevisionManifest>('dotnet-rev-2.manifest.json')
    const snapshot = fromPortable(handoff())
    // A published version cannot be redefined, because snapshots in the field carry its hash. One of
    // these two did it anyway, and this is where that is caught rather than after a migration that
    // ran against a description of the state that was not the one it was written under.
    const drifted = { ...manifest, state: { ...manifest.state, schemaHash: 'something-else' } }
    const refused = reconcile(drifted, snapshot)
    t.false(refused.agreed)
    if (refused.agreed) return
    t.regex(refused.why, /a published version cannot be redefined, and one of these two was/)

    const older = reconcile({ ...manifest, state: { ...manifest.state, version: 1 } }, snapshot)
    t.false(older.agreed)
    if (older.agreed) return
    t.regex(older.why, /migration is forward only, and this would be a rollback/)
})

test('a manifest describes a revision and does not approve one', async (t) => {
    const manifest = fixture<RpcRevisionManifest>('dotnet-rev-2.manifest.json')
    const policy = { componentId: 'mixer1', componentType: 'mixer', approvedArtifacts: [] as string[], capabilityEnvelope: manifest.requiredCapabilities, onlineChangePermitted: true }

    // The artifact says it needs three capabilities and that it supports online change. Neither is
    // evidence: an artifact that could authorise itself by asserting its own capabilities would make
    // the whole approval path decorative.
    t.regex(authorised(manifest, policy)!, /is not among the artifacts approved for mixer1: a manifest describes a revision, it does not approve one/)

    const approved = { ...policy, approvedArtifacts: [manifest.artifactHash] }
    t.is(authorised(manifest, approved), undefined)

    t.regex(authorised(manifest, { ...approved, capabilityEnvelope: ['plant.write'] })!, /does not inherit an authority the identity never had/)
    t.regex(authorised(manifest, { ...approved, onlineChangePermitted: false })!, /deployed by a controlled restart rather than a handoff/)
})

test('a revision that does not serialise its handlers cannot be handed to, and says so', async (t) => {
    // The barrier orders work the runtime delivered. A component whose state is changed by a raw
    // timer never went through the queue, and no barrier can detect it - so a revision states which
    // side of that it is on, and the claim is checked here rather than discovered at a barrier.
    const loose = await sealManifest({
        componentType: 'mixer',
        revisionId: 'dotnet-rev-3',
        artifactType: 'dotnet',
        artifactHash: 'sha256-loose',
        contract: { id: 'mixer', version: 2, schemaHash: 'c' },
        state: { schemaId: 'mixer.state', version: 2, schemaHash: 's' },
        requiredCapabilities: [],
        onlineChange: { supported: true, serialisedHandlers: false, runtimeManagedObligations: true, quiescenceDeadlineMs: 2000 }
    })
    t.regex(
        authorised(loose, { componentId: 'mixer1', componentType: 'mixer', approvedArtifacts: ['sha256-loose'], capabilityEnvelope: [], onlineChangePermitted: true })!,
        /no barrier can establish that it is quiescent/
    )
})

test('a manifest listing the same capabilities in a different order is the same manifest', async (t) => {
    const one = await sealManifest({
        componentType: 'mixer',
        revisionId: 'r',
        artifactType: 'dotnet',
        artifactHash: 'h',
        contract: { id: 'mixer', version: 2, schemaHash: 'c' },
        state: { schemaId: 'mixer.state', version: 2, schemaHash: 's' },
        requiredCapabilities: ['b', 'a', 'c'],
        onlineChange: { supported: true, serialisedHandlers: true, runtimeManagedObligations: true, quiescenceDeadlineMs: 1 }
    })
    const other = await sealManifest({ ...one, requiredCapabilities: ['c', 'b', 'a'] })
    // Otherwise an artifact rebuilt on a machine that walked its imports differently reads as a
    // different revision, and a deployment approval stops matching the thing it approved.
    t.is(other.manifestHash, one.manifestHash)

    // And the same has to hold when *reading*, which is the cross-language case: a writer in another
    // language that emitted its capabilities in its own order produced a document this must still
    // verify. Sealing sorts, so only verification exercises the rule from this direction.
    const fromWire = fixture<RpcRevisionManifest>('dotnet-rev-2.manifest.json')
    const shuffled = { ...fromWire, requiredCapabilities: [...fromWire.requiredCapabilities].reverse() }
    t.notDeepEqual(shuffled.requiredCapabilities, fromWire.requiredCapabilities, 'the fixture has enough capabilities for the order to differ')
    t.is(await verifyManifest(shuffled), undefined)
})

test('the successor plans a restore from a snapshot it did not write', async (t) => {
    const snapshot = fromPortable(handoff())
    const plan = planRestore(
        snapshot,
        [
            { id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' },
            { id: 'stir-watchdog', resolution: 'assumed', timerPolicy: 'fire-on-activation' },
            { id: 'dispense-7', resolution: 'completed' },
            { id: 'setpoint-441', resolution: 'completed' },
            { id: 'alarms', resolution: 'reestablished', redelivery: 'at-least-once-deduplicated' },
            { id: 'batch-complete-18', resolution: 'assumed' },
            { id: 'hopper-lock', resolution: 'assumed' },
            { id: 'outbox', resolution: 'assumed' }
        ],
        { now: 2_000n }
    )
    t.true(plan.admissible)
    t.is(plan.entries.length, 8, 'every kind in the fixture, so a port that forgot one is caught here')
    t.is(plan.entries.find((entry) => entry.id === 'stir-watchdog')!.resolution, 'reestablished')
})

const journal = () => fixture<RpcPortableJournalEntry[]>('oven-journal.json')

test('the journal both languages read chains here too, to the hashes the file carries', async (t) => {
    const entries = fromPortableJournal(journal())

    t.is(entries.length, 6)
    t.is(await verifyJournal(entries), undefined)
    t.is(entries[0]!.entryHash, 'urSBtdjl45PORyyKqQGVIJs24cJ6kgC4aTcygc2MwUo')
    t.is(entries[entries.length - 1]!.entryHash, 'i0OGEM9qx9zB0-9kkX474yiMsgYQMV5iJo7V7URI0fs')
})

test('an input position past 2^53 survives the journal, and would not survive a number', (t) => {
    const inputs = fromPortableJournal(journal()).filter((entry) => entry.kind === 'input')

    t.deepEqual(
        inputs.map((entry) => entry.inputSequence),
        [9007199254740993n, 9007199254740994n, 9007199254740995n]
    )
    t.is(Number(9007199254740993n), 9007199254740992, 'which is a position that is not itself')
})

test('a journal position that arrived as a JSON number is refused rather than converted', (t) => {
    const mangled = journal().map((entry) => (entry.inputSequence ? { ...entry, inputSequence: Number(entry.inputSequence) as unknown as string } : entry))
    const refusal = t.throws(() => fromPortableJournal(mangled), { instanceOf: RpcSnapshotRefused })
    t.is((refusal as RpcSnapshotRefused).path, 'inputSequence')
    t.regex(refusal!.message, /already been through a double/)
})

test('an entry altered after it was written fails its own hash, on this side as well', async (t) => {
    const altered = journal().map((entry, index) => (index === 1 ? { ...entry, payload: { ...(entry.payload as object), params: { target: 900 } } } : entry))
    t.regex((await verifyJournal(fromPortableJournal(altered))) ?? '', /its content changed after it was written/)
})

test('both implementations work out the same replay from the same snapshot and the same journal', async (t) => {
    // The claim the fixture exists for, in its strongest form: not that each side can read the file,
    // but that each side reaches the same conclusion about what recovering forward would mean.
    const snapshot = { ...fromPortable(handoff()), componentId: 'oven3' }
    const outcome = await replayableFrom(snapshot, fromPortableJournal(journal()), 'suppress-effects')

    t.true('plan' in outcome)
    if (!('plan' in outcome)) return
    t.is(outcome.plan.fromInputSequence, 9007199254740993n)
    t.is(outcome.plan.toInputSequence, 9007199254740995n)
    t.deepEqual(
        outcome.plan.inputs.map((entry) => entry.inputSequence),
        [9007199254740994n, 9007199254740995n]
    )
})

test('and the same gap refuses on this side, for the same reason', async (t) => {
    const snapshot = { ...fromPortable(handoff()), componentId: 'oven3', lastAppliedInputSequence: 9007199254740991n }
    const outcome = await replayableFrom(snapshot, fromPortableJournal(journal()), 'suppress-effects')

    t.true('refused' in outcome)
    if ('refused' in outcome) t.regex(outcome.refused, /a fabrication rather than a recovery/)
})

test('an unknown entry kind refuses rather than being read as something else', (t) => {
    const unknown = journal().map((entry) => (entry.kind === 'obligation' ? { ...entry, kind: 'speculation' as unknown as RpcPortableJournalEntry['kind'] } : entry))
    const refusal = t.throws(() => fromPortableJournal(unknown), { instanceOf: RpcSnapshotRefused })
    t.is((refusal as RpcSnapshotRefused).path, 'kind')
})

test('a journal format from the future is refused rather than read optimistically', (t) => {
    const ahead = journal().map((entry) => ({ ...entry, journalFormatVersion: 2 }))
    const refusal = t.throws(() => fromPortableJournal(ahead), { instanceOf: RpcSnapshotRefused })
    t.is((refusal as RpcSnapshotRefused).path, 'journalFormatVersion')
})
