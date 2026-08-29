import type { RpcProbeDefinition, RpcProbeKind } from '@source-repo/diagnostics/variant'
import type { RpcSourceSpan } from '@source-repo/diagnostics/catalogue'
import { Node, Project, ScriptTarget, ts, type SourceFile, type Statement } from 'ts-morph'
import { PROBE_RECEIVER } from './variant.js'

/**
 * Generating probes into a copy of the node's own source.
 *
 * The other half of the pass beside it: `variant.ts` proves a derivative is one, and this produces
 * derivatives for it to prove. They are deliberately separate and the verifier was written first,
 * because a generator that also defined what counted as correct would be marking its own homework -
 * every test here ends by handing its output to `provesDerivative`, which was written without
 * knowing what this would emit.
 *
 * **The rule that shapes everything here is the design's: report a probe as unavailable rather than
 * perform a transform of uncertain equivalence.** A missing probe is a screen with one fewer value
 * on it. A transform that was nearly equivalent is a plant running code nobody approved, and the
 * difference will not be visible until it matters. So every construct this version cannot instrument
 * with a proof in hand comes back in `unavailable`, with the reason, and the artifact does not
 * contain it.
 */

/** A viewport, in the lines somebody is actually looking at. Expanded before anything is planned. */
export interface RpcViewport {
    readonly from: number
    readonly to: number
}

/** A region worth instrumenting: in practice a whole function, which is the design's default unit. */
export interface RpcRegion {
    readonly span: RpcSourceSpan
    /** Where the body's statements begin, so entry probes land inside rather than before. */
    readonly bodyStart: number
    readonly start: number
    readonly end: number
    readonly label: string
}

/** A probe this version will not generate, and why. Reported rather than quietly omitted. */
export interface RpcUnavailableProbe {
    readonly kind: RpcProbeKind
    readonly span: RpcSourceSpan
    readonly why: string
}

export interface RpcInstrumentation {
    readonly text: string
    readonly plan: readonly RpcProbeDefinition[]
    readonly unavailable: readonly RpcUnavailableProbe[]
}

export interface RpcInstrumentOptions {
    /** Where the probe helper is imported from in the generated artifact. */
    readonly runtimeModule?: string
    /**
     * The most probes this plan may contain.
     *
     * Bounded because a session's probe budget is advertised in the node's capabilities and a plan
     * that ignored it would be discovered at activation, having already been built and reviewed.
     * Reaching it reports what was left out rather than truncating silently.
     */
    readonly maxProbes?: number
}

const DEFAULT_RUNTIME_MODULE = '@source-repo/rpc-diagnostics-runtime'
const DEFAULT_MAX_PROBES = 500

const parsing = () => new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ESNext, allowJs: true } })

const spanOf = (file: SourceFile, start: number, end: number): RpcSourceSpan => {
    const from = file.getLineAndColumnAtPos(start)
    const to = file.getLineAndColumnAtPos(end)
    return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column }
}

/**
 * A probe's id, derived from where it is in the **approved** source.
 *
 * Derived rather than counted, so the same source produces the same plan however the walk reached
 * it - a counter would renumber every probe after an edit, and a session holding probe `7` would
 * quietly start watching something else. It is not stable across revisions, and cannot be: the
 * position it is built from is exactly what an edit moves. That is the design's rule stated in the
 * id itself rather than in a comment somebody has to find.
 */
const probeId = (kind: RpcProbeKind, fileId: string, span: RpcSourceSpan) => `${kind}:${fileId}:${span.startLine}:${span.startColumn}`

/** A splice into the original text. Never overlapping - see `wrappable`. */
interface Edit {
    readonly start: number
    readonly end: number
    readonly text: string
    /**
     * Which insertion wins when two land on the same offset, and one pair always does: a function's
     * entry probe and the statement probe on the first statement of its body. Applied back to front,
     * the *last* insertion at an offset ends up first in the text - so the one that must read first
     * is applied last, and `entry` outranks `statement` accordingly.
     */
    readonly rank: number
}

/**
 * Every function-like node whose lines the viewport touches.
 *
 * **The containing function, not the visible lines.** A viewport begins in the middle of a
 * condition as often as not, and instrumenting from there would put an entry probe inside an
 * expression. Taking the whole function is also what makes the result stable while somebody
 * scrolls: a plan built for a function does not change because two more of its lines came into view,
 * so the variant already running stays the right one.
 *
 * Nested functions are regions of their own and are returned separately, so an arrow inside a method
 * is instrumented as itself rather than as part of the method that happens to hold it.
 */
const regionsIn = (file: SourceFile, viewports: readonly RpcViewport[]): readonly { readonly node: Node; readonly region: RpcRegion }[] => {
    const found: { node: Node; region: RpcRegion }[] = []

    for (const node of file.getDescendants()) {
        if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node) && !Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) continue
        const body = node.getBody()
        // An expression-bodied arrow has no statement list to put an entry probe in front of.
        // Instrumenting it would mean rewriting it into a block, which is a change to the program.
        if (!body || !Node.isBlock(body)) continue
        const span = spanOf(file, node.getStart(), node.getEnd())
        const touched = viewports.some((viewport) => viewport.from <= span.endLine && viewport.to >= span.startLine)
        if (!touched) continue
        const first = body.getStatements()[0]
        found.push({
            node,
            region: {
                span,
                bodyStart: first ? first.getStart() : body.getEnd() - 1,
                start: node.getStart(),
                end: node.getEnd(),
                label: Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) ? (node.getName() ?? 'anonymous') : 'anonymous'
            }
        })
    }

    // Innermost first, so a plan walks a nested arrow before the method around it and the union a
    // session accumulates has a stable order whatever sequence the viewports arrived in.
    return found.sort((a, b) => b.region.start - a.region.start || a.region.end - b.region.end)
}

export const expandToRegions = (text: string, fileId: string, viewports: readonly RpcViewport[]): readonly RpcRegion[] =>
    regionsIn(parsing().createSourceFile(fileId, text, { overwrite: true }), viewports).map((found) => found.region)

/**
 * The union a session accumulates, deduplicated.
 *
 * Scrolling is debounced upstream; this is what makes the accumulation bounded rather than
 * ever-growing in the only way that matters - two viewports over one function are one region, so a
 * user reading down a file does not build a plan per scroll position.
 */
export const unionOfRegions = (regions: readonly RpcRegion[]): readonly RpcRegion[] => {
    const byStart = new Map<number, RpcRegion>()
    for (const region of regions) if (!byStart.has(region.start)) byStart.set(region.start, region)
    return [...byStart.values()].sort((a, b) => b.start - a.start || a.end - b.end)
}

/**
 * Whether an expression can be wrapped without any other probe landing inside it.
 *
 * A wrapping probe replaces a span of text with itself plus that span. If another edit fell inside
 * that span, one of the two would be applied to text the other had already rewritten - so the rule
 * is that a wrapped expression contains no function body, which is the only way a *statement* can
 * appear inside an *expression*. An initialiser holding an arrow function is therefore left
 * unwrapped and reported, and the arrow is instrumented as the region it is.
 *
 * The alternative - a transformation that tracked offsets as it rewrote nested spans - is a
 * correctness problem solved with arithmetic in the one place where being nearly right is worthless.
 */
const holdsABody = (node: Node) => Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)

// The node itself as well as its descendants, and the difference is not academic: `const measure =
// () => { ... }` has an initialiser that *is* the arrow rather than one containing it, so a check
// that only descended would wrap the very expression whose body is about to be instrumented as a
// region of its own - two edits over one span, and the artifact comes out corrupt.
const wrappable = (node: Node): boolean => !holdsABody(node) && !node.getDescendants().some(holdsABody)

/**
 * Plan and emit in one pass over the original tree, so every span is a span of the approved source.
 *
 * The design says the adapter records original source spans **before** emit, and the reason shows up
 * the moment a viewer draws something: the person is looking at the approved file, not at the
 * instrumented copy, so a span measured after emit would position a value using coordinates from a
 * file nobody can see.
 */
export const instrumentSource = (
    text: string,
    fileId: string,
    semanticRevisionId: string,
    viewports: readonly RpcViewport[],
    options: RpcInstrumentOptions = {}
): RpcInstrumentation => {
    const file = parsing().createSourceFile(fileId, text, { overwrite: true })
    const found = regionsIn(file, viewports)
    const kept = new Set(unionOfRegions(found.map((one) => one.region)).map((region) => region.start))
    const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES

    const plan: RpcProbeDefinition[] = []
    const unavailable: RpcUnavailableProbe[] = []
    const edits: Edit[] = []
    let budgetSpent = false

    const at = (start: number, end: number) => spanOf(file, start, end)

    const record = (kind: RpcProbeKind, span: RpcSourceSpan, containingFunctionId: string, emit: (id: string) => Edit, displayText?: string): void => {
        if (plan.length >= maxProbes) {
            if (!budgetSpent) {
                budgetSpent = true
                unavailable.push({ kind, span, why: `this plan already carries ${maxProbes} probes, which is the budget it was given; what is beyond it is left out and said so rather than truncating the plan quietly` })
            }
            return
        }
        const id = probeId(kind, fileId, span)
        plan.push({ probeId: id, semanticRevisionId, fileId, span, kind, containingFunctionId, ...(displayText ? { displayText } : {}) })
        edits.push(emit(id))
    }

    const insertion =
        (position: number, member: string, rank = 0) =>
        (id: string) => ({ start: position, end: position, text: `${PROBE_RECEIVER}.${member}(${JSON.stringify(id)}); `, rank })
    const wrap = (node: Node, member: string) => (id: string) => ({ start: node.getStart(), end: node.getEnd(), text: `${PROBE_RECEIVER}.${member}(${JSON.stringify(id)}, ${node.getText()})`, rank: 0 })

    for (const { node, region } of found) {
        if (!kept.has(region.start)) continue
        const container = `${fileId}:${region.span.startLine}:${region.label}`
        const block = Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) ? node.getBody() : undefined
        if (!block || !Node.isBlock(block)) continue

        record('function-entry', at(region.start, region.bodyStart), container, insertion(region.bodyStart, 'entry', 1))

        // **Every return in the region, wherever it is nested**, and found by its own scan rather
        // than by the statement walk below. Entry and exit have to pair up or an overlay shows a
        // function that was entered and never left - and returns hide inside blocks, loops and
        // `try` bodies, which is exactly where a walk that only descends where it knows how to probe
        // would fail to look. Returns inside a nested function belong to that function's own region.
        for (const statement of block.getDescendantsOfKind(ts.SyntaxKind.ReturnStatement)) {
            if (statement.getFirstAncestor((ancestor) => holdsABody(ancestor) && ancestor !== node)) continue
            // Before the return rather than around its expression, which leaves the expression
            // untouched. It fires before the returned value is computed - the honest name for that
            // is "the function is leaving here", and it is what an exit overlay draws.
            record('function-exit', at(statement.getStart(), statement.getEnd()), container, insertion(statement.getStart(), 'exit'))
        }

        planStatements(block.getStatements(), container)
    }

    /**
     * The statements of one region, descending through blocks and branches but never into a nested
     * function - that is its own region, and reaching into it from here would probe one function's
     * execution and file it under another's.
     *
     * A loop or a `try` is probed as the single statement it is: this version does not descend into
     * them, so their bodies carry fewer probes. That is a coverage limit and not an equivalence risk,
     * and it is the honest place to stop a first transformer.
     */
    function planStatements(statements: readonly Statement[], container: string) {
        for (const statement of statements) {
            // Handled by the return scan above, which finds them at every depth.
            if (Node.isReturnStatement(statement)) continue

            record('statement', at(statement.getStart(), statement.getEnd()), container, insertion(statement.getStart(), 'statement'), statement.getText().slice(0, 80))

            if (Node.isVariableStatement(statement)) planValues(statement, container)
            if (Node.isIfStatement(statement)) planBranches(statement, container)
            if (Node.isBlock(statement)) planStatements(statement.getStatements(), container)
        }
    }

    function planValues(statement: Statement, container: string) {
        if (!Node.isVariableStatement(statement)) return
        for (const declaration of statement.getDeclarationList().getDeclarations()) {
            const initialiser = declaration.getInitializer()
            if (!initialiser) continue
            const span = at(initialiser.getStart(), initialiser.getEnd())
            if (!wrappable(initialiser)) {
                unavailable.push({
                    kind: 'value',
                    span,
                    why: `${declaration.getName()} is initialised from an expression containing a function body, which is instrumented as its own region rather than wrapped - a probe around it would have to be rewritten as another probe rewrote its inside`
                })
                continue
            }
            record('value', span, container, wrap(initialiser, 'value'), declaration.getName())
        }
    }

    function planBranches(statement: Statement, container: string) {
        if (!Node.isIfStatement(statement)) return
        const condition = statement.getExpression()
        const span = at(condition.getStart(), condition.getEnd())
        if (!wrappable(condition)) {
            unavailable.push({ kind: 'condition', span, why: 'this condition contains a function body, so wrapping it would enclose probes generated inside that body' })
        } else {
            // The whole condition, never its operands. `a && b` wrapped as one expression
            // short-circuits exactly as it did; wrapping each side separately would be a second
            // decision about evaluation order taken by a program that cannot see what it costs.
            record('condition', span, container, wrap(condition, 'condition'), condition.getText().slice(0, 80))
        }

        for (const [branch, which] of [
            [statement.getThenStatement(), 'then'],
            [statement.getElseStatement(), 'else']
        ] as const) {
            if (!branch) continue
            if (!Node.isBlock(branch)) {
                unavailable.push({
                    kind: 'branch',
                    span: at(branch.getStart(), branch.getEnd()),
                    why: `the ${which} branch is a single statement rather than a block, and putting a probe in front of it would mean adding braces - which is a change to the program even where it reads as the same one`
                })
                continue
            }
            const first = branch.getStatements()[0]
            const position = first ? first.getStart() : branch.getEnd() - 1
            // Ranked above the statement probe on the first statement inside the block, for the same
            // reason entry outranks one: they land on the same offset, and the branch was taken
            // before the statement in it ran.
            record('branch', at(branch.getStart(), branch.getEnd()), `${container}:${which}`, insertion(position, 'branch', 1))
            planStatements(branch.getStatements(), container)
        }
    }

    if (!plan.length) return { text, plan, unavailable }

    // Applied back to front, so an earlier edit's offsets are still the offsets of the original
    // text. Non-overlapping by construction - see `wrappable` - which is what lets this be a splice
    // rather than a second transformation with its own equivalence to prove.
    let out = text
    for (const edit of [...edits].sort((a, b) => b.start - a.start || a.rank - b.rank)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`

    // After the existing imports where that is above every edit, and at the top otherwise. The
    // offsets in `out` are only still the original file's offsets before the first splice, so an
    // import placed after one would be placed by arithmetic that stopped being true.
    const imports = file.getImportDeclarations()
    const afterImports = imports.length ? imports[imports.length - 1]!.getEnd() + 1 : 0
    const firstEdit = Math.min(...edits.map((edit) => edit.start))
    const importAt = afterImports <= firstEdit ? afterImports : 0
    const runtime = options.runtimeModule ?? DEFAULT_RUNTIME_MODULE
    out = `${out.slice(0, importAt)}import { ${PROBE_RECEIVER} } from ${JSON.stringify(runtime)}\n${out.slice(importAt)}`

    return { text: out, plan, unavailable }
}
