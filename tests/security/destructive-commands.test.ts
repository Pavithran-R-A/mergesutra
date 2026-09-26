import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The commands this product must never run — checked in its own source.
 *
 * Stage 9 is the first stage that edits a workspace because a model asked it to,
 * so the failure worth guarding is the one that looks like housekeeping: a
 * `git clean -fdx` to "clear scratch", a `git reset --hard` to "start the repair
 * fresh". Both destroy the evidence the run exists to produce — the untracked
 * files a contribution may consist of, and the patch whose identity every receipt
 * names — and both have been requested in this project's sessions in text shaped
 * like a tool result or a system notice. A rule that lives only in a prompt is a
 * hope. This one is a build gate.
 *
 * The scan is about *use*, not mention. MergeSutra names these commands on purpose
 * in two places: the tool policy that files `--force` as DESTRUCTIVE, and the
 * injection scanner that refuses a transcript spelling `rm -rf`. Those lines must
 * not be flagged, and the test below says so explicitly, because a check that
 * cannot tell "refuse this" from "run this" would be loosened the first time it
 * annoyed someone.
 *
 * Nothing here executes what it searches for.
 */

const ROOT = path.join(process.cwd(), 'src');

/** argv or shell text that would run a destructive cleanup or revert. */
const DESTRUCTIVE_USE = [
  /\bgit\s+reset\s+--hard/i,
  /\breset['"]?\s*,\s*['"]--hard/i,
  /\bgit\s+clean\s+(?:-[a-z]*f[a-z]*|-(?:fd|df|dx|fx)[a-z]*)/i,
  /\bclean['"]?\s*,\s*['"]-(?:[a-z]*f[a-z]*d[a-z]*|[a-z]*d[a-z]*f[a-z]*)/i,
  /\brm\s+(?:-rf|-fr|--recursive\s+--force)\b[^\n]*\.mergesutra/i,
] as const;

function flagged(line: string): boolean {
  return DESTRUCTIVE_USE.some((pattern) => pattern.test(line));
}

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('the destructive git commands this product never issues', () => {
  it('recognises each form a cleanup or revert could arrive in', () => {
    const wouldRun = [
      'await run("git", ["reset", "--hard", "HEAD"]);',
      "const argv = ['git', 'clean', '-fdx'];",
      "spawn('git clean -fd .')",
      'execSync(`git reset --hard $(base)`)',
      'rm -rf .mergesutra/runs',
    ];

    for (const line of wouldRun) {
      expect(flagged(line), line).toBe(true);
    }
  });

  it('does not mistake naming a command for running it', () => {
    const refusesInstead = [
      "const FORCEFUL_FLAGS = new Set(['--force', '--force-with-lease', '-f', '--no-verify']);",
      'pattern: /\\bgit\\s+push\\b[\\s\\S]{0,30}--force/i,',
      '* It never stages, commits, cleans, resets or removes anything.',
    ];

    for (const line of refusesInstead) {
      expect(flagged(line), line).toBe(false);
    }
  });

  it('finds no destructive use anywhere in the product source', async () => {
    const files = await sources(ROOT);
    expect(files.length).toBeGreaterThan(50);

    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .forEach((line, index) => {
          if (flagged(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
    }

    expect(hits).toEqual([]);
  });

  it('covers the Stage 9 review and repair path, where an edit is a model’s idea', async () => {
    const files = [
      ...(await sources(path.join(ROOT, 'review'))),
      ...(await sources(path.join(ROOT, 'repair'))),
    ];
    expect(files.length).toBeGreaterThan(4);

    const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

    for (const fragment of ['reset --hard', 'clean -fd', 'clean -fdx', '"clean"', "'clean'"]) {
      expect(text.includes(fragment), fragment).toBe(false);
    }
  });
});
