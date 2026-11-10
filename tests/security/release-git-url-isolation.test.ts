import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnvironment } from '../../scripts/lib/release-identity.mjs';

/**
 * Exercise Git itself, not a mocked response. Git URL rewriting can target an
 * entirely different repository while returning a syntactically valid SHA/ref.
 * This proof is offline: both targets are real local repositories.
 */
describe('npm release Git URL isolation (real Git)', () => {
  it(
    'blocks global, inline and checkout-local rewrites of the trusted ref query',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'mergesutra-git-url-proof-'));
      const clean = path.join(root, 'clean');
      mkdirSync(clean);
      writeFileSync(path.join(clean, 'config'), '', 'utf8');
      const safeEnv = isolatedGitEnvironment(process.env, clean);
      const git = (args: string[], env: NodeJS.ProcessEnv = safeEnv, cwd = clean): string =>
        execFileSync('git', args, {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

      try {
        const approved = path.join(root, 'approved');
        const attacker = path.join(root, 'attacker');
        const makeFixture = (dir: string, message: string): void => {
          mkdirSync(dir);
          git(['init', '-q', '-b', 'main', dir]);
          git([
            '-C',
            dir,
            '-c',
            'user.name=Release Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            message,
          ]);
        };
        makeFixture(approved, 'approved');
        makeFixture(attacker, 'attacker');

        const approvedSha = git(['-C', approved, 'rev-parse', 'HEAD']);
        const attackerSha = git(['-C', attacker, 'rev-parse', 'HEAD']);
        expect(approvedSha).not.toBe(attackerSha);

        const approvedUrl = pathToFileURL(approved).href;
        const attackerUrl = pathToFileURL(attacker).href;
        const readMain = (env: NodeJS.ProcessEnv, cwd = clean): string => {
          const output = git(['ls-remote', '--exit-code', approvedUrl, 'refs/heads/main'], env, cwd);
          return output.split('\t')[0] ?? '';
        };

        expect(readMain(safeEnv)).toBe(approvedSha);

        // A poisoned global config silently redirects an apparently trusted URL.
        const hostileConfig = path.join(root, 'hostile.gitconfig');
        const rewrite = `[url "${attackerUrl}"]\n  insteadOf = ${approvedUrl}\n`;
        writeFileSync(hostileConfig, rewrite, 'utf8');
        expect(readMain({ ...safeEnv, GIT_CONFIG_GLOBAL: hostileConfig })).toBe(attackerSha);

        // The same redirect is injectable without any config file.
        const poisonedInline = {
          ...safeEnv,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${attackerUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: approvedUrl,
        };
        expect(readMain(poisonedInline)).toBe(attackerSha);

        // The source checkout may also carry its own URL rewrite configuration.
        git(['-C', approved, 'config', `url.${attackerUrl}.insteadOf`, approvedUrl]);
        expect(readMain(safeEnv, approved)).toBe(attackerSha);

        // A fresh cwd and explicit, closed environment cannot be redirected.
        const sanitized = isolatedGitEnvironment(
          { ...poisonedInline, GIT_CONFIG_GLOBAL: hostileConfig },
          clean,
        );
        expect(readMain(sanitized, clean)).toBe(approvedSha);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
