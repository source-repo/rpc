import { digestText } from '@source-repo/rpc'
import type { RpcProbeDefinition, RpcProbeKind } from '@source-repo/diagnostics/variant'
import { Node, Project, ScriptTarget, ts } from 'ts-morph'

/**
 * Reducing a diagnostic variant back to the source it was made from, and refusing when it will not.
 *
 * The claim a variant makes is that it is the approved source plus probes. Nothing about a build
 * checks that on its own: a transformer with a bug, a hand-edited artifact and a deliberately
 * altered one all produce a file that compiles and runs on a plant. So the check is the reverse
 * operation - **strip every recognised probe and see whether what is left is the approved program** -
 * and it is the reverse operation precisely because it does not trust the forward one.
 *
 * This lives with the compiler rather than with the node, for the same reason the binding walk does:
 * a node holds hashes and compares them, and giving every node a TypeScript compiler in order to
 * decide whether to accept a build would put the whole language toolchain inside the plant.
 *
 * **What counts as a probe is defined here, not by the transformer.** This was written before the
 * transformer existed, and deliberately so - a grammar written to fit whatever a generator happened
 * to emit is not a check. A probe is a call on the reserved receiver below, in one of the recognised
 * shapes, and anything else that mentions the receiver is a refusal rather than something to strip.
 */

/**
 * The reserved receiver every generated probe calls through.
 *
 * Reserved the way `$snapshot` and `$with` are in the library: the shape marks it as belonging to
 * the tooling, so ordinary source cannot collide with it by accident. Source that uses this name for
 * its own purposes cannot be instrumented, which is the correct outcome - the alternative is a strip
 * that removes something the program needed.
 */
export const PROBE_RECEIVER = '__rpcProbe'

/** Which member of the receiver corresponds to which probe kind, and no others are recognised. */
const PROBE_MEMBERS: { readonly [member: string]: { readonly kind: RpcProbeKind; readonly wraps: boolean } } = {
    // Wrapping forms take the observed expression as their second argument and evaluate to it, so
    // stripping is replacing the call with that argument. The expression appears exactly once in the
    // instrumented source, which is what makes "evaluated exactly once, with unchanged results and
    // exception behaviour" a property of the shape rather than a promise about the generator.
    value: { kind: 'value', wraps: true },
    condition: { kind: 'condition', wraps: true },
    // Statement forms stand alone and evaluate to nothing anybody reads, so stripping is deletion.
    statement: { kind: 'statement', wraps: false },
    branch: { kind: 'branch', wraps: false },
    entry: { kind: 'function-entry', wraps: false },
    exit: { kind: 'function-exit', wraps: false },
    // A tracepoint carries a condition and a capture object as further arguments. It is still a
    // standalone statement, so stripping it is still deleting it - and deleting it takes the
    // condition and the capture with it, which is what keeps a conditional probe a probe rather
    // than a branch somebody added to the program.
    tracepoint: { kind: 'breakpoint', wraps: false }
}

export interface RpcStripRefusal {
    readonly fileId: string
    readonly line: number
    readonly why: string
}

export interface RpcDerivativeProof {
    /** Whether the stripped variant is the base program. The one answer the node acts on. */
    readonly equivalent: boolean
    readonly baseSemanticDigest: string
    readonly strippedSemanticDigest: string
    readonly probes: readonly RpcProbeDefinition[]
    /** Why no proof could be attempted at all. Present means the digests below mean nothing. */
    readonly refusal?: RpcStripRefusal
}

/**
 * One project, reused, because a `Project` per call spends a compiler host on every file.
 *
 * No tsconfig and no file system: this parses text that arrived from a build, and a strip that
 * resolved imports would be a strip whose answer depended on what happened to be installed.
 */
const parsing = () => new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ESNext, allowJs: false } })

/**
 * The canonical text of a program, for comparison and nothing else.
 *
 * Reprinted from the parse tree rather than compared as text, because two files that differ only in
 * where the newlines fall are the same program, and a check that called them different would refuse
 * every variant a formatter had touched. **Comments are dropped**: they are not semantics, a probe
 * legitimately arrives with one attached, and a comparison that failed over a generated `// probe
 * p3` would be failing over the annotation rather than the code.
 *
 * The cost of that is real and worth naming: a variant may change a comment and this will not see
 * it. What it exists to catch is a changed *program*, and a comment cannot be one.
 */
const canonicalProgram = (text: string, fileId: string): string => {
    const printed = ts.createSourceFile(fileId, text, ScriptTarget.ESNext, true)
    return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(printed)
}

const spanOf = (node: Node) => {
    const start = node.getSourceFile().getLineAndColumnAtPos(node.getStart())
    const end = node.getSourceFile().getLineAndColumnAtPos(node.getEnd())
    return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column }
}

/** The probe id, which must be a plain string literal: an id computed at runtime names nothing. */
const idOf = (call: Node): string | undefined => {
    if (!Node.isCallExpression(call)) return undefined
    const first = call.getArguments()[0]
    return first && Node.isStringLiteral(first) ? first.getLiteralValue() : undefined
}

/**
 * Remove every recognised probe, or refuse.
 *
 * Refusal rather than best effort, and the distinction is the whole value of the pass. A strip that
 * skipped what it did not recognise would leave that construct in the stripped output, where it
 * would show up as a difference from the base and be reported as *the transformer changed the
 * program* - true, but pointing at the wrong thing. Worse, a strip that removed anything mentioning
 * the receiver would happily delete code somebody wrote.
 */
export const stripProbes = (text: string, fileId: string, semanticRevisionId: string): { readonly stripped: string; readonly probes: readonly RpcProbeDefinition[] } | { readonly refusal: RpcStripRefusal } => {
    const file = parsing().createSourceFile(fileId, text, { overwrite: true })

    // **Pass one reads and does not touch.** Every span is then measured against the variant as it
    // arrived, rather than against a file already half stripped underneath - and a refusal is
    // reached before anything has been removed, so a variant that cannot be proved is also a
    // variant nothing has begun rewriting.
    const probes: RpcProbeDefinition[] = []
    for (const mention of file.getDescendants().filter((node) => Node.isIdentifier(node) && node.getText() === PROBE_RECEIVER)) {
        const line = file.getLineAndColumnAtPos(mention.getStart()).line

        // An import of the receiver is part of the instrumentation, not part of the program.
        if (mention.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration)) continue

        const access = mention.getParent()
        if (!access || !Node.isPropertyAccessExpression(access))
            return { refusal: { fileId, line, why: `${PROBE_RECEIVER} appears on line ${line} other than as a probe call, so nothing here can tell whether removing it would restore the program or damage it` } }
        const member = PROBE_MEMBERS[access.getName()]
        if (!member)
            return {
                refusal: {
                    fileId,
                    line,
                    why: `${PROBE_RECEIVER}.${access.getName()} on line ${line} is not a probe form this version recognises: an unrecognised probe cannot be stripped, and a strip that guessed would be deciding for itself what the program was meant to be`
                }
            }
        const call = access.getParent()
        if (!call || !Node.isCallExpression(call) || call.getExpression() !== access)
            return {
                refusal: {
                    fileId,
                    line,
                    why: `${PROBE_RECEIVER}.${access.getName()} on line ${line} is referred to rather than called, so the value of the reference could reach anywhere and no strip can account for it`
                }
            }
        const probeId = idOf(call)
        if (!probeId)
            return {
                refusal: {
                    fileId,
                    line,
                    why: `the probe on line ${line} does not name itself with a literal id: a probe id computed at runtime cannot be matched against an approved plan, which is the only thing that makes a plan an approval`
                }
            }
        if (member.wraps && !call.getArguments()[1])
            return { refusal: { fileId, line, why: `the ${member.kind} probe on line ${line} wraps nothing: a wrapping probe that lost its expression has already changed what the program computes` } }
        if (!member.wraps) {
            const statement = call.getFirstAncestorByKind(ts.SyntaxKind.ExpressionStatement)
            if (!statement || statement.getExpression() !== call)
                return {
                    refusal: {
                        fileId,
                        line,
                        why: `the ${member.kind} probe on line ${line} is used as a value rather than standing alone, so its result is part of the program and removing it would change one`
                    }
                }
        }

        probes.push({ probeId, semanticRevisionId, fileId, span: spanOf(call), kind: member.kind })
    }

    // **Pass two strips, re-querying every time round.** An edit reparses the file, which leaves the
    // nodes pass one collected unsafe to touch - holding a node across a manipulation is the one
    // thing ts-morph will not forgive. Outermost first, deliberately: replacing a wrapping call with
    // the text of its argument carries any probe nested inside it out intact, to be found on the
    // next pass. Everything here was validated above, so the loop has no refusals left to reach.
    for (;;) {
        const mention = file.getDescendants().find((node) => Node.isIdentifier(node) && node.getText() === PROBE_RECEIVER)
        if (!mention) break
        const importDeclaration = mention.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration)
        if (importDeclaration) {
            importDeclaration.remove()
            continue
        }
        const access = mention.getParentOrThrow()
        const call = access.getParentOrThrow()
        if (!Node.isPropertyAccessExpression(access) || !Node.isCallExpression(call)) break
        if (PROBE_MEMBERS[access.getName()]?.wraps) call.replaceWithText(call.getArguments()[1]!.getText())
        else call.getFirstAncestorByKindOrThrow(ts.SyntaxKind.ExpressionStatement).remove()
    }

    return { stripped: file.getFullText(), probes }
}

/**
 * Whether this variant is the approved source plus probes, with the digests to prove it.
 *
 * Both sides go through the same printer, so the comparison is between programs rather than between
 * two people's formatting. The base is printed too even though nothing was stripped from it - if it
 * were compared raw, every variant would fail on whitespace the printer normalised on one side only.
 */
export const provesDerivative = async (base: string, variant: string, fileId: string, semanticRevisionId: string): Promise<RpcDerivativeProof> => {
    const baseSemanticDigest = await digestText(canonicalProgram(base, fileId))
    const outcome = stripProbes(variant, fileId, semanticRevisionId)
    if ('refusal' in outcome) return { equivalent: false, baseSemanticDigest, strippedSemanticDigest: '', probes: [], refusal: outcome.refusal }
    const strippedSemanticDigest = await digestText(canonicalProgram(outcome.stripped, fileId))
    return { equivalent: baseSemanticDigest === strippedSemanticDigest, baseSemanticDigest, strippedSemanticDigest, probes: outcome.probes }
}
