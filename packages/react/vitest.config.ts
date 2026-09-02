import { defineConfig } from 'vitest/config'

/**
 * The tests that came with the toolkit, run where the toolkit is.
 *
 * `vitest` rather than `ava` - unlike every other package here - because these modules are React
 * components and the rules underneath them, and the suite that was already testing them came from
 * the console's web build. Moving the code and rewriting its tests at the same time would have been
 * two changes wearing one commit.
 */
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        environment: 'node'
    }
})
