# MergeSutra — judge's quick guide

**Issue in. Evidence-backed PR out.** MergeSutra is a BharatCode-powered command-line agent that converts one GitHub issue into a patch, a record of which requirements were checked, and a human-approved **draft** pull request. It is not a general chat assistant.

**Category:** Coding & developer tools (CLI agent).  
**Competition:** [BharatCode Build League, Round 1](https://bharatcode.ai/hackathon).  
**Source:** [Pavithran-R-A/mergesutra](https://github.com/Pavithran-R-A/mergesutra).  
**Entry status:** A public repository is not proof of an account-linked contest submission. Check the competition site for the actual entry.

## The important difference

Most code agents can make a patch and say tests passed. MergeSutra preserves an *acceptance contract* from the issue and repository policy, then maps each criterion to measured verification evidence. A requirement that no test covers is **not** silently marked complete. A model's claim never turns into a passing test receipt. Before GitHub is asked to open a draft PR, a person must approve the specific digest-bound publication page; publishing is a separate action.

A single run can be inspected through the shipped commands:

\`issue → inspect → contract → plan → implement → verify → report → review → pr\`

\`status\` and \`resume\` expose lifecycle and recovery decisions; \`repair\` is digest-approved and triggers re-verification. The unattended \`run\` command is **not shipped**.

## What you can verify

| Question | Evidence | Precise reading |
| --- | --- | --- |
| Does the source build and install across supported Node versions? | [CI run #41646695271](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41646695271) | Six green jobs on Ubuntu, Windows and macOS × Node 22 and 24 at \`f2e2b08\` (3 Nov 2026) |
| Does the production CLI complete customer journeys? | [Customer workflow run #41640417724](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41640417724) | Eight hosted journeys through the compiled CLI, with a **scripted-model gateway**; verifies workflow, not live-model quality |
| Are commands isolated? | [Docker isolation run #41614337044](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41614337044) | Three green Linux Docker isolation jobs, within the documented image/host/command limits |
| Has BharatCode actually completed a bounded issue-to-patch task? | [Live Qwen run #38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041) | Successful **older** 11 Oct 2026 fixture run at \`b1c18bf\`: 9/12 model requests; independent acceptance passed; **no PR published** |
| Does the present adapter answer at least one real request? | [Live smoke #41393924176](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41393924176) | A bounded single request passed on 2 Nov 2026; this is **not** a full live chain |
| Has the ten-case independent real-task benchmark passed? | [Benchmark protocol and ledger](REAL_TASK_BENCHMARK.md) | **No. 0/10 live-model cases recorded.** Offline fixtures and negative controls exist |

No single row proves everything; each evidence link is scoped to the code revision and test that actually ran.

## See the workflow

- [88-second scripted-model transcript-cut video](assets/merge-sutra-demo-88s.mp4). It contains captured CLI output and a persistent **SCRIPTED-MODEL** label; it is **not** a live-model screen recording.
- [Demo procedure, replay and observed results](DEMO.md). The 21 Oct scripted run used a public [fixture issue](https://github.com/Pavithran-R-A/mergesutra-e2e-fixture/issues/1), passed both verification gates and all five **independent harness** acceptance checks, and left the original clone unchanged.
- [BharatCode live E2E procedure](REAL_MODEL_E2E_PROCEDURE.md). Real-model runs require an operator's own API key, a selected eligible model, a fixed request ceiling and independent acceptance checks.

**Important distinction:** The demo harness's five independent oracle checks passed; the product's own criterion rows correctly required manual review where its execution gates could not prove them. The distinction is intentional.

## Try it without a model key

Prerequisites: Node.js 22 or 24, Git, and a clean source checkout.

\`\`\`bash
git clone https://github.com/Pavithran-R-A/mergesutra.git
cd mergesutra
npm ci
npm run check
npm run verify:package
npm run test:artifact
node dist/bin.js --help
\`\`\`

To replay the full scripted-model demo, also install Docker and \`gh\`, preload the digest-pinned image as documented in [DEMO.md](DEMO.md), then run:

\`\`\`bash
node scripts/demo-scripted-journey.mjs --out /tmp/mergesutra-demo
\`\`\`

For the eight hosted customer journeys, see [the customer-workflow job](https://github.com/Pavithran-R-A/mergesutra/actions/workflows/customer-workflow.yml) and its production CLI harness [source](../scripts/customer-workflow-qualification.mjs). Those tests use a scripted gateway, not a paid API key.

## Trust boundaries and known limits

- Model output is untrusted structured data, checked against schemas and controlled tool policies.
- Repository-owned commands run inside a digest-pinned, network-disabled Linux container with read-only root, non-root user and resource limits; writes are confined to a run-specific Git worktree. See [sandbox qualifications and limitations](SANDBOX_EXECUTION.md).
- Docker support is **measured, not universal**: repository git-native gates have limits, and a macOS Docker host has not been qualified.
- The real BharatCode full-chain success predates the latest \`main\`; a final-revision full live run and ten-class representative reliability benchmark are still missing.
- The \`mergesutra\` npm package and GitHub v0.1.0 release are not published as of this guide's creation. Run from source.
- The CLI never merges or force-pushes. Approval itself does not publish. Only the explicit separate \`pr --publish\` step may create a GitHub **draft** PR.

For every unverified claim, prefer an honest **not yet measured** over a guessed pass. More context: [README](../README.md), [architecture](ARCHITECTURE.md), [submission pack](SUBMISSION.md), [release checklist](RELEASING.md).
