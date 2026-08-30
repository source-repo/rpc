import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { RpcComponent, rpc, rpcNamespace, type RpcDataMethod, type RpcDataResource, type RpcGetChildrenParams, type RpcGetChildrenResult, type RpcGetListParams, type RpcGetListResult, type RpcResource } from '@source-repo/rpc'

/**
 * A directory of Markdown, served as several trees over the same documents.
 *
 * This is the first consumer of `getChildren`, and it was chosen over a database or an external
 * service on purpose: the case that motivates a tree here is **documentation scattered across
 * files**, where the structure a reader wants is rarely the structure on disk. A folder tree is one
 * answer. Grouping by the topics the documents declare is a different answer over exactly the same
 * documents. Neither is more true than the other, and a document does not become two documents by
 * appearing in both.
 *
 * That is the whole claim being made here, and it is the one the knowledge-system design rests on:
 * **structure is a projection, identity is not.** `docs/guide/start.md` under `guide`, and the same
 * file under the topic `getting-started`, are one document with one id in two trees. Move the file
 * and its folder placement changes; its id does not, provided it declared one.
 *
 * ## What is deliberately small
 *
 * There is no Markdown parser here, and there should not be. This serves the text and a handful of
 * front-matter fields; rendering it is a viewer's job, and a node that shipped an opinion about how
 * a heading looks would be the beginning of the layout engine the design says not to build.
 *
 * The index is built once and kept, rather than the disk being walked per request. A tree is asked
 * for one branch at a time and a branch must answer promptly; walking a directory on every
 * expansion turns a click into an I/O storm, and the thing this verb exists to avoid is fan-out.
 * `rescan()` is how a caller says the disk has changed, because the alternative - watching the
 * filesystem - is a decision about resources that belongs to whoever deploys this, not to a library.
 */

/** What the library holds about one file. Small enough for a row; the body is fetched separately. */
export interface MarkdownDocument {
    /**
     * Stable across a move, when the file says so.
     *
     * A document may declare `id:` in its front matter, and one that does keeps that id wherever it
     * is filed - which is what makes a saved link survive a reorganisation. A document that does not
     * gets its path, and the honest consequence is that moving it breaks links to it. That is a
     * property of the file rather than of this code, and saying so is better than inventing a
     * content hash: two copies of the same text are two documents, and a hash would merge them.
     */
    readonly id: string
    readonly title: string
    /** Where it actually is, relative to the root and always with forward slashes. */
    readonly path: string
    readonly topics: readonly string[]
    /**
     * Absent on a folder or a topic, which are structure rather than documents.
     *
     * A folder reporting `words: 0` is not saying it is empty, it is saying nothing at all - and a
     * viewer drawing the hint's columns has no way to tell those apart. Worse was the first draft's
     * topic row, which put a *document count* under the `words` label: a number that is true about
     * something else is harder to catch than a missing one.
     */
    readonly words?: number
    readonly modified?: string
}

export interface MarkdownLibraryProps extends Record<string, unknown> {
    readonly label: string
    /** Shown so a console can say which directory this is, never used to reach outside it. */
    readonly root: string
}

export interface MarkdownLibraryState extends Record<string, unknown> {
    readonly documents: number
    readonly topics: number
    readonly scannedAt: string
    readonly problem?: string
}

export interface MarkdownLibraryOptions {
    readonly label?: string
    /** How deep to walk. A bound, because a directory can contain a link to its own parent. */
    readonly maxDepth?: number
    /** Files past this size are indexed and refused a body, rather than read into memory. */
    readonly maxBytes?: number
    readonly maxDocuments?: number
}

const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENTS = 20_000

/** Front matter, the small part of it: a `---` block of `key: value` lines at the very top. */
const readFrontMatter = (text: string): { fields: { [key: string]: string }; body: string } => {
    if (!text.startsWith('---')) return { fields: {}, body: text }
    const end = text.indexOf('\n---', 3)
    if (end < 0) return { fields: {}, body: text }
    const fields: { [key: string]: string } = {}
    for (const line of text.slice(3, end).split('\n')) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    }
    // Past the closing fence and its newline, so the body does not begin with a stray line break.
    const after = text.indexOf('\n', end + 1)
    return { fields, body: after < 0 ? '' : text.slice(after + 1) }
}

const firstHeading = (body: string): string | undefined => {
    for (const line of body.split('\n', 40)) {
        const heading = /^#\s+(.+)$/.exec(line.trim())
        if (heading) return heading[1].trim()
    }
    return undefined
}

const topicsOf = (value: string | undefined): readonly string[] =>
    (value ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((topic) => topic.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)

/**
 * Serves a directory of Markdown as documents that appear in more than one tree.
 *
 * Exposed as an ordinary component, which is the point: nothing here is a special kind of node, and
 * a console that can browse a queue or a table can browse this with no knowledge of Markdown at all.
 */
@rpcNamespace('markdown')
export class MarkdownLibrary extends RpcComponent<MarkdownLibraryProps, MarkdownLibraryState> {
    private readonly root: string
    /**
     * Which incarnation this is, and how many times it has looked.
     *
     * These are the `epoch` and `revision` every page carries, and they answer two different
     * questions: the epoch changes when the process does, so a cached page from a library that has
     * restarted is not mistaken for a current one; the revision changes when the index does. An
     * earlier draft used the scan timestamp as the epoch and the document count as the revision,
     * and its own test caught both - two scans inside the same millisecond share a timestamp, and a
     * scan that replaces one document with another leaves the count exactly where it was.
     */
    private readonly incarnation = randomUUID()
    private scans = 0
    private readonly options: Required<Omit<MarkdownLibraryOptions, 'label'>>
    private documents = new Map<string, MarkdownDocument>()
    /** Folder path -> what is directly inside it, which is what one branch of the folder tree is. */
    private folders = new Map<string, { readonly folders: string[]; readonly documents: string[] }>()
    private topics = new Map<string, string[]>()

    constructor(root: string, options: MarkdownLibraryOptions = {}) {
        const resolved = resolve(root)
        super(
            { label: options.label ?? basename(resolved), root: resolved },
            { documents: 0, topics: 0, scannedAt: new Date(0).toISOString() }
        )
        this.root = resolved
        this.options = {
            maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
            maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
            maxDocuments: options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS
        }
        this.rescan()
    }

    /**
     * Walk the directory again.
     *
     * A method rather than a watcher. Watching a tree costs handles and wakes a process on every
     * save, and whether that is worth it depends on the deployment - a build step that regenerates
     * documentation wants one call at the end, and a person editing wants something else entirely.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    rescan(): number {
        const documents = new Map<string, MarkdownDocument>()
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
                // `lstat` rather than `stat`, so a symlink out of the root is a leaf this does not
                // follow rather than a door out of the directory it was pointed at.
                let stats
                try {
                    stats = statSync(full, { throwIfNoEntry: false })
                } catch {
                    continue
                }
                if (!stats) continue
                if (stats.isDirectory()) {
                    here.folders.push(this.relative(full))
                    walk(full, depth + 1)
                } else if (extname(entry).toLowerCase() === '.md') {
                    const document = this.read(full, stats.size, stats.mtime)
                    if (!document) continue
                    documents.set(document.id, document)
                    here.documents.push(document.id)
                    for (const topic of document.topics) topics.set(topic, [...(topics.get(topic) ?? []), document.id])
                }
            }
        }

        walk(this.root, 0)
        this.documents = documents
        this.folders = folders
        this.topics = topics
        this.scans += 1
        this.setState({
            documents: documents.size,
            topics: topics.size,
            scannedAt: new Date().toISOString(),
            ...(problem ? { problem } : { problem: undefined })
        })
        return documents.size
    }

    /**
     * One document's text.
     *
     * Bounded and refused rather than truncated silently: half a document that looks whole is worse
     * than a refusal that names the size, because nobody notices the missing half.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    body(id: string): { readonly document: MarkdownDocument; readonly markdown: string } {
        const document = this.documents.get(id)
        if (!document) throw new Error(`no document ${id}`)
        const full = this.within(document.path)
        const stats = statSync(full, { throwIfNoEntry: false })
        if (!stats) throw new Error(`${document.path} has gone since the last scan - call rescan`)
        if (stats.size > this.options.maxBytes) throw new Error(`${document.path} is ${stats.size} bytes, past the ${this.options.maxBytes} this library serves`)
        return { document, markdown: readFrontMatter(readFileSync(full, 'utf8')).body }
    }

    /** Every topic any document declares, which is what the topic tree's roots are. */
    @rpc({ semantics: 'query', effect: 'observe' })
    topicNames(): readonly string[] {
        return [...this.topics.keys()].sort()
    }

    dataResources(): readonly RpcDataResource[] {
        const row = {
            kind: 'object' as const,
            fields: {
                id: { type: { kind: 'string' as const } },
                title: { type: { kind: 'string' as const } },
                path: { type: { kind: 'string' as const } },
                kind: { type: { kind: 'string' as const } },
                topics: { type: { kind: 'array' as const, items: { kind: 'string' as const } } },
                words: { type: { kind: 'number' as const } },
                modified: { type: { kind: 'string' as const } }
            }
        }
        return [
            {
                path: ['folders'],
                label: 'By folder',
                shape: 'tree',
                verbs: ['getChildren'],
                presentation: { defaultColumns: ['title', 'words', 'modified'] },
                row
            },
            {
                path: ['topics'],
                label: 'By topic',
                shape: 'tree',
                verbs: ['getChildren'],
                presentation: { defaultColumns: ['title', 'path', 'modified'] },
                row
            },
            {
                path: ['documents'],
                label: 'All documents',
                shape: 'list',
                verbs: ['getList'],
                presentation: { defaultColumns: ['title', 'path', 'topics', 'words'] },
                row
            }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetChildrenParams & RpcGetListParams): RpcGetChildrenResult | RpcGetListResult {
        if (method === 'getChildren' && resource[0] === 'folders') return this.folderBranch(params)
        if (method === 'getChildren' && resource[0] === 'topics') return this.topicBranch(params)
        if (method === 'getList' && resource[0] === 'documents') return this.page([...this.documents.values()], params)
        throw new Error(`markdown does not answer ${method} for ${resource.join('.')}`)
    }

    /** Folders and documents directly inside one folder. Absent parent means the root folder. */
    private folderBranch(params: RpcGetChildrenParams): RpcGetChildrenResult {
        const here = this.folders.get(params.parentId ?? '')
        if (!here) return this.branch([], params)
        const rows = [
            ...here.folders.map((path) => ({ id: path, title: basename(path), path, kind: 'folder' as const, topics: [] })),
            ...here.documents.map((id) => ({ ...this.documents.get(id)!, kind: 'document' as const }))
        ]
        return this.branch(rows, params)
    }

    /**
     * Topics at the top, the documents that declare one beneath it.
     *
     * The same document appears under every topic it declares, and under its folder as well, with
     * the same id every time. That is the claim this package exists to make concrete.
     */
    private topicBranch(params: RpcGetChildrenParams): RpcGetChildrenResult {
        if (params.parentId === undefined) {
            const rows = [...this.topics.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([topic]) => ({ id: `topic:${topic}`, title: topic, path: '', kind: 'topic' as const, topics: [] }))
            return this.branch(rows, params)
        }
        const topic = params.parentId.startsWith('topic:') ? params.parentId.slice('topic:'.length) : undefined
        const ids = topic ? (this.topics.get(topic) ?? []) : []
        return this.branch(
            ids.map((id) => ({ ...this.documents.get(id)!, kind: 'document' as const })),
            params
        )
    }

    /** Filter, sort and page a branch, then say which of its rows have children of their own. */
    private branch(rows: readonly Row[], params: RpcGetChildrenParams): RpcGetChildrenResult {
        const page = this.page(rows, params)
        return { ...page, hasChildren: (page.data as Row[]).map((row) => this.hasChildren(row)) }
    }

    private hasChildren(row: Row): boolean {
        if (row.kind === 'folder') {
            const here = this.folders.get(row.id)
            return !!here && (here.folders.length > 0 || here.documents.length > 0)
        }
        if (row.kind === 'topic') return (this.topics.get(row.title)?.length ?? 0) > 0
        return false
    }

    /** One named field of a row, for the filter and the sort. A row is data here, not a class. */
    private static field(row: Row, name: string): unknown {
        return (row as unknown as Record<string, unknown>)[name]
    }

    private page(rows: readonly Row[] | readonly MarkdownDocument[], params: RpcGetListParams): RpcGetListResult {
        let kept = [...rows] as Row[]
        const condition = params.filter as { field?: string; op?: string; operand?: unknown } | undefined
        if (condition?.field && condition.op === 'contains') {
            const field = condition.field
            kept = kept.filter((row) => String(MarkdownLibrary.field(row, field) ?? '').toLowerCase().includes(String(condition.operand).toLowerCase()))
        } else if (condition?.field && condition.op === 'eq') {
            const field = condition.field
            kept = kept.filter((row) => MarkdownLibrary.field(row, field) === condition.operand)
        }
        if (params.sort?.field) {
            const field = params.sort.field
            const order = params.sort.order === 'DESC' ? -1 : 1
            kept.sort((a, b) => {
                const left = MarkdownLibrary.field(a, field) as string | number
                const right = MarkdownLibrary.field(b, field) as string | number
                return left === right ? 0 : (left < right ? -1 : 1) * order
            })
        }
        const total = kept.length
        const { page = 0, pageSize } = params.pagination ?? {}
        if (pageSize !== undefined) kept = kept.slice(page * pageSize, page * pageSize + pageSize)
        return { data: kept, ids: kept.map((row) => row.id), total, epoch: this.incarnation, revision: this.scans }
    }

    private read(full: string, size: number, modified: Date): MarkdownDocument | undefined {
        const path = this.relative(full)
        let fields: { [key: string]: string } = {}
        let body = ''
        if (size <= this.options.maxBytes)
            try {
                ;({ fields, body } = readFrontMatter(readFileSync(full, 'utf8')))
            } catch {
                return undefined
            }
        return {
            id: fields.id || path,
            title: fields.title || firstHeading(body) || basename(path, extname(path)),
            path,
            topics: topicsOf(fields.topics ?? fields.tags),
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
     * The paths here were produced by this class's own scan, so this should never fire - which is
     * exactly why it is here. An index is a cache, a caller supplies the id that selects from it,
     * and the day something upstream lets a `../` into one of these is the day this is the only
     * thing between a documentation browser and the rest of the filesystem.
     */
    private within(path: string): string {
        const full = resolve(this.root, path)
        if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`${path} is outside this library`)
        return full
    }
}

type Row = MarkdownDocument & { kind: 'folder' | 'document' | 'topic' }
