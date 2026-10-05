# mergesutra-e2e-fixture

A deliberately tiny package: one function (`slugify`), one test file, one npm script.
It exists so MergeSutra's controlled Stage-14 flow can be exercised against a real public
GitHub issue and a real Git repository without touching the production `main` tree.

Run the gate with:

```bash
npm test
```

`src/slugify.js` keeps its current edge-hyphen behaviour on purpose; see issue #8.
