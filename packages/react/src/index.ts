/**
 * A resource UI toolkit for Source RPC.
 *
 * Everything here draws a resource a peer described, and none of it knows what the resource *is*.
 * A table of dead letters, a tree of an OPC UA address space, a folder of documents and a SQL row
 * being edited are one set of components, because `describe()` says enough about all four for a
 * viewer to draw them without having heard of any of them.
 *
 * ## Where the line is
 *
 * This is not an application. It has no routing, no authentication, no layout of its own and no
 * opinion about what a page contains - `@source-repo/rpc-cli` supplies all of that, and a second
 * consumer would supply its own. What is here is the part that would otherwise be written twice.
 *
 * It is also not a renderer for an interchange format. The framework-independent *rules* live
 * underneath the components on purpose - which fields a view is about, how they group, which
 * actions a row may take, what a search may ask - and several of them do not live here at all: the
 * ones that interpret a declaration sit beside that declaration, in `@source-repo/rpc`, so that the
 * CLI and MCP get the same answer as a browser rather than a second implementation of it.
 *
 * ## Versioning
 *
 * On its own, like `@source-repo/queue`, and for the same reason: it depends on the library's
 * *public* API rather than on its internals, so a version of its own says something true. Pinning
 * it to the library's would un-prove exactly what it exists to prove.
 */

// The rules, which are not React and several of which a non-browser would want.
export * from './types.js'
export * from './scope.js'
export * from './paging.js'
export * from './filter.js'
export * from './navigable.js'
export * from './searching.js'
export * from './views.js'
export * from './writes.js'
export * from './timing.js'
export * from './data.js'

// The components, which are.
export * from './ArgumentField.js'
export * from './Pager.js'
export * from './ValueTree.js'
export * from './ObjectPanel.js'
export * from './RecordPanel.js'
export * from './RecordForm.js'
export * from './ActionForm.js'
export * from './references.js'
export * from './ResourceTree.js'
export * from './ValueGrid.js'
export * from './Search.js'
export * from './command.js'
