import test from 'ava'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { DEFAULT_SOCKET, DockerEngine, DockerService } from './index.js'
import { DockerControl } from './Control.js'
import { DockerCreate } from './Create.js'

/**
 * Two suites in one file: what holds with no daemon at all, and what holds against a real one.
 *
 * The second half skips where Docker is not running, which is right on a laptop and wrong in CI -
 * a run that reports itself green having quietly skipped half of itself is the run somebody
 * trusts. `SOURCE_RPC_REQUIRE_DOCKER=1` turns the skip into a failure, the same guard and the same
 * reasoning as the MQTT suites in the main package.
 */

const reachable = async () => {
    try {
        await access(process.env.DOCKER_SOCKET ?? DEFAULT_SOCKET)
        await new DockerEngine({ socketPath: process.env.DOCKER_SOCKET }).version()
        return true
    } catch {
        return false
    }
}

let daemon = false
test.before(async () => {
    daemon = await reachable()
    if (!daemon && process.env.SOURCE_RPC_REQUIRE_DOCKER === '1')
        throw new Error('SOURCE_RPC_REQUIRE_DOCKER=1 but no Docker daemon answered; start one or unset it')
})

test('a host without Docker is a state, not an exception', async (t) => {
    // The ordinary case on plenty of machines, and it must not throw at whoever polled: a node
    // that cannot reach its daemon still has something true to publish about itself.
    const service = new DockerService({ socketPath: '/nonexistent/docker.sock', pollMs: 0 })
    const state = await service.refresh()

    t.false(state.reachable)
    t.regex(String(state.problem), /no Docker daemon at/)
    t.regex(String(state.problem), /is Docker running/, 'and it says what to check rather than naming an errno')
    t.is(state.total, 0)
    t.true(state.checkedAt > 0, 'the look happened, which is different from never having looked')

    service.close()
})

test('containers are a resource, and only a readable one', (t) => {
    const service = new DockerService({ pollMs: 0 })
    const [containers] = service.dataResources()

    t.deepEqual([...containers.path], ['containers'])
    t.is(containers.label, 'Containers')
    t.is(containers.row?.kind, 'object')

    // The verb list is what a viewer offers from, so this is the whole of the read-only promise as
    // far as a console is concerned: no action is declared, so no button is drawn. The other half
    // is that there is no method to call - the engine client issues GET and nothing else.
    t.deepEqual([...containers.verbs], ['getList', 'getMany'])
    t.falsy(containers.actions)

    service.close()
})

test('the counts and the list come from the same daemon', async (t) => {
    if (!daemon) {
        t.pass('no Docker daemon reachable')
        return
    }
    const service = new DockerService({ socketPath: process.env.DOCKER_SOCKET, pollMs: 0 })
    const state = await service.refresh()
    t.true(state.reachable)

    // The split this package exists to demonstrate: how many is a bounded fact and is state; which
    // ones is data and is asked for.
    const page = (await service.dataRequest('getList', ['containers'], { pagination: { page: 0, pageSize: 5 } })) as {
        ids: string[]
        total: number
        queryMs?: number
    }
    t.is(page.total, state.total, 'the resource and the state agree about how many there are')
    t.true(page.ids.length <= 5, 'and a page is a page')
    t.true((page.queryMs ?? 0) >= 0, 'with the time the daemon took, since a slow socket looks like a dead link')

    if (page.total > 0) {
        // Filtered on this node with the library's own matcher, so `state:running` means here what
        // it means over any other resource.
        const running = (await service.dataRequest('getList', ['containers'], {
            filter: { field: 'state', op: 'eq', operand: 'running' }
        })) as { total: number }
        t.is(running.total, state.running)

        const named = (await service.dataRequest('getMany', ['containers'], { ids: [page.ids[0]] })) as { ids: string[] }
        t.deepEqual([...named.ids], [page.ids[0]])
    }

    service.close()
})

test('control is closed until it is given something to manage', async (t) => {
    const control = new DockerControl({ socketPath: '/nonexistent/docker.sock' })

    // A node exposed by accident should be able to do nothing at all, and the refusal should say
    // why rather than reporting whatever the daemon would have said.
    const refused = await t.throwsAsync(control.start('anything'))
    t.regex(String(refused?.message), /no manage rules, so it controls nothing/)

    const [managed] = control.dataResources()
    t.deepEqual([...managed.verbs], ['getList', 'getMany'])
    t.deepEqual(
        managed.actions?.map((action) => action.method),
        ['start', 'stop', 'restart', 'remove']
    )
    t.true(managed.actions?.find((action) => action.method === 'remove')?.confirm, 'and the one that does not come back asks first')
})

test('a manage rule that constrains nothing is refused where it was written', (t) => {
    // The easiest allow-list mistake to make by accident, and the worst to make quietly: an empty
    // rule read as "no constraints" is read as "every container". Refused at construction rather
    // than silently matching nothing, which is equally wrong and is found much later by somebody
    // wondering why their perfectly good rule does nothing.
    const refused = t.throws(() => new DockerControl({ socketPath: '/nonexistent/docker.sock', manage: [{}] }))
    t.regex(String(refused?.message), /must name a namePrefix or a label/)
    t.regex(String(refused?.message), /would match everything/)
})

test('creating is closed until it is given an image allow-list', async (t) => {
    const create = new DockerCreate({ socketPath: '/nonexistent/docker.sock' })
    t.deepEqual(await create.allowed(), [])

    const refused = await t.throwsAsync(create.run({ image: 'alpine', name: 'x' }))
    t.regex(String(refused?.message), /no image allow-list, so it can create nothing/)
})

test('the allow-list is by repository, and a tag or digest does not slip past it', async (t) => {
    const create = new DockerCreate({ socketPath: '/nonexistent/docker.sock', images: [{ repository: 'postgres' }, { repository: 'ghcr.io/acme/*' }] })

    // Refused before the daemon is ever reached, so these say nothing about Docker being absent.
    for (const image of ['alpine', 'postgres-evil', 'ghcr.io/other/thing']) {
        const refused = await t.throwsAsync(create.run({ image, name: 'x' }))
        t.regex(String(refused?.message), /not on this node's image allow-list/, image)
    }

    // A tag and a digest are the same repository, which is what the rule is written about.
    for (const image of ['postgres:17', 'postgres@sha256:abc', 'ghcr.io/acme/anything:1']) {
        const reached = await t.throwsAsync(create.run({ image, name: 'x' }))
        t.regex(String(reached?.message), /no Docker daemon/, `${image} should have been permitted and then failed on the socket`)
    }
})

test('a container name is constrained, and the node prefixes what it makes', async (t) => {
    const create = new DockerCreate({ socketPath: '/nonexistent/docker.sock', images: [{ repository: 'postgres' }], namePrefix: 'test-' })
    t.is(create.props.namePrefix, 'test-')

    // A name is not a place to put a path or a flag. Checked before anything is sent.
    for (const name of ['../escape', 'has space', '-leading']) {
        const refused = await t.throwsAsync(create.run({ image: 'postgres', name }))
        t.regex(String(refused?.message), /not a usable container name/, name)
    }
})

/**
 * The write tiers against a real daemon.
 *
 * Everything created here is named under one prefix unique to the run and removed again, whatever
 * the outcome - a test suite that leaves containers behind on somebody's machine is a test suite
 * they stop running. Skipped without a daemon, and `SOURCE_RPC_REQUIRE_DOCKER=1` turns that skip
 * into a failure like the read half above.
 */
const LIVE_IMAGE = 'alpine'
const prefix = `srpc-test-${randomUUID().slice(0, 8)}-`

const localImage = async () => {
    try {
        await new DockerEngine({ socketPath: process.env.DOCKER_SOCKET }).inspectImage(LIVE_IMAGE)
        return true
    } catch {
        return false
    }
}

test('a created container can be controlled, and only within the fence', async (t) => {
    if (!daemon || !(await localImage())) {
        t.pass(`no daemon, or ${LIVE_IMAGE} not present locally`)
        return
    }

    const create = new DockerCreate({ socketPath: process.env.DOCKER_SOCKET, images: [{ repository: LIVE_IMAGE }], namePrefix: prefix })
    const control = new DockerControl({ socketPath: process.env.DOCKER_SOCKET, manage: [{ namePrefix: prefix }] })
    let made: string | undefined

    try {
        // Long-running so there is something to stop, and trivial so it costs nothing.
        const { name } = await create.run({ image: LIVE_IMAGE, name: 'one', args: ['sleep', '300'], labels: { purpose: 'test' } })
        made = name
        t.true(name.startsWith(prefix), 'the node prefixes what it makes, so nothing collides and everything is findable')

        // The two tiers compose without either knowing about the other: what create made is inside
        // the fence control was given, because both were pointed at the same prefix.
        const listed = (await control.dataRequest('getList', ['managed'], {})) as { ids: string[]; total: number }
        t.true(listed.ids.includes(name))
        t.is(listed.total, 1, 'and the fence is a fence - nothing else on this host is in it')

        t.is(await control.stop(name), 'ok')
        await t.notThrowsAsync(control.start(name))
        await t.notThrowsAsync(control.restart(name))

        // The whole point of the allow-list, checked against a container that really exists and is
        // really outside the fence rather than against a name nobody has.
        const outside = (await new DockerEngine({ socketPath: process.env.DOCKER_SOCKET }).containers()).find((one) => !(one.Names?.[0] ?? '').includes(prefix))
        if (outside) {
            const refused = await t.throwsAsync(control.stop((outside.Names?.[0] ?? '').replace(/^\//, '')))
            t.regex(String(refused?.message), /not a container this node manages/)
        }

        t.is(await control.remove(name), 'ok')
        made = undefined
        const after = (await control.dataRequest('getList', ['managed'], {})) as { total: number }
        t.is(after.total, 0)
    } finally {
        // Whatever happened above, nothing is left behind.
        if (made) await control.remove(made).catch(() => undefined)
    }
})

test('an image outside the allow-list is refused before the daemon is asked', async (t) => {
    if (!daemon) {
        t.pass('no Docker daemon reachable')
        return
    }
    const create = new DockerCreate({ socketPath: process.env.DOCKER_SOCKET, images: [{ repository: LIVE_IMAGE }], namePrefix: prefix })

    // `mongo` is present on this host, so a refusal here is the allow-list working rather than the
    // daemon failing to find an image - which is the distinction that makes this test worth having.
    const refused = await t.throwsAsync(create.run({ image: 'mongo', name: 'nope' }))
    t.regex(String(refused?.message), /not on this node's image allow-list/)
    t.deepEqual(await create.mine().then((names) => names.filter((name) => name.startsWith(prefix))), [], 'and nothing was made')
})
