import test from 'ava'
import { randomUUID } from 'node:crypto'
import { RpcClient, RpcServer, rpcNamespace, type RpcGetChildrenResult } from '@source-repo/rpc'
import { AspectProvider, IEC81346, isRefusal, sameAspectSemantics, type AspectDescriptor, type AspectSemantics, type AspectLink, type AspectLocation, type AspectRef, type LinkRefusal, type ObjectDetail, type Occurrence } from './index.js'

/**
 * A provider written the way a provider author would write one: three structures over the same
 * equipment, and nothing about serving a tree.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const provider = { peer: peer('plant'), instance: 'assets' }
const equipment: { [id: string]: { title: string; loop: string; room: string } } = {
    'P-101': { title: 'Feed pump', loop: 'loop-12', room: 'room-3' },
    'V-204': { title: 'Discharge valve', loop: 'loop-12', room: 'room-3' },
    'T-300': { title: 'Buffer tank', loop: 'loop-31', room: 'room-9' }
}

const ref = (id: string): AspectRef => ({ provider, resource: ['equipment'], id })

@rpcNamespace('plant')
class Plant extends AspectProvider<{ label: string }, { items: number }> {
    constructor() {
        super({ label: 'Plant' }, { items: Object.keys(equipment).length })
    }

    aspects(): readonly AspectDescriptor[] {
        return [
            { id: 'functional', label: 'By loop', revision: '1', default: true, semantics: IEC81346.function },
            { id: 'location', label: 'By room', revision: '1', semantics: IEC81346.location }
        ]
    }

    children(aspectId: string, parent: string | undefined): { occurrences: Occurrence[]; total: number } {
        const group = aspectId === 'functional' ? 'loop' : 'room'
        const prefix = aspectId === 'functional' ? 'fn' : 'loc'
        if (parent === undefined) {
            const groups = [...new Set(Object.values(equipment).map((item) => item[group]))].sort()
            const occurrences = groups.map((name) => ({ occurrenceId: `${prefix}:${name}`, title: name, kind: `plant.${group}`, hasChildren: true }))
            return { occurrences, total: occurrences.length }
        }
        const name = parent.slice(prefix.length + 1)
        const occurrences = Object.entries(equipment)
            .filter(([, item]) => item[group] === name)
            .map(([id, item]) => ({ occurrenceId: `${prefix}:${name}/${id}`, ref: ref(id), title: item.title, kind: 'plant.equipment', relation: `in-${group}`, hasChildren: false }))
        return { occurrences, total: occurrences.length }
    }

    placements(target: AspectRef, aspectId: string): readonly string[] {
        const item = equipment[target.id]
        if (!item) return []
        return aspectId === 'functional' ? [`fn:${item.loop}/${target.id}`] : [`loc:${item.room}/${target.id}`]
    }

    open(target: AspectRef): ObjectDetail | undefined {
        const item = equipment[target.id]
        if (!item) return undefined
        return {
            ref: target,
            kind: 'plant.equipment',
            title: item.title,
            origin: { system: 'plant' },
            content: [{ kind: 'markdown', id: 'note', markdown: `${item.title} stands in ${item.room}.` }]
        }
    }
}

const linked = async (t: { teardown: (fn: () => Promise<void>) => void }, port: number) => {
    const plant = new Plant()
    const server = new RpcServer({ name: peer('host'), transports: [{ port, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(plant, 'plant')
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer('ask'), defaultTarget: peer('host') })
    t.teardown(async () => {
        await client.close()
        await server.close()
    })
    return { plant, client }
}

interface Face {
    $data(verb: string, resource: string[], params: unknown): Promise<RpcGetChildrenResult>
    aspectList(): Promise<AspectDescriptor[]>
    capability(): Promise<{ aspects: number; limits: { maxPageSize: number } }>
    openObject(target: AspectRef): Promise<ObjectDetail>
    follow(link: AspectLink, from?: AspectLocation): Promise<AspectLocation | LinkRefusal>
}

test('each aspect is published as a tree resource, without the provider serving one', async (t) => {
    const plant = new Plant()
    const resources = await plant.dataResources()

    t.deepEqual(
        resources.map((resource) => resource.path[0]),
        ['functional', 'location']
    )
    t.true(resources.every((resource) => resource.shape === 'tree' && resource.verbs.includes('getChildren')))
    t.deepEqual(resources[0].label, 'By loop')
})

test('a branch answers occurrences, keyed by placement rather than by object', async (t) => {
    const plant = new Plant()
    const roots = await plant.dataRequest('getChildren', ['functional'], {})

    t.deepEqual(roots.ids, ['fn:loop-12', 'fn:loop-31'])
    t.deepEqual(roots.hasChildren, [true, true])

    const branch = await plant.dataRequest('getChildren', ['functional'], { parentId: 'fn:loop-12' })
    // The row id is the placement, because that is what a caller passes back as the next parent -
    // and because one object may be several rows, which a reference-keyed row could not express.
    t.deepEqual(branch.ids, ['fn:loop-12/P-101', 'fn:loop-12/V-204'])
    t.deepEqual(branch.hasChildren, [false, false])
    t.is((branch.data[0] as { id: string }).id, 'P-101', 'while the object reference travels beside it')
})

test('the same object is in both aspects under one reference', async (t) => {
    const plant = new Plant()
    const byLoop = await plant.dataRequest('getChildren', ['functional'], { parentId: 'fn:loop-12' })
    const byRoom = await plant.dataRequest('getChildren', ['location'], { parentId: 'loc:room-3' })

    const pumpInLoop = (byLoop.data as { id: string; occurrenceId: string }[]).find((row) => row.id === 'P-101')
    const pumpInRoom = (byRoom.data as { id: string; occurrenceId: string }[]).find((row) => row.id === 'P-101')

    t.is(pumpInLoop?.id, pumpInRoom?.id, 'one object')
    t.not(pumpInLoop?.occurrenceId, pumpInRoom?.occurrenceId, 'two placements')
})

test('a page is bounded by the provider rather than by the caller', async (t) => {
    const plant = new Plant()
    const page = await plant.dataRequest('getChildren', ['functional'], { pagination: { page: 0, pageSize: 100000 } })

    t.is(page.ids.length, 2, 'there are only two, and asking for a hundred thousand did not change that')
    t.is((await plant.capability()).limits.maxPageSize, 200)
})

test('the epoch holds across a read and the revision does not move on its own', async (t) => {
    const plant = new Plant()
    const first = await plant.dataRequest('getChildren', ['functional'], {})
    const second = await plant.dataRequest('getChildren', ['location'], {})

    t.is(first.epoch, second.epoch, 'one incarnation, so a cached page is comparable')
    t.is(first.revision, 1, 'a provider whose structures have not changed says so')
})

test('a console browses it, and follows a link, over the wire', async (t) => {
    const { client } = await linked(t, 4991)
    const face = await client.proxy<Face>('plant')

    t.is((await face.capability()).aspects, 2)
    t.deepEqual((await face.aspectList()).map((aspect) => aspect.id), ['functional', 'location'])

    const roots = await face.$data('getChildren', ['location'], {})
    t.deepEqual(roots.ids, ['loc:room-3', 'loc:room-9'])

    const opened = await face.openObject(ref('P-101'))
    t.is(opened.title, 'Feed pump')
    t.is(opened.content?.[0].kind, 'markdown')

    // Reading the plant by room, following a link to the tank: it should stay by room.
    const where = await face.follow({ id: 'l1', target: ref('T-300') }, { target: ref('P-101'), aspectId: 'location', occurrenceId: 'loc:room-3/P-101', inherited: false })
    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'location')
    t.is(where.occurrenceId, 'loc:room-9/T-300')
    t.true(where.inherited)
})

test('an object this provider does not have is refused by name', async (t) => {
    const { client } = await linked(t, 4992)
    const face = await client.proxy<Face>('plant')

    const refused = await t.throwsAsync(face.openObject(ref('nothing-like-this')))
    t.regex(String(refused?.message), /no object nothing-like-this in equipment/)
})

test('an aspect may say what it is in somebody else’s vocabulary', async (t) => {
    const plant = new Plant()
    const [functional, location] = plant.aspects()

    // The id is a local name a developer typed; the semantics are a claim about a definition
    // somebody else owns. Keeping them apart is what lets a consumer line two providers up.
    t.is(functional.id, 'functional')
    t.deepEqual(functional.semantics, { scheme: 'IEC81346', term: 'function' })
    t.deepEqual(location.semantics, IEC81346.location)
    t.true(sameAspectSemantics(functional.semantics, IEC81346.function))
    t.false(sameAspectSemantics(functional.semantics, IEC81346.product))
})

test('two providers using the same word are not thereby talking about the same aspect', async (t) => {
    // The whole reason the field is separate from the id. One of these means IEC's function aspect;
    // the other is a structure somebody happened to call the same thing.
    const conventional = { id: 'functional', label: 'By loop', revision: '1', semantics: IEC81346.function }
    const homegrown = { id: 'functional', label: 'How we group things', revision: '1' }

    t.is(conventional.id, homegrown.id)
    t.false(sameAspectSemantics(conventional.semantics, (homegrown as { semantics?: AspectSemantics }).semantics))
    // Unclaimed is never equal to anything, including another unclaimed one: saying nothing is not
    // a claim to agree, and treating it as one would defeat the point of asking.
    t.false(sameAspectSemantics(undefined, undefined))
})
