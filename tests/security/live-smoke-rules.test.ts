import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'live-smoke-rules.mjs');
const runChild = promisify(execFile);

interface SmokeAnswer {
  text?: string;
  model?: string;
  finishReason?: string | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface HarnessOutput {
  verdicts: Record<string, { status: string | null; reason: string | null }>;
  thrown: Record<string, string>;
  evidence: Record<string, unknown>;
  leakFindings: Record<string, string[]>;
  summaryLines: Record<string, string>;
  budget: Record<string, unknown>;
  messages: { role: string; content: string }[];
  sentinel: string;
  budgetMutability: boolean;
}

const SECRET = 'bc_live_TESTONLY0000000000';

/**
 * A C0 control (or DEL) in a string that is destined for a line-oriented log. Scanned by code
 * point because ESLint refuses a control-character regex literal, which can corrupt the very
 * pattern it is matching.
 */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * The rules behind the one-request smoke live under `scripts/`, which vitest must not bundle —
 * its loader cannot resolve an absolute path containing spaces. Running them in a real Node
 * process is also the point: the hosted job executes this exact module against the real provider,
 * so a test that re-implemented the verdict would prove nothing about what that job reports.
 *
 * Each case below is a planted answer, because the whole reason this smoke exists is that a
 * stream cut at a token limit and a stream that answered can carry the same text. The injected
 * `redact` and `singleLine` are the harness's own, deliberately: what is under test is that the
 * rules route every untrusted string through whatever the caller supplied, not that the
 * product's redactor works (tests/security/redaction.test.ts owns that).
 */
const HARNESS = `
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));

const secret = input.secret;
const redact = (value) => String(value).split(secret).join('[REDACTED]');
const singleLine = (value) => String(value).replace(/[\\r\\n\\u0000-\\u001f]+/g, ' ');

const verdicts = {};
const thrown = {};
const evidence = {};
const summaryLines = {};
for (const [name, entry] of Object.entries(input.cases)) {
  try {
    const verdict = lib.smokeVerdict(entry.answer, {
      elapsedMs: entry.elapsedMs,
      budget: lib.SMOKE_BUDGET,
    });
    verdicts[name] = verdict;
    if (entry.evidence !== false) {
      const built = lib.smokeEvidence({
        answer: entry.answer,
        elapsedMs: entry.elapsedMs,
        verdict,
        requestedModel: entry.requestedModel ?? 'qwen-3.8-27b',
        catalog: entry.catalog ?? { models: 2, contains: true },
        redact,
        singleLine,
        budget: lib.SMOKE_BUDGET,
      });
      evidence[name] = built;
      summaryLines[name] = lib.smokeSummaryLine(built);
    }
  } catch (error) {
    thrown[name] = error instanceof Error ? error.message : String(error);
    verdicts[name] = null;
  }
}

const leakFindings = {};
for (const [name, entries] of Object.entries(input.leakCases)) {
  leakFindings[name] = lib.credentialLeakFindings(entries, secret);
}

const budgetMutability = (() => {
  try {
    lib.SMOKE_BUDGET.maxOutputTokens = 999999;
    return lib.SMOKE_BUDGET.maxOutputTokens === 999999;
  } catch {
    return false;
  }
})();

process.stdout.write(
  JSON.stringify({
    verdicts,
    thrown,
    evidence,
    leakFindings,
    summaryLines,
    budget: { ...lib.SMOKE_BUDGET },
    messages: lib.SMOKE_MESSAGES,
    sentinel: lib.SMOKE_SENTINEL,
    budgetMutability,
  }),
);
`;

const completed = (text: string, extra: Partial<SmokeAnswer> = {}): SmokeAnswer => ({
  text,
  model: 'qwen-3.8-27b',
  finishReason: 'stop',
  usage: { promptTokens: 24, completionTokens: 3, totalTokens: 27 },
  ...extra,
});

const VERDICT_CASES: Record<string, { answer: SmokeAnswer; elapsedMs: number }> = {
  'answered-in-time': { answer: completed('MERGESUTRA-LIVE-SMOKE'), elapsedMs: 4_200 },
  'cut-at-token-limit-while-looking-valid': {
    answer: completed('{"checks":[{"id":"A1","pass', { finishReason: 'max_output_tokens' }),
    elapsedMs: 88_000,
  },
  'no-terminal-event-at-all': {
    answer: { text: 'half a sentence', model: 'qwen-3.8-27b', finishReason: null },
    elapsedMs: 12_000,
  },
  'provider-named-another-stop-word': {
    answer: completed('MERGESUTRA-LIVE-SMOKE', { finishReason: 'length' }),
    elapsedMs: 12_000,
  },
  'completed-but-carried-nothing': {
    answer: completed('   \n  '),
    elapsedMs: 9_000,
  },
  'answered-late': {
    answer: completed('MERGESUTRA-LIVE-SMOKE'),
    elapsedMs: 90_001,
  },
  'elapsed-unknown': {
    answer: completed('MERGESUTRA-LIVE-SMOKE'),
    elapsedMs: null as unknown as number,
  },
  'answer-absent': { answer: null as unknown as SmokeAnswer, elapsedMs: 5_000 },
  'rambling-answer': { answer: completed('x'.repeat(5_000)), elapsedMs: 5_000 },
  'leaked-credential-in-answer-and-model': {
    answer: completed(`here is your key: ${SECRET}`, { model: `prefix-${SECRET}` }),
    elapsedMs: 5_000,
  },
  'forged-finish-reason': {
    answer: completed('{"checks":[{"id":"A1"', {
      finishReason: `max_output_tokens\r\nLIVE_SMOKE: PASS ${SECRET}`,
    }),
    elapsedMs: 5_000,
  },
};

const LEAK_CASES: Record<string, { name: string; text: string }[]> = {
  clean: [
    { name: 'live-smoke-result.json', text: '{"status":"PASS","preview":"MERGESUTRA-LIVE-SMOKE"}' },
  ],
  'raw-key-bytes': [{ name: 'live-smoke-result.json', text: `authorized with ${SECRET} ok` }],
  'other-secret-pattern': [
    { name: 'notes.txt', text: 'a key sk-proj-ABCDEFGHIJ0123456789 appeared in a log' },
  ],
  'short-secret-is-not-a-scan': [
    { name: 'a.json', text: 'abc' },
    { name: 'b.json', text: 'nothing credential-shaped here' },
  ],
  'two-files-one-dirty': [
    { name: 'a.json', text: 'clean' },
    { name: 'b.json', text: SECRET },
  ],
};

let output: HarnessOutput;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'mergesutra-live-smoke-rules-'));
  const payload = path.join(tempDir, 'payload.json');
  await writeFile(
    payload,
    JSON.stringify({ cases: VERDICT_CASES, leakCases: LEAK_CASES, secret: SECRET }),
    'utf8',
  );
  // Run as `node -e` so the child's own argv is the payload and the module, and with only PATH
  // inherited so nothing about this developer's environment can reach the rules under test.
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 32 * 1024 * 1024 },
  );
  output = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('the one-request smoke budget', () => {
  it('is the bounded proposal: one model, one completion, 512 tokens, no reasoning, no retries', () => {
    expect(output.budget).toEqual({
      completionsAsked: 1,
      model: 'qwen-3.8-27b',
      maxOutputTokens: 512,
      temperature: 0,
      enableThinking: false,
      stream: true,
      store: false,
      deadlineMs: 90_000,
      maxRetries: 0,
    });
  });

  it('cannot be widened by whoever holds the module', () => {
    // The hosted job reads these numbers as code. If an assignment could rewrite them in a
    // process, "the budget is in the rules module" would be a claim about a mutable object.
    expect(output.budgetMutability).toBe(false);
  });

  it('asks one fixed question and nothing that varies run to run', () => {
    expect(output.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(output.messages.every((message) => typeof message.content === 'string')).toBe(true);
    expect(output.messages[1]?.content).toContain(output.sentinel);
    expect(output.sentinel).toBe('MERGESUTRA-LIVE-SMOKE');
  });
});

describe('the verdict a smoke reports', () => {
  it('never throws on any planted answer, so a defect surfaces as a finding, not a crash', () => {
    expect(output.thrown).toEqual({});
  });

  it('passes only an answer the provider marked complete, in time, with text in it', () => {
    expect(output.verdicts['answered-in-time']).toEqual({ status: 'PASS', reason: null });
  });

  it('refuses a truncated answer that reads like finished work', () => {
    const verdict = output.verdicts['cut-at-token-limit-while-looking-valid'];
    expect(verdict?.status).toBe('INCOMPLETE');
    expect(verdict?.reason).toContain('max_output_tokens');
    expect(verdict?.reason).toContain('refused without being read');
  });

  it('refuses a stream that carried no terminal event, naming it unknown rather than blank', () => {
    const verdict = output.verdicts['no-terminal-event-at-all'];
    expect(verdict?.status).toBe('INCOMPLETE');
    expect(verdict?.reason).toContain("'unknown'");
  });

  it('does not treat any other stop word as completion', () => {
    expect(output.verdicts['provider-named-another-stop-word']?.status).toBe('INCOMPLETE');
  });

  it('calls a completed answer with no text a failure, not a pass', () => {
    const verdict = output.verdicts['completed-but-carried-nothing'];
    expect(verdict?.status).toBe('FAILED');
    expect(verdict?.reason).toContain('no text');
  });

  it('holds the ceiling even when the answer is good', () => {
    const verdict = output.verdicts['answered-late'];
    expect(verdict?.status).toBe('FAILED');
    expect(verdict?.reason).toContain('90000 ms');
  });

  it('refuses to claim a verdict when it cannot say how long it took', () => {
    expect(output.verdicts['elapsed-unknown']?.status).toBe('FAILED');
    // And the artifact records no latency rather than the zero that `Number(null)` would give.
    const evidence = output.evidence['elapsed-unknown'] as { elapsedMs: unknown };
    expect(evidence.elapsedMs).toBeNull();
  });

  it('survives an answer that is not there at all', () => {
    expect(output.verdicts['answer-absent']?.status).toBe('INCOMPLETE');
    expect(output.verdicts['answer-absent']?.reason).toContain("'unknown'");
  });
});

describe('the artifact a smoke writes', () => {
  it('records the latency and the usage the provider reported', () => {
    const evidence = output.evidence['answered-in-time'] as {
      status: string;
      elapsedMs: number;
      usage: Record<string, number>;
      answer: Record<string, unknown>;
    };
    expect(evidence.status).toBe('PASS');
    expect(evidence.elapsedMs).toBe(4_200);
    expect(evidence.usage).toEqual({ promptTokens: 24, completionTokens: 3, totalTokens: 27 });
    expect(evidence.answer.matchedSentinel).toBe(true);
  });

  it('carries the budget it ran under, so the artifact explains itself', () => {
    const evidence = output.evidence['answered-in-time'] as { budget: Record<string, unknown> };
    expect(evidence.budget).toEqual({
      completionsAsked: 1,
      maxOutputTokens: 512,
      temperature: 0,
      reasoning: 'none',
      stream: true,
      store: false,
      deadlineMs: 90_000,
      maxRetries: 0,
    });
  });

  it('runs every untrusted string through the caller’s redactor and one-line filter', () => {
    const evidence = output.evidence['leaked-credential-in-answer-and-model'] as {
      model: { reported: string };
      answer: { preview: string };
    };
    expect(evidence.model.reported).not.toContain(SECRET);
    expect(evidence.answer.preview).toContain('[REDACTED]');
    expect(hasControlCharacter(evidence.answer.preview), evidence.answer.preview).toBe(false);
  });

  it('refuses a provider finish reason that tries to write its own verdict line', () => {
    const evidence = output.evidence['forged-finish-reason'] as {
      reason: string;
      answer: { finishReason: string };
    };
    expect(evidence.answer.finishReason).not.toContain(SECRET);
    expect(hasControlCharacter(evidence.answer.finishReason), evidence.answer.finishReason).toBe(
      false,
    );
    expect(evidence.reason).not.toContain(SECRET);
    expect(hasControlCharacter(evidence.reason), evidence.reason).toBe(false);

    const lines = (output.summaryLines['forged-finish-reason'] as string).split('\n');
    expect(lines.filter((line) => line.startsWith('LIVE_SMOKE: PASS'))).toEqual([]);
    expect(lines.filter((line) => hasControlCharacter(line))).toEqual([]);
    expect(lines[0]).toBe('LIVE_SMOKE: INCOMPLETE');
  });

  it('keeps a preview bounded, so a rambling answer cannot size the artifact', () => {
    const evidence = output.evidence['rambling-answer'] as {
      answer: { preview: string; characters: number; matchedSentinel: boolean };
    };
    expect(evidence.answer.characters).toBe(5_000);
    expect(evidence.answer.preview.length).toBeLessThanOrEqual(200);
    expect(evidence.answer.matchedSentinel).toBe(false);
  });

  it('says the catalog was read and whether it held the model', () => {
    const evidence = output.evidence['answered-in-time'] as {
      model: { catalogModels: number; catalogContainsRequested: boolean };
    };
    expect(evidence.model).toMatchObject({ catalogModels: 2, catalogContainsRequested: true });
  });

  it('prints a summary line whose first word is the verdict', () => {
    expect(output.summaryLines['answered-in-time']?.split('\n')[0]).toBe('LIVE_SMOKE: PASS');
    expect(output.summaryLines['answered-in-time']).toContain('LIVE_SMOKE_LATENCY_MS: 4200');
    expect(output.summaryLines['answered-late']).toContain('LIVE_SMOKE: FAILED');
    expect(output.summaryLines['cut-at-token-limit-while-looking-valid']).toContain(
      'LIVE_SMOKE: INCOMPLETE',
    );
  });
});

describe('the credential scan over the artifact', () => {
  it('accepts a clean file', () => {
    expect(output.leakFindings.clean).toEqual([]);
  });

  it('catches the configured key as raw bytes, not only as a pattern', () => {
    expect(output.leakFindings['raw-key-bytes']).toEqual([
      'live-smoke-result.json: the configured key appears in it as raw bytes',
    ]);
  });

  it('catches a credential-shaped string it has never seen before', () => {
    expect(output.leakFindings['other-secret-pattern']?.[0]).toContain('credential-shaped');
  });

  it('names the file that is dirty and leaves the clean one alone', () => {
    expect(output.leakFindings['two-files-one-dirty']).toEqual([
      'b.json: the configured key appears in it as raw bytes',
    ]);
  });

  it('does not invent a finding out of ordinary text', () => {
    expect(output.leakFindings['short-secret-is-not-a-scan']).toEqual([]);
  });
});
