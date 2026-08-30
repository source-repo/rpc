import type { ContentBlock } from '@source-repo/aspects'

/**
 * How one format becomes a document.
 *
 * The distinction this file exists to make: **the aspect is documentation, the format is a kind.**
 * An earlier draft of this package was called `markdown`, which named the wrong axis - a folder of
 * documentation is not a folder of Markdown that happens to contain other things, it is a set of
 * documents that happen to be written in whatever their authors used. Naming the package for one
 * extension made every other format a special case of the first.
 *
 * So a reader turns a file into a title, some topics and some blocks, and the library does not care
 * which one answered. Adding RTF, or a Source View artefact, or anything else is a reader and a
 * line in a list - not a change to the aspect, the tree, the links or the wire.
 *
 * ## Why so few are here
 *
 * Two: Markdown and plain text. That is enough to prove the seam is real - two kinds under one
 * aspect, arriving as different block types - and one more than is needed to use it. The rest
 * arrive when somebody has a directory that needs them, with the question each raises answered
 * then: HTML has to decide what it does about scripts and remote references, RTF needs a parser
 * this package would rather not own, and a Source View artefact needs the renderer question the
 * aspects design deliberately left open.
 */
export interface DocumentReader {
    /** Namespaced, and what an occurrence carries as its kind: `document.markdown`. */
    readonly kind: string
    /** Lower-case, with the dot: `.md`. The first reader claiming an extension gets it. */
    readonly extensions: readonly string[]
    /** Turn the file's text into what the library publishes about it. */
    read(text: string, name: string): { readonly title?: string; readonly topics: readonly string[]; readonly blocks: readonly ContentBlock[] }
}

/** Front matter, the small part of it: a `---` block of `key: value` lines at the very top. */
export const frontMatter = (text: string): { fields: { [key: string]: string }; body: string } => {
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

const topicsOf = (value: string | undefined): readonly string[] =>
    (value ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((topic) => topic.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)

const firstHeading = (body: string): string | undefined => {
    for (const line of body.split('\n', 40)) {
        const heading = /^#\s+(.+)$/.exec(line.trim())
        if (heading) return heading[1].trim()
    }
    return undefined
}

/** Markdown: front matter for what the author declared, the first heading for what they wrote. */
export const markdownReader: DocumentReader = {
    kind: 'document.markdown',
    extensions: ['.md', '.markdown'],
    read: (text) => {
        const { fields, body } = frontMatter(text)
        return {
            ...(fields.title || firstHeading(body) ? { title: fields.title || firstHeading(body) } : {}),
            topics: topicsOf(fields.topics ?? fields.tags),
            blocks: [{ kind: 'markdown', id: 'body', markdown: body }]
        }
    }
}

/**
 * Plain text, served as a `code` block rather than as Markdown.
 *
 * The tempting shortcut is to call it Markdown and let a renderer deal with it, and it is wrong in
 * a way that shows up late: a plain-text file full of asterisks and underscores would render as
 * emphasis nobody wrote. A `code` block with no language says what this is - text to be shown as
 * written - which is the honest claim and the one a viewer can act on.
 */
export const textReader: DocumentReader = {
    kind: 'document.text',
    extensions: ['.txt', '.log'],
    read: (text, name) => ({ title: name, topics: [], blocks: [{ kind: 'code', id: 'body', code: text }] })
}

export const defaultReaders: readonly DocumentReader[] = [markdownReader, textReader]

/** Which reader answers for a file, by extension. `undefined` means the file is not documentation. */
export const readerFor = (extension: string, readers: readonly DocumentReader[]): DocumentReader | undefined =>
    readers.find((reader) => reader.extensions.includes(extension.toLowerCase()))
