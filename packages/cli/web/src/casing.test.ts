import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

/**
 * No two modules whose names differ only in case.
 *
 * A Linux test for a Windows failure, which is the only kind worth having: on a case-insensitive
 * filesystem `./Pager` and `./pager` are one path, and the resolver picks by extension order rather
 * than by the spelling that was written - `.ts` before `.tsx`. It has caught two so far, `Pager.tsx`
 * beside `pager.ts` and `Search.tsx` beside `search.ts`, and both were named that way for the
 * natural reason: a component named after the module it uses.
 *
 * The same guard runs in `@source-repo/react`, over that package's own files. Two copies rather
 * than one shared helper, because a guard that has to be imported from the package it is guarding
 * is a guard with a dependency - and this one has to work in whichever directory it sits in.
 */

const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, '')

test('no two modules differ only in case, which a case-insensitive filesystem cannot tell apart', () => {
    // `fileURLToPath` and not `.pathname`, which is the same trap one layer down: a file URL's
    // pathname is `/D:/a/rpc/...` on Windows, and the leading slash makes Node resolve it against
    // the current drive.
    const here = fileURLToPath(new URL('.', import.meta.url))
    const collisions: string[] = []

    const walk = (directory: string) => {
        const entries = readdirSync(directory, { withFileTypes: true })
        const seen = new Map<string, string>()
        for (const entry of entries) {
            if (entry.isDirectory()) {
                walk(join(directory, entry.name))
                continue
            }
            if (!/\.(ts|tsx)$/.test(entry.name)) continue
            const key = withoutExtension(entry.name).toLowerCase()
            const already = seen.get(key)
            if (already && already !== withoutExtension(entry.name)) collisions.push(`${already} and ${withoutExtension(entry.name)} in ${directory}`)
            else seen.set(key, withoutExtension(entry.name))
        }
    }

    walk(here)
    expect(collisions).toEqual([])
})
