import { canonicalText, digestText } from '@source-repo/rpc'
// The shapes belong to the package that serves them over the wire; what is here is the walk that
// fills them in, which lives with the compiler rather than with the node.
import { SOURCE_CATALOGUE_VERSION, type RpcSourceBinding, type RpcSourceCatalogue, type RpcSourceFile, type RpcSourceSpan } from '@source-repo/diagnostics/catalogue'
import { readFileSync } from 'node:fs'
import { relative, resolve as resolvePath } from 'node:path'
import type { ClassDeclaration, Project, Type } from 'ts-morph'

/**
 * Where a component's values are *written down*, so a live value can be shown beside its declaration.
 *
 * The simplest live view needs no instrumentation at all. Props and state are already observable -
 * a subscriber receives them, `authorize()` has already ruled on them, and a projection has already
 * narrowed them - so the only thing missing is *where in the source each one is declared*. That is
 * static, known at build time, and costs the running artifact nothing.
 *
 * **This catalogue carries no values and never will.** It says `state.zones.top.setpoint` is
 * declared at line 34 of `oven.ts`; what that setpoint currently is comes from the component channel
 * the viewer already has, through the same permission check as any other observation. Which is what
 * makes "a user cannot obtain a field through source view that they could not obtain through
 * ordinary authorised observation" a fact about the architecture rather than a check somebody has to
 * remember to write.
 */


/** A recursive shape reaches its own declaration again; the bound is what stops the walk. */
const MAX_DEPTH = 12

/**
 * The paths a viewer can bind to, and deliberately not every path a value can have.
 *
 * An object's properties are declared, so each one has a place in the source. A **record**'s keys
 * are data - that is the whole reason `$data` is a call rather than a subscription - so `tags` has a
 * declaration and `tags['tag.007']` does not, and inventing a span for it would put a value beside a
 * line that says nothing about it. Arrays are the same argument with numbers. So the walk descends
 * through objects and stops at everything else, which is exactly the line the scope tree already
 * draws between type and data.
 */
const walk = (type: Type, path: string, root: string, into: RpcSourceBinding[], depth: number) => {
    if (depth > MAX_DEPTH) return
    for (const property of type.getProperties()) {
        const declarations = property.getDeclarations()
        if (!declarations.length) continue
        const here = `${path}.${property.getName()}`
        const spans: RpcSourceSpan[] = []
        let fileId = ''
        for (const declaration of declarations) {
            const file = declaration.getSourceFile()
            fileId = relative(root, file.getFilePath()) || file.getBaseName()
            const start = file.getLineAndColumnAtPos(declaration.getStart())
            const end = file.getLineAndColumnAtPos(declaration.getEnd())
            spans.push({ startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column })
        }
        const declared = property.getTypeAtLocation(declarations[0])
        into.push({ sourceRpcPath: here, fileId, spans, declaredType: declared.getText(declarations[0]) })
        // Only through objects. A record's keys are data and an array's are numbers; neither has a
        // declaration to stand beside.
        if (declared.isObject() && !declared.isArray() && declared.getStringIndexType() === undefined && declared.getNumberIndexType() === undefined)
            walk(declared, here, root, into, depth + 1)
    }
}

/** The bindings for one component class, given the props and state types the contract resolved. */
export const bindingsFor = (props: Type | undefined, state: Type | undefined, root: string): readonly RpcSourceBinding[] => {
    const bindings: RpcSourceBinding[] = []
    if (props) walk(props, 'props', root, bindings, 0)
    if (state) walk(state, 'state', root, bindings, 0)
    return bindings
}

/**
 * Hash the files the bindings point into, and name the revision by what they contain.
 *
 * The revision id is derived rather than supplied so that two builds of the same source produce the
 * same id and a build of different source cannot produce the same one - which is the property the
 * whole feature rests on. A build number would satisfy neither.
 */
export const sealCatalogue = async (
    files: readonly string[],
    components: { readonly [componentType: string]: readonly RpcSourceBinding[] },
    root: string
): Promise<RpcSourceCatalogue> => {
    const described: RpcSourceFile[] = []
    for (const path of [...files].sort()) {
        const text = readFileSync(path, 'utf8')
        described.push({ fileId: relative(root, resolvePath(path)) || path, contentHash: await digestText(text), lines: text.split('\n').length })
    }
    const sourceBundleHash = await digestText(canonicalText(described.map((file) => [file.fileId, file.contentHash])))
    return {
        catalogueVersion: SOURCE_CATALOGUE_VERSION,
        // The bindings are part of the identity, not only the text: the same files describing a
        // different set of paths is a different thing to overlay, however the bytes compare.
        semanticRevisionId: await digestText(canonicalText([sourceBundleHash, components])),
        sourceBundleHash,
        files: described,
        components
    }
}

/** Whether a file a viewer is holding is the file this catalogue was built from. */
export const fileMatches = async (catalogue: RpcSourceCatalogue, fileId: string, text: string): Promise<boolean> => {
    const known = catalogue.files.find((file) => file.fileId === fileId)
    return known !== undefined && known.contentHash === (await digestText(text))
}

/** The component classes in a project, for a caller that has already built the project. */
export const componentTypesIn = (project: Project): readonly ClassDeclaration[] => project.getSourceFiles().flatMap((file) => file.getClasses())
