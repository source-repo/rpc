import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

/**
 * No two modules whose names differ only in case.
 *
 * This is a Linux test for a Windows failure, which is the only kind worth having: on a
 * case-insensitive filesystem `./Pager` and `./pager` are one path, and the resolver picks by
 * extension order rather than by the spelling that was written - `.ts` before `.tsx`. A component
 * called `Pager.tsx` beside a module called `pager.ts` therefore built perfectly here and failed
 * there with *"Pager is not exported by pager.ts"*, which is a true statement about the wrong file.
 *
 * It cost a red CI run to find and would have cost another the next time somebody named a component
 * after the module it uses - which is a natural thing to do, and is why this guards rather than a
 * comment asking people not to.
 *
 * The extension is dropped before comparing, because that is what a module *specifier* looks like:
 * `./pager` names both `pager.ts` and `Pager.tsx`, and the collision is between what an import can
 * say rather than between what a directory can hold.
 */

const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, '')

test('no two modules differ only in case, which a case-insensitive filesystem cannot tell apart', () => {
    const here = new URL('.', import.meta.url).pathname
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
