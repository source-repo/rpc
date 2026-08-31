import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { rpc, rpcNamespace } from '@source-repo/rpc'
import { AspectProvider, type AspectDescriptor, type AspectLink, type AspectRef, type ContentBlock, type ObjectBinding, type ObjectDetail, type Occurrence } from '@source-repo/aspects'
import type { RpcRef } from '@source-repo/rpc'
import { defaultReaders, frontMatter, readerFor, type DocumentReader } from './Reader.js'

/**
 * A directory of documentation, served as the documentation aspect of a system.
 *
 * What a reader wants from documentation is rarely the order it was filed in, so this offers two
 * arrangements of the same documents - **by folder**, which is where they are, and **by topic**,
 * which is what they are about. A document appearing in both is one document: it has one reference,
 * and a link saved against it resolves in whichever arrangement the reader is using.
 *
 * The documents themselves are of whatever kind their format says. Markdown and plain text are
 * here; HTML, RTF and a Source View artefact are readers nobody has needed yet, and adding one
 * changes no part of this file. That separation is the correction that renamed this package: the
 * aspect is documentation, the format is a kind, and the earlier name said the format was the
 * subject.
 *
 * ## The index, and why it is one
 *
 * Built once and kept, rather than the disk walked per request. A branch must answer promptly and a
 * tree is asked for one branch at a time; walking a directory on every expansion turns a click into
 * an I/O storm, which is the fan-out the tree verb exists to avoid. `rescan()` says the disk has
 * changed, because watching a filesystem costs handles and wakes a process on every save - whether
 * that is worth it belongs to whoever deploys this.
 */

/** What the library holds about one file. Small enough for a row; the text is fetched on opening. */
export interface DocumentRecord {
    /**
     * Stable across a move, when the file says so.
     *
     * A document may declare `id:` in its front matter, and one that does keeps that id wherever it
     * is filed - which is what makes a saved link survive a reorganisation. One that does not gets
     * its path, and the honest consequence is that moving it breaks links to it. That is a property
     * of the file rather than of this code, and saying so is better than inventing a content hash:
     * two copies of the same text are two documents, and a hash would merge them.
     */
    readonly id: string
    readonly title: string
    readonly path: string
    /** The reader that answered for it: `document.markdown`, `document.text`. */
    readonly kind: string
    readonly topics: readonly string[]
    readonly words: number
    readonly modified: string
}

export interface DocumentLibraryProps extends Record<string, unknown> {
    readonly label: string
    /** Shown so a console can say which directory this is, never used to reach outside it. */
    readonly root: string
}

export interface DocumentLibraryState extends Record<string, unknown> {
    readonly documents: number
    readonly topics: number
    readonly scannedAt: string
    readonly problem?: string
}

export interface DocumentLibraryOptions {
    readonly label?: string
    /** How deep to walk. A bound, because a directory can contain a link to its own parent. */
    readonly maxDepth?: number
    /** Files past this size are indexed and refused a body, rather than read into memory. */
    readonly maxBytes?: number
    readonly maxDocuments?: number
    /** Formats this library understands. Adding one is a reader, not a change to anything here. */
    readonly readers?: readonly DocumentReader[]
    /**
     * Where these documents are also published, if they are, as a base address.
     *
     * A document in a folder and the same document on a website are one thing reachable two ways,
     * which is what a **binding** says and not what an aspect says - the published copy is not a
     * third arrangement of the library, it is another interface onto a document that already has
     * an identity here. So each document carries one when this is set, and none when it is not.
     *
     * Absent by default and deliberately so: most libraries are a folder on a disk and nothing
     * else, and inventing an address for them would publish a fact that is not true.
     */
    readonly published?: string
    /**
     * Who this library is, in the references it hands out.
     *
     * Supplied rather than discovered, because a component genuinely does not know: a peer name and
     * an instance name are assigned when it is exposed, by whoever exposes it, and a component that
     * guessed would publish references resolving to nothing.
     *
     * The default leaves the peer empty, which reads as *whoever holds this* - correct for a
     * reference that never leaves the machine, and wrong the moment one is saved somewhere else. A
     * deployment that hands references out sets this.
     */
    readonly identity?: RpcRef
}

const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENTS = 20_000

const BY_FOLDER = 'by-folder'
const BY_TOPIC = 'by-topic'

/**
 * The document a folder opens on, when it has an obvious one.
 *
 * A `README` is what a folder says about itself, and opening one costs a reader nothing they were
 * not about to do. `.md` first and then any other extension, because a folder holding both a
 * `README.md` and a `README.txt` means the Markdown one - and a folder holding only the second
 * still has something to say.
 *
 * Only by folder. A topic is a set of documents *about* something, gathered from wherever they are
 * filed, and the README of a topic is not a thing - a document called README that happened to carry
 * the right topic would be a coincidence, and opening it would look like a rule nobody wrote.
 *
 * Case-insensitive on the name and nothing else: `readme` and `README` are the same file to a
 * person and to most filesystems, while `readme-first` is a different document that would be a
 * surprising thing to open.
 */
const readmeIn = (occurrences: readonly Occurrence[]): string | undefined => {
    const named = occurrences.filter((one) => {
        const file = one.fields?.path
        if (typeof file !== 'string') return false
        const name = file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file
        return /^readme(\.[^.]+)?$/i.test(name)
    })
    const markdown = named.find((one) => String(one.fields?.path ?? '').toLowerCase().endsWith('.md'))
    return (markdown ?? named[0])?.occurrenceId
}

@rpcNamespace('documentation')
export class DocumentLibrary extends AspectProvider<DocumentLibraryProps, DocumentLibraryState> {
    private readonly root: string
    private readonly readers: readonly DocumentReader[]
    private readonly identity: RpcRef
    private readonly options: Required<Omit<DocumentLibraryOptions, 'label' | 'readers' | 'identity' | 'published'>>
    /** Absent when these documents are only a folder, which is the ordinary case. */
    private readonly published?: string
    private documents = new Map<string, DocumentRecord>()
    /** Folder path -> what is directly inside it, which is what one branch of the folder tree is. */
    private folders = new Map<string, { readonly folders: string[]; readonly documents: string[] }>()
    private topics = new Map<string, string[]>()

    constructor(root: string, options: DocumentLibraryOptions = {}) {
        const resolved = resolve(root)
        super({ label: options.label ?? basename(resolved), root: resolved }, { documents: 0, topics: 0, scannedAt: new Date(0).toISOString() })
        this.root = resolved
        this.readers = options.readers ?? defaultReaders
        this.identity = options.identity ?? { peer: '', instance: basename(resolved) }
        this.published = options.published
        this.options = {
            maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
            maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
            maxDocuments: options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS
        }
        this.rescan()
    }

    /**
     * The two arrangements of the same documents. Neither is where a document lives.
     *
     * Neither claims an `AspectSemantics` either, and that is the honest answer rather than an
     * omission: filing by folder and grouping by topic are arrangements this library offers, not
     * IEC 81346's function, product, location or type. Reaching for the nearest term would make a
     * consumer believe two providers agreed when one of them had only borrowed a word - which is
     * the exact confusion that field exists to prevent.
     */
    aspects(): readonly AspectDescriptor[] {
        return [
            {
                id: BY_FOLDER,
                label: 'By folder',
                description: 'Where the documents are filed',
                revision: String(this.state.documents),
                default: true,
                preferredPresentation: 'tree',
                // Not the kind: in a library where every row is a document, saying so on every row
                // is a column of one repeated value where a useful one could have been.
                defaultColumns: ['title', 'words', 'modified']
            },
            { id: BY_TOPIC, label: 'By topic', description: 'What the documents are about', revision: String(this.topics.size), preferredPresentation: 'tree', defaultColumns: ['title', 'path'] }
        ]
    }

    children(aspectId: string, parent: string | undefined): { occurrences: Occurrence[]; total: number; defaultChild?: string } {
        const occurrences = aspectId === BY_FOLDER ? this.folderBranch(parent) : this.topicBranch(parent)
        const opening = aspectId === BY_FOLDER ? readmeIn(occurrences) : undefined
        return { occurrences, total: occurrences.length, ...(opening ? { defaultChild: opening } : {}) }
    }

    /** Where a document appears in one arrangement. A document may be under several topics. */
    placements(target: AspectRef, aspectId: string): readonly string[] {
        const document = this.documents.get(target.id)
        if (!document) return []
        if (aspectId === BY_FOLDER) {
            const folder = document.path.includes('/') ? document.path.slice(0, document.path.lastIndexOf('/')) : ''
            return [`folder:${folder}/${document.id}`]
        }
        return document.topics.map((topic) => `topic:${topic}/${document.id}`)
    }

    /** Root first, so the resolver can tell which of two placements is nearer to where a reader is. */
    ancestorsOf(occurrenceId: string, aspectId: string): readonly string[] {
        if (aspectId === BY_TOPIC) {
            const topic = occurrenceId.startsWith('topic:') ? occurrenceId.slice('topic:'.length).split('/')[0] : undefined
            return topic ? [`topic:${topic}`, occurrenceId] : [occurrenceId]
        }
        const path = occurrenceId.startsWith('folder:') ? occurrenceId.slice('folder:'.length) : occurrenceId
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        const chain: string[] = []
        for (const segment of folder.split('/').filter(Boolean)) chain.push(`folder:${[...chain.map((entry) => entry.slice('folder:'.length)), segment].join('/')}`)
        return ['folder:', ...chain, occurrenceId]
    }

    /** One document, opened: its record and its content, in whatever blocks its format produced. */
    open(target: AspectRef): ObjectDetail | undefined {
        const document = this.documents.get(target.id)
        if (!document) return undefined
        const full = this.within(document.path)
        const stats = statSync(full, { throwIfNoEntry: false })
        if (!stats) throw new Error(`${document.path} has gone since the last scan - call rescan`)
        if (stats.size > this.options.maxBytes) throw new Error(`${document.path} is ${stats.size} bytes, past the ${this.options.maxBytes} this library serves`)
        const reader = readerFor(extname(document.path), this.readers)
        if (!reader) return undefined
        const read = reader.read(readFileSync(full, 'utf8'), basename(document.path, extname(document.path)))
        return {
            ref: target,
            kind: document.kind,
            title: document.title,
            fields: { path: document.path, topics: document.topics, words: document.words },
            origin: { system: 'documentation', externalId: document.path, updatedAt: document.modified, retrievedAt: this.state.scannedAt },
            content: read.blocks,
            links: this.linksIn(read.blocks, document),
            ...(this.publishedAt(document.path) ? { bindings: [this.publishedAt(document.path)!] } : {})
        }
    }

    /**
     * The same document, on the web, when this library knows it is there.
     *
     * `observe`, in the library's own word for what reaching it that way amounts to: a published
     * page is something to read and nothing to command. It describes and does not grant, like every
     * binding - a reader with no route to that site simply cannot follow it, and nothing here says
     * they may.
     *
     * The extension is dropped because a published site serves `guide/components.md` at
     * `guide/components`, which is the one thing this has to know about the other side.
     */
    private publishedAt(path: string): ObjectBinding | undefined {
        if (!this.published) return undefined
        const withoutExtension = path.slice(0, path.length - extname(path).length)
        const base = this.published.endsWith('/') ? this.published : `${this.published}/`
        return {
            kind: 'http.page',
            role: 'observe',
            target: { type: 'external', system: 'http', id: withoutExtension, endpoint: `${base}${withoutExtension}` }
        }
    }

    /**
     * The links a document writes, as links the system can follow.
     *
     * Only the ones that land inside this library. A Markdown link to `../reference/wire.md` names
     * a document this provider has, so it becomes a typed link to that document's *reference* - and
     * following it keeps whichever arrangement the reader is in. A link to somewhere else stays what
     * it was: ordinary text in the block, which a viewer renders and this does not touch.
     *
     * The distinction matters more than it looks. A path in prose is a fact about where a file sits
     * today; a reference survives the file being refiled. Turning one into the other where it can be
     * done, and leaving it alone where it cannot, is the whole of what this does.
     */
    private linksIn(blocks: readonly ContentBlock[], from: DocumentRecord): AspectLink[] {
        const folder = from.path.includes('/') ? from.path.slice(0, from.path.lastIndexOf('/')) : ''
        const links: AspectLink[] = []
        const seen = new Set<string>()
        for (const block of blocks) {
            if (block.kind !== 'markdown') continue
            for (const [, label, href] of block.markdown.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
                if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href) || href.startsWith('#')) continue
                const target = this.documentAt(folder, href.split('#')[0])
                if (!target || seen.has(target.id)) continue
                seen.add(target.id)
                links.push({ id: `link:${from.id}:${target.id}`, target: { provider: this.identity, resource: ['documents'], id: target.id }, label: label || target.title, relation: 'references' })
            }
        }
        return links
    }

    /** The document a relative href names, if this library has one. Never leaves the root. */
    private documentAt(folder: string, href: string): DocumentRecord | undefined {
        const parts = [...folder.split('/').filter(Boolean)]
        for (const segment of href.split('/')) {
            if (segment === '.' || segment === '') continue
            if (segment === '..') parts.pop()
            else parts.push(segment)
        }
        const path = parts.join('/')
        for (const document of this.documents.values()) if (document.path === path) return document
        return undefined
    }

    /**
     * Walk the directory again.
     *
     * A method rather than a watcher: a build step that regenerates documentation wants one call at
     * the end, and a person editing wants something else entirely.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    rescan(): number {
        const documents = new Map<string, DocumentRecord>()
        const folders = new Map<string, { folders: string[]; documents: string[] }>()
        const topics = new Map<string, string[]>()
        let problem: string | undefined

        const walk = (directory: string, depth: number) => {
            if (depth > this.options.maxDepth || documents.size >= this.options.maxDocuments) return
            const here = folders.get(this.relative(directory)) ?? { folders: [], documents: [] }
            folders.set(this.relative(directory), here)
            let entries: string[]
            try {
                entries = readdirSync(directory).sort()
            } catch (error) {
                problem = `could not read ${this.relative(directory) || '.'}: ${error instanceof Error ? error.message : String(error)}`
                return
            }
            for (const entry of entries) {
                if (entry.startsWith('.')) continue
                const full = join(directory, entry)
                const stats = statSync(full, { throwIfNoEntry: false })
                if (!stats) continue
                if (stats.isDirectory()) {
                    here.folders.push(this.relative(full))
                    walk(full, depth + 1)
                    continue
                }
                const reader = readerFor(extname(entry), this.readers)
                if (!reader) continue
                const document = this.record(full, reader, stats.size, stats.mtime)
                if (!document) continue
                documents.set(document.id, document)
                here.documents.push(document.id)
                for (const topic of document.topics) topics.set(topic, [...(topics.get(topic) ?? []), document.id])
            }
        }

        walk(this.root, 0)
        this.documents = documents
        this.folders = folders
        this.topics = topics
        // Says the structures moved, which is what a caller holding an older page compares against.
        this.structureChanged()
        this.setState({ documents: documents.size, topics: topics.size, scannedAt: new Date().toISOString(), ...(problem ? { problem } : { problem: undefined }) })
        return documents.size
    }

    /** Every topic any document declares, which is what the topic arrangement's roots are. */
    @rpc({ semantics: 'query', effect: 'observe' })
    topicNames(): readonly string[] {
        return [...this.topics.keys()].sort()
    }

    private folderBranch(parent: string | undefined): Occurrence[] {
        const path = parent === undefined ? '' : parent.slice('folder:'.length)
        const here = this.folders.get(path)
        if (!here) return []
        return [
            ...here.folders.map((folder) => ({ occurrenceId: `folder:${folder}`, title: basename(folder), kind: 'documentation.folder', hasChildren: this.folderHasChildren(folder) })),
            ...here.documents.map((id) => this.occurrenceOf(id, `folder:${path}/${id}`, 'filed-in'))
        ]
    }

    private topicBranch(parent: string | undefined): Occurrence[] {
        if (parent === undefined)
            return [...this.topics.keys()]
                .sort()
                .map((topic) => ({ occurrenceId: `topic:${topic}`, title: topic, kind: 'documentation.topic', hasChildren: (this.topics.get(topic)?.length ?? 0) > 0 }))
        const topic = parent.slice('topic:'.length)
        return (this.topics.get(topic) ?? []).map((id) => this.occurrenceOf(id, `topic:${topic}/${id}`, 'about'))
    }

    private occurrenceOf(id: string, occurrenceId: string, relation: string): Occurrence {
        const document = this.documents.get(id)!
        return {
            occurrenceId,
            ref: { provider: this.identity, resource: ['documents'], id },
            title: document.title,
            // The format, which is what makes this the documentation aspect rather than a Markdown
            // browser: a viewer sees documents, and what each one is written in.
            kind: document.kind,
            relation,
            hasChildren: false,
            fields: { path: document.path, words: document.words, modified: document.modified }
        }
    }

    private folderHasChildren(folder: string): boolean {
        const here = this.folders.get(folder)
        return !!here && (here.folders.length > 0 || here.documents.length > 0)
    }

    private record(full: string, reader: DocumentReader, size: number, modified: Date): DocumentRecord | undefined {
        const path = this.relative(full)
        if (size > this.options.maxBytes) return { id: path, title: basename(path, extname(path)), path, kind: reader.kind, topics: [], words: 0, modified: modified.toISOString() }
        let text: string
        try {
            text = readFileSync(full, 'utf8')
        } catch {
            return undefined
        }
        const read = reader.read(text, basename(path, extname(path)))
        const body = frontMatter(text).body
        return {
            id: frontMatter(text).fields.id || path,
            title: read.title || basename(path, extname(path)),
            path,
            kind: reader.kind,
            topics: read.topics,
            words: body ? body.split(/\s+/).filter(Boolean).length : 0,
            modified: modified.toISOString()
        }
    }

    /** Forward slashes whatever the platform, since an id crosses to peers that are not on it. */
    private relative(full: string): string {
        return relative(this.root, full).split(sep).join('/')
    }

    /**
     * Resolve a stored path back to a file, and refuse anything that leaves the root.
     *
     * These paths came from this class's own scan, so this should never fire - which is exactly why
     * it is here. An index is a cache, a caller supplies the id that selects from it, and the day
     * something upstream lets a `../` into one is the day this is the only thing between a
     * documentation browser and the rest of the filesystem.
     */
    private within(path: string): string {
        const full = resolve(this.root, path)
        if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`${path} is outside this library`)
        return full
    }
}
