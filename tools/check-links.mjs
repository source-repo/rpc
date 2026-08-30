#!/usr/bin/env node
/**
 * Every internal link in the built site, checked against what was actually built.
 *
 * VitePress has a link checker of its own and this repository turns it off: `ignoreDeadLinks` is
 * set in `docs/.vitepress/config.ts` because the design documents link to working material in
 * `notes/`, which is deliberately not published, and the built-in checker fails the build over
 * those. That is the right trade for those links and it silences every other kind too.
 *
 * What that costs was measured rather than guessed. The first run of this script found eight dead
 * links: five had been introduced hours earlier by putting the changelog on the site - it links
 * `docs/flat-frame-spec.md` repo-relatively, which is correct on GitHub and resolves against the
 * site root once the file is included into a page - and three had been dead long enough that the
 * directory they pointed at had been renamed to kebab-case underneath them. Those three were dead
 * on GitHub as well, which is the case the comment beside `ignoreDeadLinks` assumes cannot happen.
 *
 * So: external links are not checked, because that is a network call that fails for reasons which
 * have nothing to do with this repository. Anchors are not checked either, for now - a `#section`
 * that no longer exists is worth catching, but it needs the heading slugs and this wants to stay
 * something a reader can hold in their head. What is checked is the thing that was actually broken.
 *
 *     node tools/check-links.mjs [dist]
 *
 * Exits non-zero with each broken link and the page it is on.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'docs/.vitepress/dist')

const pages = []
const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.html')) pages.push(path)
    }
}
walk(dist)

if (!pages.length) {
    console.error(`no pages under ${dist} - build the site first with \`npm run docs:build\``)
    process.exit(1)
}

/**
 * The site's base path, read from what it emitted rather than from its configuration.
 *
 * `base` is `/rpc/` here because the site is served from a project page. Taking it from an asset
 * URL in the built HTML means this script does not have to parse a TypeScript config, and cannot
 * disagree with the build about what the base is.
 */
const base = readFileSync(pages[0], 'utf8').match(/(?:href|src)="(\/[^"/]+\/)assets\//)?.[1] ?? '/'

const exists = (path) => {
    for (const candidate of [path, `${path}.html`, join(path, 'index.html')]) {
        try {
            if (statSync(candidate).isFile()) return true
        } catch {
            // Does not exist, which is the question being asked.
        }
    }
    return false
}

const broken = []
let checked = 0

for (const page of pages) {
    const html = readFileSync(page, 'utf8')
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        // Everything this script is not the right tool for.
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue
        const target = href.replace(/&amp;/g, '&').split('#')[0].split('?')[0]
        if (!target) continue
        checked += 1
        const path = target.startsWith('/')
            ? join(dist, target.startsWith(base) ? target.slice(base.length) : target.slice(1))
            : normalize(join(dirname(page), target))
        if (!exists(path)) broken.push({ page: relative(dist, page), href: target })
    }
}

console.log(`${checked} internal links across ${pages.length} pages`)

if (broken.length) {
    console.error(`\n${broken.length} broken:`)
    for (const { page, href } of broken) console.error(`  ${page}  ->  ${href}`)
    console.error('\nA link to material that is deliberately not on the site should be an absolute')
    console.error('GitHub URL, which is what the design documents already use for notes/.')
    process.exit(1)
}

console.log('none broken')
