# @source-repo/markdown

A directory of Markdown, served over Source RPC as **several trees over the same documents**.

```
npm install @source-repo/markdown
```

```ts
const handbook = new MarkdownLibrary('./docs', { label: 'Handbook' })
server.exposeClassInstance(handbook, 'handbook')
```

That is the whole of it. A console that can browse a queue or a database table can now browse a documentation folder, because what it browses is `$data` and not Markdown.

## Why a tree, and why more than one

The structure a reader wants is rarely the structure on disk. A folder tree is one answer; grouping by the topics documents declare is a different answer over exactly the same documents. Neither is more true than the other, and **a document does not become two documents by appearing in both**.

So this serves three resources: `folders` and `topics` as trees, and `documents` as a flat list for search and filtering. A document that declares `id:` in its front matter keeps that id in every one of them, which is what lets a saved link survive a reorganisation. A document that declares none is identified by its path, and the honest consequence is that moving it breaks links to it — that is a property of the file rather than of this package, and saying so is better than inventing a content hash, since two copies of the same text are two documents and a hash would merge them.

Trees are fetched **a branch at a time**, over `getChildren`. Expanding one folder says nothing about what is inside the folders it contains, which is the point: nobody can say how many descendants a node has before somebody asks, and the fan-out is what the verb exists to avoid. Each row carries `hasChildren`, so a viewer knows whether to draw an expander before anyone expands.

## What it deliberately does not do

There is no Markdown parser here. This serves the text and a handful of front-matter fields — `id`, `title`, `topics`/`tags` — and rendering is a viewer's job. A node with an opinion about how a heading looks would be the beginning of a layout engine delivered over the wire.

There is no filesystem watcher either. `rescan()` is a method, because whether watching a tree is worth the handles depends on the deployment: a build step that regenerates documentation wants one call at the end, and a person editing wants something else entirely.

Bodies are fetched per document rather than carried in every row, and one past `maxBytes` is **refused rather than truncated** — half a document that looks whole is worse than a refusal that names the size.

## Bounds

`maxDepth` (12), `maxBytes` (1 MB) and `maxDocuments` (20 000) all have defaults and are all overridable. Symlinks are not followed out of the root, dot-directories are skipped, and a path that would leave the root is refused — the index is built from this package's own scan, so that last one should never fire, which is exactly why it is there.

MIT.
