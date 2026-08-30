import test from 'ava'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarkdownLibrary } from './index.js'
import { RpcClient, RpcServer, type RpcGetChildrenResult, type RpcGetListResult } from '@source-repo/rpc'

/**
 * A library over a directory this test builds, so nothing here depends on the repository's own
 * documentation staying the shape it is today.
 */

interface Row {
    id: string
    title: string
    path: string
    kind: string
    topics: string[]
    words: number
}

const library = () => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-library-'))
    mkdirSync(join(root, 'guide'))
    mkdirSync(join(root, 'guide', 'deep'))
    mkdirSync(join(root, 'reference'))

    // Declares an id, so it keeps that id wherever it is filed - the property a saved link needs.
    writeFileSync(
        join(root, 'guide', 'start.md'),
        ['---', 'id: getting-started', 'title: Getting started', 'topics: onboarding, guide', '---', '', '# Getting started', '', 'Two sentences of prose. Enough to count.'].join('\n')
    )
    // Declares no id: its path is its identity, and moving it breaks links to it.
    writeFileSync(join(root, 'guide', 'deep', 'internals.md'), ['# Internals', '', 'How it actually works, at length.'].join('\n'))
    writeFileSync(join(root, 'reference', 'wire.md'), ['---', 'title: The wire format', 'topics: [reference, protocol]', '---', '', 'Field by field.'].join('\n'))
    writeFileSync(join(root, 'readme.md'), ['---', 'topics: onboarding', '---', '', '# Read me first', '', 'Start here.'].join('\n'))
    // Not Markdown, and a dot-directory: neither should appear anywhere.
    writeFileSync(join(root, 'notes.txt'), 'not markdown')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'hidden.md'), '# should not be indexed')

    return { root, docs: new MarkdownLibrary(root, { label: 'Handbook' }) }
}

const rows = (answer: RpcGetChildrenResult | RpcGetListResult) => answer.data as Row[]

test('it indexes the Markdown and leaves everything else alone', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    t.is(docs.state.documents, 4, 'four .md files, and not the .txt or the one under a dot-directory')
    t.is(docs.props.label, 'Handbook')
    t.deepEqual(docs.topicNames(), ['guide', 'onboarding', 'protocol', 'reference'])
})

test('the folder tree is fetched a branch at a time', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const roots = docs.dataRequest('getChildren', ['folders'], {}) as RpcGetChildrenResult
    t.deepEqual(
        rows(roots).map((row) => row.title),
        ['guide', 'reference', 'Read me first'],
        'folders first, then the documents directly inside the root'
    )
    t.deepEqual(roots.hasChildren, [true, true, false])

    // Expanding `guide` said nothing about what is under `guide/deep`, which is the point.
    const guide = docs.dataRequest('getChildren', ['folders'], { parentId: 'guide' }) as RpcGetChildrenResult
    t.deepEqual(
        rows(guide).map((row) => row.title),
        ['deep', 'Getting started']
    )
    t.false(JSON.stringify(guide).includes('Internals'))

    const deep = docs.dataRequest('getChildren', ['folders'], { parentId: 'guide/deep' }) as RpcGetChildrenResult
    t.deepEqual(
        rows(deep).map((row) => row.title),
        ['Internals']
    )
})

test('the same document is in two trees under one identity', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const inFolder = rows(docs.dataRequest('getChildren', ['folders'], { parentId: 'guide' }) as RpcGetChildrenResult).find((row) => row.kind === 'document')
    const inTopic = rows(docs.dataRequest('getChildren', ['topics'], { parentId: 'topic:onboarding' }) as RpcGetChildrenResult).find((row) => row.title === 'Getting started')

    // The claim the whole design rests on: structure is a projection, identity is not. Two trees,
    // two placements, one document - and a link saved against this id resolves in either.
    t.is(inFolder?.id, 'getting-started')
    t.is(inTopic?.id, 'getting-started')
    t.is(inFolder?.path, inTopic?.path)
})

test('a document appears under every topic it declares', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const topics = rows(docs.dataRequest('getChildren', ['topics'], {}) as RpcGetChildrenResult)
    t.deepEqual(
        topics.map((row) => row.title),
        ['guide', 'onboarding', 'protocol', 'reference']
    )

    const onboarding = rows(docs.dataRequest('getChildren', ['topics'], { parentId: 'topic:onboarding' }) as RpcGetChildrenResult)
    t.deepEqual(onboarding.map((row) => row.title).sort(), ['Getting started', 'Read me first'])

    const guide = rows(docs.dataRequest('getChildren', ['topics'], { parentId: 'topic:guide' }) as RpcGetChildrenResult)
    t.deepEqual(
        guide.map((row) => row.id),
        ['getting-started'],
        'the same document again, not a copy of it'
    )
})

test('a document with no declared id is identified by where it is', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const deep = rows(docs.dataRequest('getChildren', ['folders'], { parentId: 'guide/deep' }) as RpcGetChildrenResult)
    t.is(deep[0].id, 'guide/deep/internals.md', 'and the honest consequence is that moving it breaks links to it')
    t.is(deep[0].title, 'Internals', 'the title comes from the first heading when nothing declares one')
})

test('filter, sort and paging work over the flat list', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const all = docs.dataRequest('getList', ['documents'], {}) as RpcGetListResult
    t.is(all.total, 4)

    const filtered = docs.dataRequest('getList', ['documents'], { filter: { field: 'title', op: 'contains', operand: 'the wire' } }) as RpcGetListResult
    t.deepEqual(
        rows(filtered).map((row) => row.id),
        ['reference/wire.md']
    )

    const sorted = docs.dataRequest('getList', ['documents'], { sort: { field: 'title', order: 'DESC' } }) as RpcGetListResult
    t.is(rows(sorted)[0].title, 'The wire format')

    const paged = docs.dataRequest('getList', ['documents'], { pagination: { page: 1, pageSize: 2 } }) as RpcGetListResult
    t.is(rows(paged).length, 2)
    t.is(paged.total, 4, 'the total is the collection, not the page')
})

test('the body is served on request rather than in every row', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const listed = rows(docs.dataRequest('getList', ['documents'], {}) as RpcGetListResult)
    t.false(JSON.stringify(listed).includes('Two sentences'), 'a row carries what a table draws, not the document')

    const opened = docs.body('getting-started')
    t.regex(opened.markdown, /Two sentences of prose/)
    t.false(opened.markdown.startsWith('---'), 'the front matter is read, not served as part of the text')
    t.is(opened.document.title, 'Getting started')
})

test('a body past the size bound is refused rather than half-served', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-big-'))
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'huge.md'), `# Huge\n\n${'word '.repeat(400)}`)
    const docs = new MarkdownLibrary(root, { maxBytes: 200 })

    // Indexed, so it is visible and can be found - and refused a body, because half a document that
    // looks whole is worse than a refusal that names the size.
    t.is(docs.state.documents, 1)
    const refused = t.throws(() => docs.body('huge.md'))
    t.regex(String(refused?.message), /past the 200 this library serves/)
})

test('rescan picks up a change, and says when it last looked', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    const before = (docs.dataRequest('getList', ['documents'], {}) as RpcGetListResult).revision

    writeFileSync(join(root, 'reference', 'errors.md'), ['---', 'topics: reference', '---', '', '# Error codes'].join('\n'))
    t.is(docs.state.documents, 4, 'the index is what was scanned, not what is on disk right now')

    t.is(docs.rescan(), 5)
    t.is(docs.state.documents, 5)
    // The revision moves and the epoch does not: this library looked again, it did not restart.
    const after = docs.dataRequest('getList', ['documents'], {}) as RpcGetListResult
    t.true(after.revision > before, 'a caller holding an older page can tell it is older')
    t.is(after.epoch, (docs.dataRequest('getList', ['documents'], {}) as RpcGetListResult).epoch)
    const reference = rows(docs.dataRequest('getChildren', ['topics'], { parentId: 'topic:reference' }) as RpcGetChildrenResult)
    t.deepEqual(reference.map((row) => row.title).sort(), ['Error codes', 'The wire format'])
})

test('a depth bound stops a walk that would not end', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'markdown-deep-'))
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    let here = root
    for (let level = 0; level < 6; level++) {
        here = join(here, `level${level}`)
        mkdirSync(here)
        writeFileSync(join(here, 'page.md'), `# Level ${level}`)
    }
    const docs = new MarkdownLibrary(root, { maxDepth: 3 })

    t.is(docs.state.documents, 3, 'three levels walked, and the rest left where they are')
})

test('a document that has gone since the scan says so instead of throwing something opaque', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    rmSync(join(root, 'reference', 'wire.md'))
    const gone = t.throws(() => docs.body('reference/wire.md'))
    t.regex(String(gone?.message), /has gone since the last scan - call rescan/)
})

test('the resources describe two trees and a list, with columns to open on', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const resources = docs.dataResources()
    t.deepEqual(
        resources.map((resource) => resource.path[0]),
        ['folders', 'topics', 'documents']
    )
    t.deepEqual(
        resources.filter((resource) => resource.shape === 'tree').map((resource) => resource.label),
        ['By folder', 'By topic'],
        'two structures over the same documents, each saying what it is'
    )
    t.deepEqual(resources[0].verbs, ['getChildren'])
    t.deepEqual(resources[2].verbs, ['getList'])
    t.deepEqual(resources[0].presentation?.defaultColumns, ['title', 'words', 'modified'])
    for (const resource of resources) t.truthy(resource.row, 'the possible columns still come from the row type')
})

test('a console browses it over the wire, knowing nothing about Markdown', async (t) => {
    const { root, docs } = library()
    const server = new RpcServer({ name: 'handbook-host', transports: [{ port: 4981, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(docs, 'handbook')
    await server.ready()
    const client = new RpcClient('http://localhost:4981', { name: 'handbook-reader', defaultTarget: 'handbook-host' })
    t.teardown(async () => {
        await client.close()
        await server.close()
        rmSync(root, { recursive: true, force: true })
    })

    // Nothing below is Markdown-aware. This is the generic `$data` surface a console already draws
    // a queue or a database table with, which is the point of serving documents this way at all.
    const face = await client.proxy<{
        $data(verb: string, resource: string[], params: unknown): Promise<RpcGetChildrenResult>
        body(id: string): Promise<{ document: { title: string }; markdown: string }>
    }>('handbook')

    const roots = await face.$data('getChildren', ['folders'], {})
    t.deepEqual(roots.hasChildren, [true, true, false])

    const topic = await face.$data('getChildren', ['topics'], { parentId: 'topic:onboarding' })
    t.is(topic.total, 2)

    const opened = await face.body('getting-started')
    t.is(opened.document.title, 'Getting started')
    t.regex(opened.markdown, /Two sentences/)

    const described = await (await client.proxy<{ describe(): Promise<{ namespaces: { name: string; component?: { resources?: { path: string[]; shape?: string }[] } }[] }> }>('msgrpc')).describe()
    const resources = described.namespaces.find((namespace) => namespace.name === 'handbook')?.component?.resources
    t.deepEqual(
        resources?.filter((resource) => resource.shape === 'tree').map((resource) => resource.path[0]),
        ['folders', 'topics'],
        'a viewer discovers both structures without being told they exist'
    )
})
