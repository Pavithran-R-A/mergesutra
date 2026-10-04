import { defineConfig } from 'vitest/config';

/**
 * The release-boundary suite: pack, install the tarball into an empty directory, run
 * the command. It is separated from `vitest.config.ts` because it is the only suite in
 * this repository that contacts the registry, and `npm run check` documents itself as
 * the offline gate. CI runs it on every matrix entry through `npm run test:artifact`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/release/**/*.test.ts'],
    /**
     * The budget is for one network operation — npm resolving and fetching this
     * package's two runtime dependencies — not for a slow assertion, so only the
     * `beforeAll` hook needs more than the main suite's 30 seconds. Measured on this
     * checkout (Windows, Node 24, warm npm cache): slowest single test 3.4s, whole file
     * 27.8s, of which pack plus install is about 10s in the hook. The hook budget is
     * roughly eighteen times that, for a cold cache and registry latency on a hosted
     * runner; the measurement and its date are recorded under S13-2 in
     * `docs/SECURITY_GAP_REGISTER.md`. A hung install still fails here.
     */
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
