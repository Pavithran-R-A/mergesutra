import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  credentialLeakFindings,
  SMOKE_BUDGET,
  SMOKE_MESSAGES,
  smokeEvidence,
  smokeSummaryLine,
  smokeVerdict,
} from './lib/live-smoke-rules.mjs';

/**
 * One bounded request against the real BharatCode route.
 *
 * This is the smallest live test that can still answer the question the offline suite cannot:
 * does the production adapter, on the production endpoint, receive a genuine `response.completed`
 * and read it back as an answer? It uses the same `createBharatCodeClient` the product runs, so a
 * pass is a reading of that code and not of a second implementation written for the workflow.
 *
 * The budget lives in `scripts/lib/live-smoke-rules.mjs`, which the offline tests and the hosted
 * job both read, so the figures in the operator's proposal are the figures in the artifact.
 *
 * Nothing here runs a repository command: no plan, no implement, no verify, no `gh`, no `git`, no
 * shell. The only outbound calls are one authenticated catalog read and one completion.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { PASS: 0, INCOMPLETE: 3, FAILED: 4, CONFIG: 78, NOT_IN_CATALOG: 79 };
const DEFAULT_EVIDENCE_DIR = path.join(ROOT, '.mergesutra', 'live-smoke-export');

const apiKey = process.env.BHARATCODE_API_KEY ?? '';
// The model is a bound, not a preference: it is chosen here so a dispatch cannot widen it, and the
// environment variable is only allowed to confirm it.
const requestedModel = SMOKE_BUDGET.model;
const modelChoice = (process.env.BHARATCODE_MODEL ?? '').trim();
const evidenceDir = path.resolve(process.env.MERGESUTRA_LIVE_SMOKE_DIR ?? DEFAULT_EVIDENCE_DIR);

function log(lines) {
  process.stdout.write(`${lines}\n`);
}

function refuse(status, message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = status;
}

/**
 * A failure described without trusting it.
 *
 * `kind`, `status` and `message` are read through guards because the object may come from
 * underneath `fetch`, whose rejections are somebody else's values: asking a throwing getter what
 * it is would replace the failure being reported with the trap's own message.
 */
function describeFailure(error) {
  const read = (getter) => {
    try {
      return getter();
    } catch {
      return undefined;
    }
  };
  const kind = read(() => error?.kind);
  const status = read(() => error?.status);
  const message = read(() => error?.message) ?? read(() => String(error));
  return [
    typeof kind === 'string' ? `kind=${kind}` : 'kind=(unreadable)',
    typeof status === 'number' ? `http=${String(status)}` : 'http=(none)',
    typeof message === 'string' && message.length > 0 ? message.slice(0, 400) : '(no message)',
  ].join(' ');
}

async function loadProductionAdapter() {
  const clientModule = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'bharatcode', 'client.js')).href
  );
  const redactionModule = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'security', 'redaction.js')).href
  );
  const terminalModule = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'security', 'terminal-safety.js')).href
  );
  return {
    createBharatCodeClient: clientModule.createBharatCodeClient,
    requireApiKey: clientModule.requireApiKey,
    Redactor: redactionModule.Redactor,
    terminalSafeSingleLine: terminalModule.terminalSafeSingleLine,
  };
}

async function writeEvidence(evidence) {
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, 'live-smoke-result.json');
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return file;
}

/**
 * Read back what the run left on disk and refuse it if a credential survived.
 *
 * The scan is of the bytes that exist, not of the object that was handed to the writer: a
 * serialization step that re-attaches something the in-memory form lacked is exactly what this
 * catches. On a hit every artifact file this run owns is removed, so the workflow's upload step
 * has nothing dirty to publish.
 */
async function auditEvidence(secret) {
  const names = (await readdir(evidenceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const entries = [];
  for (const name of names) {
    entries.push({ name, text: await readFile(path.join(evidenceDir, name), 'utf8') });
  }
  const findings = credentialLeakFindings(entries, secret);
  if (findings.length === 0) return { removed: 0, findings };
  for (const entry of entries) {
    await rm(path.join(evidenceDir, entry.name), { force: true }).catch(() => undefined);
  }
  return { removed: entries.length, findings };
}

async function main() {
  const adapter = await loadProductionAdapter();
  const redactor = new adapter.Redactor([apiKey]);
  const safe = (value) => adapter.terminalSafeSingleLine(redactor.text(String(value ?? '')));

  // The product's own wording for a missing credential, so a reader of this job and a reader of
  // `mergesutra doctor` are told the same thing.
  adapter.requireApiKey(apiKey.length > 0 ? apiKey : undefined);
  if (modelChoice.length > 0 && modelChoice !== requestedModel) {
    refuse(
      EXIT.CONFIG,
      `LIVE_SMOKE: CONFIG — BHARATCODE_MODEL asks for '${safe(modelChoice)}', and this smoke only ` +
        `runs the model frozen in its budget ('${requestedModel}'). No request was sent.`,
    );
    return;
  }

  const client = adapter.createBharatCodeClient({
    config: {
      apiKey,
      model: requestedModel,
      timeoutMs: SMOKE_BUDGET.deadlineMs,
      retry: { maxRetries: SMOKE_BUDGET.maxRetries, baseDelayMs: 0, maxDelayMs: 0 },
    },
    redactor,
  });

  log(
    [
      'LIVE_SMOKE: START',
      `LIVE_SMOKE_MODEL: ${safe(requestedModel)}`,
      `LIVE_SMOKE_BUDGET: completions=${String(SMOKE_BUDGET.completionsAsked)} ` +
        `max_output_tokens=${String(SMOKE_BUDGET.maxOutputTokens)} temperature=${String(
          SMOKE_BUDGET.temperature,
        )} reasoning=${SMOKE_BUDGET.enableThinking === false ? 'none' : 'default'} ` +
        `stream=${String(SMOKE_BUDGET.stream)} store=${String(SMOKE_BUDGET.store)} ` +
        `retries=${String(SMOKE_BUDGET.maxRetries)} deadline_ms=${String(SMOKE_BUDGET.deadlineMs)}`,
    ].join('\n'),
  );

  // One clock for the whole credentialed phase. The catalog read is not handed this signal — it is
  // bounded by the client's own per-request budget, which is the same figure — so time spent
  // listing models is time taken from the completion rather than added to it, and the signal below
  // is what keeps the completion from running past the ceiling.
  const signal = globalThis.AbortSignal.timeout(SMOKE_BUDGET.deadlineMs);
  let catalog;
  try {
    catalog = await client.listModels();
  } catch (error) {
    refuse(
      EXIT.FAILED,
      `LIVE_SMOKE: FAILED — the authenticated catalog read failed: ${safe(describeFailure(error))}`,
    );
    return;
  }
  const ids = (catalog?.models ?? []).map((model) => model?.id);
  if (!ids.includes(requestedModel)) {
    refuse(
      EXIT.NOT_IN_CATALOG,
      `LIVE_SMOKE: NOT_IN_CATALOG — '${safe(requestedModel)}' is not in the authenticated catalog ` +
        `(${String(ids.length)} models listed). No completion request was sent.`,
    );
    return;
  }
  log(`LIVE_SMOKE_CATALOG: models=${String(ids.length)} contains_requested=yes`);

  const phaseStartedAt = Date.now();
  let answer = null;
  let failure = null;
  let elapsedMs = 0;
  try {
    answer = await client.complete({
      messages: SMOKE_MESSAGES,
      model: requestedModel,
      temperature: SMOKE_BUDGET.temperature,
      maxTokens: SMOKE_BUDGET.maxOutputTokens,
      enableThinking: SMOKE_BUDGET.enableThinking,
      signal,
    });
    elapsedMs = Date.now() - phaseStartedAt;
  } catch (error) {
    elapsedMs = Date.now() - phaseStartedAt;
    failure = describeFailure(error);
  }

  const catalogSeen = { models: ids.length, contains: true };
  const verdict = failure
    ? { status: 'FAILED', reason: failure }
    : smokeVerdict(answer, { elapsedMs, budget: SMOKE_BUDGET });
  const evidence = smokeEvidence({
    answer,
    elapsedMs,
    verdict,
    requestedModel,
    catalog: catalogSeen,
    redact: (value) => redactor.text(String(value ?? '')),
    singleLine: (value) => adapter.terminalSafeSingleLine(String(value ?? '')),
    budget: SMOKE_BUDGET,
  });

  const file = await writeEvidence(evidence);
  const audit = await auditEvidence(apiKey);
  log(
    [
      smokeSummaryLine(evidence),
      `LIVE_SMOKE_EVIDENCE: ${path.relative(ROOT, file).split(path.sep).join('/')}`,
      `LIVE_SMOKE_ARTIFACT_AUDIT: ${
        audit.findings.length === 0
          ? 'clean'
          : `refused (${String(audit.findings.length)} finding(s), ${String(audit.removed)} file(s) removed)`
      }`,
    ].join('\n'),
  );

  if (audit.findings.length > 0) {
    refuse(EXIT.FAILED, `LIVE_SMOKE: FAILED — ${audit.findings.join('; ')}`);
    return;
  }
  if (verdict.status === 'PASS') {
    process.exitCode = EXIT.PASS;
    return;
  }
  process.exitCode = verdict.status === 'INCOMPLETE' ? EXIT.INCOMPLETE : EXIT.FAILED;
}

try {
  await main();
} catch (error) {
  // Reaching here means the harness itself failed — a missing build, an unwritable artifact
  // directory — which is not evidence about the provider, so it never prints a verdict word.
  process.stderr.write(`LIVE_SMOKE_SETUP_FAILURE: ${describeFailure(error).slice(0, 400)}\n`);
  process.exitCode = EXIT.CONFIG;
}
