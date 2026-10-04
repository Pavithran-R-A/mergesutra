import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * `tests/release/` installs the packed artifact from the registry, which is the
     * one suite here that needs the network. It is excluded rather than skipped so
     * that `npm run check` keeps meaning "offline, deterministic, no registry" — the
     * claim its own documentation makes — and it runs on every hosted matrix entry
     * through `npm run test:artifact`, which reads `vitest.release.config.ts`.
     *
     * Naming a directory that no test matched exits 1, so a deleted suite fails the
     * step instead of passing it vacuously.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/release/**'],
    /**
     * A 5-second budget is written for tests that only touch memory. Part of this
     * suite starts real Git processes, and when every core is busy spawning
     * `git` at once a 366ms test can be starved past the limit and report a
     * timeout it did not earn. The budget is raised so that contention cannot
     * masquerade as a failure; it does not soften any assertion, and a gate that
     * genuinely hangs still fails here, as the bounded-runner test proves.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
