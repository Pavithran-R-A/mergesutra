# Stage 14 live-model fixture

This directory is a deliberately tiny task surface inside MergeSutra's default branch.
It exists only for the controlled real-model validation described in
`docs/REAL_MODEL_E2E_PROCEDURE.md`.

The baseline intentionally keeps edge hyphens. Issue #8 asks the validation run to
fix that behavior without adding dependencies.

Run the fixture's own check with:

```bash
node fixtures/stage14-e2e/check.mjs
```
