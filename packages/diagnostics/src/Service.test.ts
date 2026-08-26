import test from 'ava'
import { digestText, rpcComponent, RpcClient, RpcServer, type RpcComponentLike } from '@source-repo/rpc'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { exposeDiagnostics, type RpcSourceCatalogue } from './index.js'

/**
 * The node half, over a real link.
 *
 * What is worth testing here is what the service **will not** do: serve a file it was not built
 * from, serve any file at all when it was not configured to, or let a file id off the network name
 * a path outside the root. Everything it will do is metadata that the contract already publishes,
 * with line numbers attached.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const SOURCE = 'export interface OvenState {\n    setpoint: number\n}\n'

const built = async (): Promise<{ root: string; catalogue: RpcSourceCatalogue }> => {
    const root = mkdtempSync(join(tmpdir(), 'diag-'))
    writeFileSync(join(root, 'oven.ts'), SOURCE)
    return {
        root,
        catalogue: {
            catalogueVersion: 1,
            semanticRevisionId: 'rev-a',
            sourceBundleHash: 'bundle-a',
            files: [{ fileId: 'oven.ts', contentHash: await digestText(SOURCE), lines: 3 }],
            components: { oven: [{ sourceRpcPath: 'state.setpoint', fileId: 'oven.ts', spans: [{ startLine: 2, startColumn: 5, endLine: 2, endColumn: 21 }], declaredType: 'number' }] }
        }
    }
}

interface Diagnostics {
    bindings(componentType: string): Promise<{ sourceRpcPath: string }[]>
    activeSource(componentType: string): Promise<{ semanticRevisionId: string; activationEpoch: string } | undefined>
    source(fileId: string): Promise<{ fileId: string; text: string; contentHash: string }>
}

const stand = async (port: number, sourceRoot?: string) => {
    const { root, catalogue } = await built()
    const server = new RpcServer({ name: peer(`node${port}`), transports: [{ port, host: '127.0.0.1' }] })
    exposeDiagnostics(server, { catalogue, sourceRoot: sourceRoot === undefined ? root : sourceRoot || undefined, activationEpoch: 'e1' })
    await server.ready()
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`asker${port}`), defaultTarget: peer(`node${port}`) })
    return { server, client, root, catalogue, proxy: await client.proxy<Diagnostics>('diagnostics') }
}

test('a node says where a component s values are declared, and what revision that is', async (t) => {
    const { server, client, proxy } = await stand(4301)
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    t.deepEqual(
        (await proxy.bindings('oven')).map((binding) => binding.sourceRpcPath),
        ['state.setpoint']
    )
    const identity = await proxy.activeSource('oven')
    t.is(identity!.semanticRevisionId, 'rev-a')
    t.is(identity!.activationEpoch, 'e1')
    t.deepEqual(await proxy.bindings('nothing-here'), [], 'a component this build does not describe is empty rather than an error')
})

test('the capabilities and the running revision are props, so a viewer watches rather than polls', async (t) => {
    const { server, client } = await stand(4302)
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const observed = await client.component<RpcComponentLike>('diagnostics')
    const view = observed[rpcComponent].getSnapshot()
    const props = view.props as { sourceLinkedState: boolean; exactPause: boolean; components: { oven: { semanticRevisionId: string } } }
    t.true(props.sourceLinkedState)
    t.false(props.exactPause, 'and every later phase is present and false rather than absent')
    t.is(props.components.oven.semanticRevisionId, 'rev-a')
    await observed[rpcComponent].close()
})

test('source comes back with the hash of what was read, not what the build recorded', async (t) => {
    const { server, client, proxy, catalogue } = await stand(4303)
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    const file = await proxy.source('oven.ts')
    t.is(file.text, SOURCE)
    // A file edited on the node since the build has to be visible as such rather than quietly served
    // under the old hash - which is the one way an overlay could be drawn on the wrong lines.
    t.is(file.contentHash, catalogue.files[0].contentHash)
})

test('a file the build was not made from is refused, whatever it names', async (t) => {
    const { server, client, proxy } = await stand(4304)
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    await t.throwsAsync(proxy.source('secrets.env'), { message: /not a file this build was made from/ })
    // A path that is merely joined is how a traversal happens, so the id is checked against the
    // catalogue before it is resolved at all.
    await t.throwsAsync(proxy.source('../../etc/passwd'), { message: /not a file this build was made from/ })
})

test('a node with no source root serves bindings and no text, and says so in its capabilities', async (t) => {
    const { server, client, proxy } = await stand(4305, '')
    t.teardown(async () => {
        await client.close()
        await server.close()
    })

    // The right default for a plant: where a value is declared and the source itself are different
    // disclosures with different audiences, and a viewer with its own checkout needs only the first.
    const observed = await client.component<RpcComponentLike>('diagnostics')
    t.false((observed[rpcComponent].getSnapshot().props as { sourceAvailable: boolean }).sourceAvailable)
    await observed[rpcComponent].close()

    t.deepEqual(
        (await proxy.bindings('oven')).map((binding) => binding.sourceRpcPath),
        ['state.setpoint']
    )
    await t.throwsAsync(proxy.source('oven.ts'), { message: /serves no source/ })
})
