# Contributing to MergeSutra

Thanks for your interest! MergeSutra is an open-source CLI agent that turns a
GitHub issue into a reviewable PR draft with traceable evidence for each
acceptance criterion the run's gates could check. This guide covers how to set
up, test, and propose changes.

## Ground rules

- **Evidence over assertion.** A claim that something passed must be backed by
  something that actually ran. Never weaken or comment out a test to make a
  gate pass, and never describe an unverified result as verified.
- **Repository and model text is untrusted.** Never let content from a repo,
  issue, or model output bypass the security policy.
- **Keep the workflow specialized.** Before proposing a feature, ask: *does
  this make "GitHub issue → evidence-backed PR" materially better?* If not, it
  is likely scope creep.
- **No credential leakage.** Secrets never appear in code, fixtures, logs, or
  reports.

## Development setup

```bash
# Requires Node.js >= 22
npm ci
npm run check   # format:check + lint + typecheck + test + build
```

Useful scripts:

| Command                | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run dev -- help`  | Run the CLI from source via `tsx`               |
| `npm run test`         | Run the offline test suite                      |
| `npm run typecheck`    | TypeScript strict check                         |
| `npm run lint`         | ESLint                                          |
| `npm run format`       | Prettier write                                  |
| `npm run build`        | Emit `dist/`                                    |

## Tests

- Tests must **not** depend on the live BharatCode service. External systems
  (BharatCode, GitHub, Git, process execution, filesystem, clock) are injected
  as fakes.
- Add a focused test with every behaviour change, and a security test for any
  change that touches paths, subprocesses, redaction, or model input.

## Proposing changes

1. Open an issue first for anything non-trivial so the Acceptance Contract can
   be agreed before code is written.
2. Keep changes small and coherent, with a clear description of what ran and
   what passed.
3. Ensure `npm run check` is green.

By contributing, you agree your contributions are licensed under the project's
MIT license.
