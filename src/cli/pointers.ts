/**
 * Pointers a reader can follow, composed from the repository the manifest publishes.
 *
 * These live beside the screens that print them rather than in `src/version.ts`,
 * because the read-only half of recovery imports that module and `status`/`resume` owe
 * no network: `tests/lifecycle/source-shape.test.ts` reads a URL literal anywhere in
 * that closure as an endpoint, and it is right to. Nothing here is fetched — the CLI
 * never opens these strings, it prints them.
 *
 * `blob/HEAD` rather than `blob/main` so a link survives a default-branch change; the
 * form was measured against a public repository before it was written down.
 * `shipped-pointer-boundary.test.ts` pins the value against `package.json`'s
 * `repository.url`, so moving the project stays one deliberate edit.
 */
export const REPOSITORY_URL = 'https://github.com/Pavithran-R-A/mergesutra';

export const ROADMAP_URL = `${REPOSITORY_URL}/blob/HEAD/docs/ROADMAP.md`;
