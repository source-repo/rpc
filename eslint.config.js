import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/dist-examples/**',
            '**/node_modules/**',
            '**/src/fixture/**',
            '**/src/generated/**',
            // Another agent's worktree is a checkout of this repository at a different commit. Its
            // half-written code is not this run's to report on, and walking it means one thread's
            // work in progress fails everybody else's lint.
            '.claude/worktrees/**',
            'docs/.vitepress/cache/**',
            'docs/.vitepress/.temp/**'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.node }
        },
        rules: {
            semi: 'off',
            // A leading underscore is the conventional way to say a binding is deliberately unused.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/no-empty-object-type': 'off'
        }
    },
    /**
     * Type-aware, and only for the rules that need to be.
     *
     * A promise nobody awaits and nobody catches is an unhandled rejection, and Node's default is
     * to end the process on one - so a single peer sending a single malformed frame could take down
     * a server answering everybody else. That is not a class of bug worth finding by hand twice,
     * and it is invisible to the untyped config above.
     */
    {
        files: ['packages/*/src/**/*.ts'],
        /**
         * `@source-repo/react`'s tests belong to a project this cannot see.
         *
         * Its components are checked against the library's browser entry and its tests against the
         * Node one - `panel.test.ts` stands up a real RpcServer - so they live in `tsconfig.test.json`
         * and are excluded from `tsconfig.json`. The project service finds the nearest
         * `tsconfig.json` and nothing else, so a typed rule here has no types for them.
         *
         * The console's web tests were never in this block at all, since `packages/cli/web/src` does
         * not match the glob above - so this leaves them treated the same way rather than newly
         * differently, and `tsc -p tsconfig.test.json` still checks both.
         */
        ignores: ['packages/react/src/**/*.test.ts', 'packages/react/src/**/*.test.tsx'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            // Passing an async function where a void-returning one is expected is the same hazard
            // wearing a different hat: every async event listener is one of these.
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }]
        }
    }
)
