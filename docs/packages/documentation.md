# @source-repo/documentation

The documentation aspect of a system: what describes a thing, in whatever format it was written.

```
npm install @source-repo/documentation
```

- **The aspect is documentation; the format is a kind** — documents carry `document.markdown` or `document.text`, and a `DocumentReader` turns one format into a title, topics and content blocks. Nothing about the aspect, the trees, the links or the wire knows which reader answered.
- **Two arrangements of the same documents** — by folder, which is where they are, and by topic, which is what they are about. A document in both is one document.
- **A link survives a reorganisation** — a document declaring `id:` in its front matter keeps that id wherever it is filed. One that does not is identified by its path, and moving it breaks links to it: a property of the file, said rather than papered over with a content hash.
- **Prose becomes references** — a Markdown link landing inside the same library becomes a typed link to that document; one that leaves it stays ordinary text, untouched.
- **Bounded** — depth, file size and document count all have limits, a document past the size bound is indexed and refused a body rather than truncated, and a path that would leave the root is refused.
- **`rescan()` rather than a watcher** — whether watching a tree is worth the handles depends on the deployment: a build step wants one call at the end, a person editing wants something else.

Adding HTML, RTF or a Source View artefact is a reader and a line in a list. Two ship, which is one more than is needed to use the package and exactly enough to prove the seam.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/documentation/README.md). On npm: [@source-repo/documentation](https://www.npmjs.com/package/@source-repo/documentation).
