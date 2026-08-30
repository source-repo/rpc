import test from 'ava'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcClient, RpcServer, type RpcGetChildrenResult } from '@source-repo/rpc'
import { isRefusal, type AspectDescriptor, type AspectLocation, type AspectRef, type LinkRefusal, type ObjectDetail } from '@source-repo/aspects'
import { DocumentLibrary } from './index.js'

/**
 * A library over a directory this test builds, so nothing depends on the repository's own
 * documentation staying the shape it is today.
 *
 * The directory deliberately holds two formats. That is the distinction the package is named for:
 * the aspect is documentation, and Markdown is one kind of document rather than the subject.
 */

interface Row {
    occurrenceId: string
    id?: string
    title: string
    kind: string
    path?: string
    words?: number
}

const provider = { peer: 'docs-host', instance: 'handbook' }
const ref = (id: string): AspectRef => ({ provider, resource: ['documents'], id })

const library = () => {
    const root = mkdtempSync(join(tmpdir(), 'documentation-'))
    mkdirSync(join(root, 'guide'))
    mkdirSync(join(root, 'guide', 'deep'))
    mkdirSync(join(root, 'reference'))

    writeFileSync(
        join(root, 'guide', 'start.md'),
        ['---', 'id: getting-started', 'title: Getting started', 'topics: onboarding, guide', '---', '', '# Getting started', '', 'Two sentences of prose. Enough to count.'].join('\n')
    )
    writeFileSync(join(root, 'guide', 'deep', 'internals.md'), ['# Internals', '', 'How it actually works, at length.'].join('\n'))
    writeFileSync(join(root, 'reference', 'wire.md'), ['---', 'title: The wire format', 'topics: [reference, onboarding]', '---', '', 'Field by field.'].join('\n'))
    // Not Markdown, and still documentation: the point of the rename.
    writeFileSync(join(root, 'reference', 'changes.txt'), 'Release notes, written by somebody in a hurry.')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'hidden.md'), '# should not be indexed')

    return { root, docs: new DocumentLibrary(root, { label: 'Handbook', identity: provider }) }
}

const rows = (answer: RpcGetChildrenResult) => answer.data as Row[]
const branch = (docs: DocumentLibrary, aspect: string, parent?: string) => docs.dataRequest('getChildren', [aspect], parent === undefined ? {} : { parentId: parent })

test('documentation is the aspect, and the format is a kind', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    t.is(docs.state.documents, 4, 'three Markdown files and one text file, and not the one under a dot-directory')

    const reference = rows(branch(docs, 'by-folder', 'folder:reference'))
    t.deepEqual(reference.map((row) => row.kind).sort(), ['document.markdown', 'document.text'])
    // Both are documents in the same aspect. Nothing about the tree, the links or the wire knows
    // which reader answered - that is what makes a new format a reader rather than a change here.
    t.deepEqual(reference.map((row) => row.title).sort(), ['The wire format', 'changes'])
})

test('the two arrangements are aspects, and the folder one is the default', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const aspects = docs.aspects()
    t.deepEqual(
        aspects.map((aspect: AspectDescriptor) => aspect.id),
        ['by-folder', 'by-topic']
    )
    t.true(aspects[0].default)
    t.deepEqual(
        docs.dataResources().map((resource) => resource.path[0]),
        ['by-folder', 'by-topic'],
        'and each is published as a tree, by the base class rather than by this library'
    )
})

test('a branch is fetched on its own', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const roots = branch(docs, 'by-folder')
    t.deepEqual(
        rows(roots).map((row) => row.title),
        ['guide', 'reference']
    )
    t.deepEqual(roots.hasChildren, [true, true])

    const guide = branch(docs, 'by-folder', 'folder:guide')
    t.deepEqual(
        rows(guide).map((row) => row.title),
        ['deep', 'Getting started']
    )
    t.false(JSON.stringify(guide).includes('Internals'), 'expanding guide said nothing about what is under deep')
})

test('one document, two aspects, one reference', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const inFolder = rows(branch(docs, 'by-folder', 'folder:guide')).find((row) => row.kind === 'document.markdown')
    const inTopic = rows(branch(docs, 'by-topic', 'topic:onboarding')).find((row) => row.title === 'Getting started')

    t.is(inFolder?.id, 'getting-started')
    t.is(inTopic?.id, 'getting-started')
    t.not(inFolder?.occurrenceId, inTopic?.occurrenceId, 'two placements of one object')
})

test('following a link keeps the arrangement the reader is in', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    // Reading by topic, under `onboarding`, and following a link to the wire format - which is also
    // filed under `onboarding`. The reader should stay in the topic arrangement.
    const from: AspectLocation = { target: ref('getting-started'), aspectId: 'by-topic', occurrenceId: 'topic:onboarding/getting-started', inherited: false }
    const where = docs.follow({ id: 'l1', target: ref('reference/wire.md') }, from)

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'by-topic')
    t.is(where.occurrenceId, 'topic:onboarding/reference/wire.md')
    t.true(where.inherited)
})

test('a link to something the arrangement cannot place says so', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    // `internals.md` declares no topics, so the topic arrangement has nowhere to put it. That is
    // not a failure - it is a change of subject, and the answer says which.
    const from: AspectLocation = { target: ref('getting-started'), aspectId: 'by-topic', occurrenceId: 'topic:onboarding/getting-started', inherited: false }
    const where = docs.follow({ id: 'l2', target: ref('guide/deep/internals.md') }, from)

    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'by-folder', 'the default arrangement')
    t.is(where.fallbackUsed, 'target-default')
    t.false(where.inherited)
})

test('opening a document gives its content in blocks its format chose', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const markdown = docs.openObject(ref('getting-started'))
    t.is(markdown.kind, 'document.markdown')
    t.is(markdown.content?.[0].kind, 'markdown')
    t.regex(String((markdown.content?.[0] as { markdown: string }).markdown), /Two sentences of prose/)

    // Plain text is a `code` block, not Markdown: a text file full of asterisks would otherwise
    // render as emphasis nobody wrote.
    const text = docs.openObject(ref('reference/changes.txt'))
    t.is(text.kind, 'document.text')
    t.is(text.content?.[0].kind, 'code')
    t.regex(String((text.content?.[0] as { code: string }).code), /somebody in a hurry/)
})

test('a document with no declared id is identified by where it is', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))

    const deep = rows(branch(docs, 'by-folder', 'folder:guide/deep'))
    t.is(deep[0].id, 'guide/deep/internals.md', 'and moving it would break links to it, which is the file’s property')
    t.is(deep[0].title, 'Internals', 'the title comes from the first heading when nothing declares one')
})

test('rescan picks up a change, and the revision moves with it', (t) => {
    const { root, docs } = library()
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    const before = branch(docs, 'by-folder').revision

    writeFileSync(join(root, 'reference', 'errors.md'), ['---', 'topics: reference', '---', '', '# Error codes'].join('\n'))
    t.is(docs.state.documents, 4, 'the index is what was scanned, not what is on disk right now')

    t.is(docs.rescan(), 5)
    const after = branch(docs, 'by-folder')
    t.true(after.revision > before, 'a caller holding an older page can tell it is older')
    t.is(after.epoch, branch(docs, 'by-topic').epoch, 'and the epoch is the incarnation, which did not change')
})

test('a body past the size bound is refused rather than half-served', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'documentation-big-'))
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'huge.md'), `# Huge\n\n${'word '.repeat(400)}`)
    const docs = new DocumentLibrary(root, { maxBytes: 200, identity: provider })

    t.is(docs.state.documents, 1, 'indexed, so it can be found')
    const refused = t.throws(() => docs.openObject(ref('huge.md')))
    t.regex(String(refused?.message), /past the 200 this library serves/)
})

test('a depth bound stops a walk that would not end', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'documentation-deep-'))
    t.teardown(() => rmSync(root, { recursive: true, force: true }))
    let here = root
    for (let level = 0; level < 6; level++) {
        here = join(here, `level${level}`)
        mkdirSync(here)
        writeFileSync(join(here, 'page.md'), `# Level ${level}`)
    }

    t.is(new DocumentLibrary(root, { maxDepth: 3, identity: provider }).state.documents, 3)
})

test('a console browses both arrangements, and follows a link, over the wire', async (t) => {
    const { root, docs } = library()
    const server = new RpcServer({ name: 'docs-host', transports: [{ port: 4995, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(docs, 'handbook')
    await server.ready()
    const client = new RpcClient('http://localhost:4995', { name: 'docs-reader', defaultTarget: 'docs-host' })
    t.teardown(async () => {
        await client.close()
        await server.close()
        rmSync(root, { recursive: true, force: true })
    })

    const face = await client.proxy<{
        $data(verb: string, resource: string[], params: unknown): Promise<RpcGetChildrenResult>
        aspectList(): Promise<AspectDescriptor[]>
        openObject(target: AspectRef): Promise<ObjectDetail>
        follow(link: { id: string; target: AspectRef }, from?: AspectLocation): Promise<AspectLocation | LinkRefusal>
    }>('handbook')

    t.deepEqual((await face.aspectList()).map((aspect) => aspect.label), ['By folder', 'By topic'])

    const topics = await face.$data('getChildren', ['by-topic'], {})
    t.deepEqual(rows(topics).map((row) => row.title), ['guide', 'onboarding', 'reference'])

    const opened = await face.openObject(ref('getting-started'))
    t.is(opened.title, 'Getting started')

    const where = await face.follow(
        { id: 'l1', target: ref('reference/wire.md') },
        { target: ref('getting-started'), aspectId: 'by-topic', occurrenceId: 'topic:onboarding/getting-started', inherited: false }
    )
    t.false(isRefusal(where))
    if (isRefusal(where)) return
    t.is(where.aspectId, 'by-topic', 'context survives the wire as well as the call')
})
