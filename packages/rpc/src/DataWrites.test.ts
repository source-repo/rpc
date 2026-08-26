import test from 'ava'
import { permittedResources, RPC_STAMP_VERSION, rowStamp, stampInput, validateWritePermissions } from './RPC/DataWrites.js'

/**
 * The words a store-backed node writes with, pinned.
 *
 * Two things are asserted here and nowhere else. **The permission document is a security artifact**,
 * so every shape it can be malformed in has to be refused loudly rather than read as granting
 * nothing - the judgement `validateAiGrants` already made, applied to the other document a
 * deployment writes by hand.
 *
 * And **the stamp's encoding is a promise**. `packages/conformance` asserts that every backend
 * digests the same *values*, which is what makes a mixed site coherent; it cannot assert that the
 * digest itself is stable, because both sides of that comparison call this same function. So the
 * literals below are the encoding's own fixture: change how a stamp is computed and these change,
 * visibly, in a diff - which is the whole reason `RPC_STAMP_VERSION` rides inside the input rather
 * than beside it.
 *
 * Since the encoder moved to `Canonical.ts` those literals gate more than the stamp. The projection
 * comparison and the `$data` cache key are the same function, and neither can pin itself: two
 * projections compare through it and two keys are built by it, so a change to the encoding leaves
 * both self-consistent and both wrong. These are the only fixtures in the repository that fail when
 * it moves, which is why they are worth the awkwardness of being opaque strings.
 */

const CUSTOMER_ONE = [
    ['name', 'Acme Ltd'],
    ['city', 'Berlin'],
    ['active', true],
    ['balance', 12.5]
] as const

test('a stamp is the same digest wherever the same row is read', async (t) => {
    t.is(await rowStamp('customers', '1', CUSTOMER_ONE), '6Rb9EMenemRPURBGYZQddL7MLFODcmTBPcVHyKiji6E')
    t.is(
        await rowStamp('customers', '2', [
            ['name', 'borg'],
            ['city', null],
            ['active', false],
            ['balance', 3.0]
        ]),
        'sFoL-4qBfxfPcpkUqIPDogJCRGos29K4LDVqSKNxEHQ'
    )
    t.is(await rowStamp('sites', 'north', [['label', 'North plant']]), 'Jo1RxtofbqMxYqpqK4aqconmVapYRVs5UPyL4E3BOuw')
})

test('the field order a store happened to iterate in does not change the stamp', async (t) => {
    // Two stores describing the same table are free to hand back their columns in different orders,
    // and a digest that depended on it would report a conflict on a row nobody touched - which is a
    // precondition that fails at random, and the first thing anybody does with one of those is stop
    // sending it.
    t.is(
        await rowStamp('customers', '1', [
            ['city', 'Berlin'],
            ['name', 'Acme Ltd'],
            ['balance', 12.5],
            ['active', true]
        ]),
        await rowStamp('customers', '1', CUSTOMER_ONE)
    )
})

test('the key order inside a JSON value does not change the stamp either', async (t) => {
    // The same argument one level down, and the case that actually bites: a JSON column round-trips
    // through a driver and a document store hands back BSON, neither of which promises key order
    // between two reads.
    t.is(await rowStamp('t', '1', [['note', { b: 2, a: 1 }]]), await rowStamp('t', '1', [['note', { a: 1, b: 2 }]]))
})

test('a stamp names one row of one resource', async (t) => {
    const one = await rowStamp('customers', '1', CUSTOMER_ONE)
    t.not(one, await rowStamp('customers', '2', CUSTOMER_ONE), 'the id is inside the digest')
    t.not(one, await rowStamp('orders', '1', CUSTOMER_ONE), 'and so is the resource')
})

test('a value is tagged by kind, so a type change is a change', async (t) => {
    // `1` and `'1'` are different states of a field, and a digest that could not tell them apart
    // would report no conflict across exactly the change most likely to break something downstream.
    t.not(await rowStamp('t', '1', [['v', 1]]), await rowStamp('t', '1', [['v', '1']]))
    t.not(await rowStamp('t', '1', [['v', true]]), await rowStamp('t', '1', [['v', 1]]))
    t.not(await rowStamp('t', '1', [['v', null]]), await rowStamp('t', '1', [['v', '']]))
    t.not(await rowStamp('t', '1', [['v', new Date(0)]]), await rowStamp('t', '1', [['v', new Date(0).toISOString()]]))
    // Absent and null are the same state to a stamp, which is the one place they are: a field a
    // store did not return and a field it returned as null are both "no value here", and every
    // backend spells that differently.
    t.is(await rowStamp('t', '1', [['v', undefined]]), await rowStamp('t', '1', [['v', null]]))
})

test('the digest input carries its own version, so an old stamp cannot match a new rule', (t) => {
    const input = stampInput('customers', '1', [
        ['name', 'Acme Ltd'],
        ['city', 'Berlin']
    ])
    t.is(input, `["${RPC_STAMP_VERSION}","customers","1",[["city",["s","Berlin"]],["name",["s","Acme Ltd"]]]]`)
})

test('a permission document is checked, and every way of being wrong is refused', (t) => {
    t.notThrows(() => validateWritePermissions({}), 'a document permitting nothing is a legitimate thing to write')
    t.notThrows(() => validateWritePermissions({ orders: { verbs: ['delete'] } }), 'a rule that only removes needs no field list')

    t.throws(() => validateWritePermissions([] as never), { message: /expected an object mapping a resource name/ })
    t.throws(() => validateWritePermissions({ orders: null } as never), { message: /expected \{ verbs, columns \}/ })
    t.throws(() => validateWritePermissions({ orders: { verbs: [] } } as never), { message: /at least one of create, update, delete/ })
    t.throws(() => validateWritePermissions({ orders: { verbs: ['drop'] } } as never), { message: /not a verb this library defines/ })
    // Absent would read as "every field" to whoever wrote it, which is the one reading a permission
    // document must never have.
    t.throws(() => validateWritePermissions({ orders: { verbs: ['update'] } } as never), { message: /columns: required/ })
    t.throws(() => validateWritePermissions({ orders: { verbs: ['delete'], columns: ['total'] } } as never), { message: /only create and update write fields/ })
    t.throws(() => validateWritePermissions({ orders: { verbs: ['update'], columns: [] } } as never), { message: /a non-empty list of field names/ })
    // Refused rather than deduplicated: a name written twice is a document somebody edited without
    // reading, and the next thing in it may be wrong in a way this cannot see.
    t.throws(() => validateWritePermissions({ orders: { verbs: ['update'], columns: ['total', 'total'] } } as never), { message: /'total' is listed twice/ })
    t.throws(() => validateWritePermissions({ '': { verbs: ['delete'] } } as never), { message: /a resource name cannot be empty/ })
})

test('the message names the caller, because two packages check the same shape', (t) => {
    t.throws(() => validateWritePermissions({ orders: { verbs: [] } } as never, 'documents'), { message: /^documents\.orders\.verbs/ })
})

test('what a document asks for is answerable without a store', (t) => {
    // The other half of diagnosing a table that cannot be edited: what the operator asked for,
    // beside what the node resolved. The two differing is exactly what a refusal explains.
    t.deepEqual(permittedResources({ sites: { verbs: ['update'], columns: ['label'] }, customers: { verbs: ['delete'] } }), ['customers', 'sites'])
    t.deepEqual(permittedResources(undefined), [])
})
