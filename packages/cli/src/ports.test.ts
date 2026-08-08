import test from 'ava'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/**
 * No two test files in this package may bind the same port.
 *
 * ava runs test *files* in parallel here - unlike the library package, which sets `concurrency: 1`
 * and cannot collide with itself - so two files binding one port is a race. Whichever loses reports
 * `EADDRINUSE` and fails with an error about a port rather than about the thing it was testing,
 * which reads as flake: it passes alone, passes most of the time in CI, and fails on a loaded
 * machine or whenever file scheduling shifts.
 *
 * This is a guard rather than a repair. The suite has no collisions today; what it lacked was
 * anything to stop one being added, and two were added while building the state and context work -
 * each costing a debugging cycle that this check would have ended in a second. Reading the sources
 * is the point: a runtime port allocator would remove the clash and also remove the ability to say
 * in a test which port it uses, which is worth keeping for anyone reproducing a failure by hand.
 */

const here = dirname(fileURLToPath(import.meta.url))
// Read from src rather than dist: the numbers are written by people, in the files people edit.
const sources = resolve(here, '../src')

/**
 * Ports a file *binds*. Connecting to one is not a clash - it follows a bind that has already
 * happened, and every client in the suite names the port it dials.
 *
 * 1883 is excluded by construction: it is the broker docker-compose starts, which the tests connect
 * to and none of them binds.
 */
const boundPorts = (source: string): Set<number> => {
    const found = new Set<number>()
    for (const match of source.matchAll(/port: (\d{4,5})\b/g)) found.add(Number(match[1]))
    // The CLI's own flag, as a test spawns it: `['--port', '8675']`.
    for (const match of source.matchAll(/'--port',\s*'(\d{4,5})'/g)) found.add(Number(match[1]))
    return found
}

test('no two test files in this package bind the same port', (t) => {
    // This file is excluded because it binds nothing: the port numbers in it are example strings
    // for the check below, and the scanner cannot tell those from a real bind - it found them on
    // the first run, which is a fair demonstration that it is looking properly.
    const files = readdirSync(sources).filter((name) => name.endsWith('.test.ts') && name !== 'ports.test.ts')
    t.true(files.length > 5, 'the scan should be finding the suite, not an empty directory')

    const owners = new Map<number, string[]>()
    for (const file of files) {
        for (const port of boundPorts(readFileSync(join(sources, file), 'utf8'))) {
            const held = owners.get(port) ?? []
            held.push(file)
            owners.set(port, held)
        }
    }

    const clashes = [...owners.entries()]
        .filter(([, held]) => held.length > 1)
        .map(([port, held]) => `${port} is bound by ${held.join(' and ')}`)
        .sort()

    t.deepEqual(clashes, [], `these files race under ava's parallelism:\n  ${clashes.join('\n  ')}`)
})

test('the guard would actually catch a clash, rather than passing because it found nothing', (t) => {
    // A check that cannot fail is a check that reports nothing, which is the failure mode this
    // whole file exists to prevent one layer down.
    t.deepEqual([...boundPorts("new RpcServer({ transports: [{ port: 3995, host: '127.0.0.1' }] })")], [3995])
    t.deepEqual([...boundPorts("mcpClient(3975, ['--port', '8675'])")], [8675], 'the flag form a spawned CLI uses')
    t.is(boundPorts("await client.send('x', { url: 'http://localhost:3995' })").size, 0, 'dialling a port is not binding it')
})
