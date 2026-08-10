import { defineConfig } from 'vitest/config'

// The app's own tests, which the CLI's ava run cannot reach: ava runs `dist/**/*.test.js` compiled
// from `src`, and `web` is bundled by vite and emits no JavaScript for tsc at all. Kept as its own
// config rather than a `test` block in vite.config.ts, so the build configuration does not grow a
// concern that has nothing to do with building.
export default defineConfig({
    root: __dirname,
    test: { include: ['src/**/*.test.ts'] }
})
