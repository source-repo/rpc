import anyTest, { TestFn } from 'ava'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { canonicalSignedBytesV5 } from './RPC/Signing.js'

/**
 * The bytes a signature covers, computed by both libraries and compared.
 *
 * A signature is only worth something if both ends agree on what was signed, and agreement is not
 * something either side can check alone: each will happily verify its own frames. One escape apart
 * is a frame that verifies nowhere - and the failure looks like a broken key, a clock skew or a
 * broker problem, because nothing in it points at an escape rule.
 *
 * The C# side writes this JSON by hand rather than through System.Text.Json, which escapes more
 * than JavaScript does (`<`, `>`, `&`, `+` and every non-ASCII character), so the cases below are
 * chosen where the two disagree. Writing it by hand is what makes the agreement possible; it is
 * also what makes this test necessary, and it has already caught a real one - a matched surrogate
 * pair signed with its low half escaped, because the loop met that half again on the next turn.
 *
 * Needs the C# TestHost built. Skips loudly without it, and `SOURCE_RPC_REQUIRE_CSHARP_MQTT` turns
 * the skip into a failure, the same bargain the other interop suites make.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const testHostProject = join(repoRoot, 'packages', 'csharp', 'TestHost')
const testHostBuilt = join(testHostProject, 'bin', 'Release', 'net8.0', 'TestHost.dll')

/**
 * The SDK, which is not always on PATH even where it is installed - a shell that exports
 * DOTNET_ROOT and nothing else is the ordinary case on a workstation.
 */
const dotnet = (() => {
    const candidates = [process.env.DOTNET_ROOT && join(process.env.DOTNET_ROOT, 'dotnet'), 'dotnet'].filter(Boolean) as string[]
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 30_000 })
            return candidate
        } catch {
            // Not this one.
        }
    }
    return undefined
})()

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before((t) => {
    const skipped = !dotnet || !existsSync(testHostBuilt)
    if (skipped && process.env.SOURCE_RPC_REQUIRE_CSHARP_MQTT)
        throw new Error(
            dotnet
                ? `SOURCE_RPC_REQUIRE_CSHARP_MQTT is set, but ${testHostBuilt} is not built - these tests must not be skipped here`
                : 'SOURCE_RPC_REQUIRE_CSHARP_MQTT is set, but no runnable dotnet was found on PATH or under DOTNET_ROOT'
        )
    t.context = { skipped }
})

/**
 * The 20 signed fields plus the payload, in the order the canonical form fixes them.
 *
 * Positional rather than named, so the two sides cannot drift on a key spelling - and so renaming
 * an `mr-` property later cannot silently change what verifies.
 */
type Fields = [
    version: string,
    topic: string,
    responseTopic: string,
    source: string,
    kind: string,
    path: string,
    methodOrEvent: string,
    correlation: string,
    contentType: string,
    code: string,
    contractVersion: string,
    ttl: string,
    idempotencyKey: string,
    fence: string,
    deferred: string,
    outcome: string,
    seq: string,
    epoch: string,
    timestamp: string,
    nonce: string,
    payload: string
]

const fromTypeScript = (f: Fields) =>
    Buffer.from(
        canonicalSignedBytesV5({
            version: f[0],
            topic: f[1],
            responseTopic: f[2],
            source: f[3],
            kind: f[4],
            path: f[5],
            methodOrEvent: f[6],
            correlation: f[7],
            contentType: f[8],
            code: f[9],
            contractVersion: f[10],
            ttl: f[11],
            idempotencyKey: f[12],
            fence: f[13],
            deferred: f[14],
            outcome: f[15],
            seq: f[16],
            epoch: f[17],
            timestamp: Number(f[18]),
            nonce: f[19],
            payload: new TextEncoder().encode(f[20])
        })
    ).toString('base64')

/**
 * Fields travel to the C# process as base64 UTF-16 rather than as JSON, because a lone surrogate is
 * one of the cases worth checking and no JSON reader will hand one back.
 */
const fromCSharp = (f: Fields) =>
    execFileSync(dotnet!, ['run', '--project', testHostProject, '-c', 'Release', '--no-build', '--', 'canonical'], {
        input: f.map((value) => Buffer.from(value, 'utf16le').toString('base64')).join(','),
        encoding: 'utf8',
        timeout: 60_000
    }).trim()

const blank = (over: Partial<Record<number, string>>, payload: string): Fields => {
    const f = ['3', 't', 'r', 's', 'call', 'p', 'm', 'c', 'application/json', '', '', '', '', '', '', '', '', '', '1', 'n', payload]
    for (const [at, value] of Object.entries(over)) f[Number(at)] = value!
    return f as Fields
}

const cases: [name: string, fields: Fields][] = [
    ['a whole frame with every field set', [
        '3', 'msgrpc/v2/req/plant', 'msgrpc/v2/rsp/hmi', 'hmi', 'call', 'meter', 'read', 'c-1',
        'application/msgpack', 'Forbidden', '1.2.3', '5000', 'idem-1', 'e-owner', '1', 'resolved', '41', 'e-3f9c',
        '1785187832623', 'nonce+/=', '[1,2]'
    ]],
    ['quotes and backslashes', blank({ 3: 'quote"and\\back' }, '{}')],
    ['the control characters with short forms', blank({ 3: 'ctrl\n\t\r\b\f' }, '')],
    ['a control character with no short form', blank({ 3: 'unit\u0001sep\u001f' }, '')],
    // JavaScript emits all of these literally; System.Text.Json would escape every one.
    ['characters System.Text.Json escapes and JavaScript does not', blank({ 3: 'html <b> & "x" + /slash/' }, 'x')],
    ['non-ASCII, which travels as itself', blank({ 3: 'unicode é 制御 \u{1f39b}' }, 'ünïcödé')],
    ['adjacent surrogate pairs, and one at the end', blank({ 3: '\u{1f39b}\u{1f4a1}x\u{1f39b}' }, 'y')],
    ['a lone high surrogate', blank({ 3: 'high \ud83c end' }, 'y')],
    ['a lone low surrogate', blank({ 3: 'low \udf9b end' }, 'y')],
    ['a trailing lone high surrogate', blank({ 3: 'trailing \ud83c' }, 'y')],
    ['an empty payload, which is a frame with no body', blank({}, '')]
]

for (const [name, fields] of cases) {
    test.serial(`both libraries sign the same bytes: ${name}`, (t) => {
        if (t.context.skipped) {
            t.pass('no dotnet, or the C# TestHost is not built - skipped')
            return
        }
        // Compared as bytes, not as text: two strings that render alike can still be different
        // sequences, and it is the sequence the HMAC runs over.
        t.is(fromCSharp(fields), fromTypeScript(fields))
    })
}
