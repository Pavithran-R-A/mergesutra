import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
