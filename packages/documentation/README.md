# @source-repo/documentation

The documentation aspect of a system: what describes a thing, in whatever format it was written.

```
npm install @source-repo/documentation
```

```ts
const handbook = new DocumentLibrary('./docs', { label: 'Handbook', identity: { peer: 'plant', instance: 'handbook' } })
server.exposeClassInstance(handbook, 'handbook')
```

## The aspect is documentation; the format is a kind

This package was briefly called `markdown`, and that named the wrong axis. A folder of documentation is not a folder of Markdown that happens to contain other things — it is a set of documents that happen to be written in whatever their authors used. Naming it for one extension made every other format a special case of the first.

So documents carry a **kind** — `document.markdown`, `document.text` — and a [`DocumentReader`](src/Reader.ts) turns one format into a title, some topics and some content blocks. Nothing about the aspect, the trees, the links or the wire knows which reader answered. Adding HTML, RTF or a Source View artefact is a reader and a line in a list.

Two readers ship, which is one more than is needed to use the package and exactly enough to prove the seam. The rest arrive when a directory needs them, with the question each raises answered then rather than guessed now: HTML has to decide what it does about scripts and remote references, RTF needs a parser this package would rather not own, and an artefact needs the renderer question [`@source-repo/aspects`](../aspects) deliberately left open.

## Two arrangements, one document

What a reader wants from documentation is rarely the order it was filed in, so the library offers **by folder** — where they are — and **by topic** — what they are about. A document in both is one document: it has one reference, and a link saved against it resolves in whichever arrangement the reader is using. Follow a link while reading by topic and you stay in the topic tree; when that tree cannot place the target, the answer says a fallback was used rather than quietly changing the subject.

A document that declares `id:` in its front matter keeps that id wherever it is filed, which is what lets a saved link survive a reorganisation. One that declares none is identified by its path, and moving it breaks links to it — a property of the file rather than of this package, and better said than papered over with a content hash, since two copies of the same text are two documents.

## Bounds

`maxDepth` (12), `maxBytes` (1 MB) and `maxDocuments` (20 000), all overridable. Dot-directories are skipped, a document past `maxBytes` is indexed and **refused a body** rather than truncated, and a path that would leave the root is refused. `rescan()` is a method rather than a watcher, because whether watching a tree is worth the handles depends on the deployment.

MIT.
