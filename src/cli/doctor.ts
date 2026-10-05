import { loadBharatCodeConfig, summarizeConfig } from '../config/load-config.js';
import type { BharatCodeClient } from '../bharatcode/client.js';
import type { RenderOptions, Renderer, Status } from './render.js';
import { terminalSafeDocument } from '../security/terminal-safety.js';
import { createRenderer, resolveColor } from './render.js';
import {
  defaultRunner,
  githubReadRunner,
  safeRun,
  type Runner,
  type RunResult,
} from '../core/runner.js';

/**
 * `mergesutra doctor` — environment diagnosis that never prints the API key value.
 *
 * Each check resolves to a truthful PASS / FAIL / WARN / SKIP with a short,
 * actionable detail. Network reachability to BharatCode is opt-in (`connect`)
 * so default diagnosis works offline.
 */

export type { Runner, RunResult };

export interface DoctorCheck {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

export interface DoctorDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly run?: Runner;
  readonly makeClient?: (apiKey: string | undefined) => BharatCodeClient | undefined;
  readonly connect?: boolean;
  readonly nodeVersion?: string;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const env = deps.env;
  const run = deps.run ?? defaultRunner;
  const ghRun = deps.run ?? githubReadRunner;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const checks: DoctorCheck[] = [];

  // Node
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'Node',
    status: nodeMajor >= MIN_NODE_MAJOR ? 'PASS' : 'FAIL',
    detail:
      nodeMajor >= MIN_NODE_MAJOR
        ? `v${nodeVersion}`
        : `v${nodeVersion} (need >= ${MIN_NODE_MAJOR})`,
  });

  // Git
  const git = await safeRun(run, 'git', ['--version']);
  if (git && git.code === 0) {
    checks.push({ name: 'Git', status: 'PASS', detail: firstLine(git.stdout) || 'available' });
  } else {
    checks.push({
      name: 'Git',
      status: 'FAIL',
      detail: 'git not found on PATH — install Git or add it to PATH.',
    });
  }

  // GitHub CLI + auth
  const gh = await safeRun(ghRun, 'gh', ['--version']);
  if (gh && gh.code === 0) {
    checks.push({
      name: 'GitHub CLI',
      status: 'PASS',
      detail: firstLine(gh.stdout) || 'available',
    });
    const auth = await safeRun(ghRun, 'gh', ['auth', 'status']);
    checks.push(
      auth && auth.code === 0
        ? { name: 'GitHub auth', status: 'PASS', detail: 'signed in' }
        : {
            name: 'GitHub auth',
            status: 'WARN',
            detail: 'gh is installed but not authenticated — run: gh auth login',
          },
    );
  } else {
    checks.push({
      name: 'GitHub CLI',
      status: 'WARN',
      detail: 'gh not found — optional for local repos, required for issue-URL intake.',
    });
  }

  // BharatCode configuration (never prints the key)
  const config = loadBharatCodeConfig(env);
  const summary = summarizeConfig(config);
  checks.push(
    summary.configured
      ? {
          name: 'BharatCode key',
          status: 'PASS',
          detail: `configured (source: ${summary.apiKeySource}, base: ${summary.baseUrl})`,
        }
      : {
          name: 'BharatCode key',
          status: 'FAIL',
          detail: 'BHARATCODE_API_KEY is not set.',
        },
  );

  // Reachability (opt-in, and only meaningful with a key)
  if (!deps.connect) {
    checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'pass --connect to test' });
  } else if (!summary.configured || !deps.makeClient) {
    checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'not configured' });
  } else {
    const client = deps.makeClient(config.apiKey);
    if (!client) {
      checks.push({ name: 'BharatCode reach', status: 'SKIP', detail: 'no client' });
    } else {
      const health = await client.healthCheck();
      checks.push(
        health.reachable
          ? {
              name: 'BharatCode reach',
              status: 'PASS',
              detail: `${health.modelCount ?? 0} model(s) listed`,
            }
          : { name: 'BharatCode reach', status: 'FAIL', detail: health.note ?? 'unreachable' },
      );
    }
  }

  return checks;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

export function formatDoctor(input: readonly DoctorCheck[], renderer: Renderer): string {
  // Display copy: a value this command only read may not carry a byte that steers
  // the terminal it is printed on. See src/security/terminal-safety.ts.
  const checks = terminalSafeDocument(input);
  const lines: string[] = [renderer.heading('MergeSutra doctor'), ''];
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const padded = check.name.padEnd(width);
    lines.push(`${renderer.status(check.status)} ${padded}  ${check.detail}`);
  }
  const allPass = checks.every((c) => c.status === 'PASS' || c.status === 'SKIP');
  const hasFail = checks.some((c) => c.status === 'FAIL');
  lines.push('');
  lines.push(
    hasFail
      ? renderer.heading('Not ready. Resolve the FAIL items above.')
      : allPass
        ? renderer.heading('Ready.')
        : renderer.heading('Ready with warnings.'),
  );
  return lines.join('\n');
}

export interface DoctorCommandOptions {
  readonly connect?: boolean;
  readonly noColor?: boolean;
}

/** Entry used by the CLI program. Returns a process exit code. */
export async function doctorAction(
  options: DoctorCommandOptions,
  deps: Partial<DoctorDeps> = {},
  write: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const checks = await runDoctor({
    env: deps.env ?? process.env,
    run: deps.run,
    makeClient: deps.makeClient,
    connect: options.connect,
    nodeVersion: deps.nodeVersion,
  });
  const renderer = createRenderer({ color: resolveColor(options.noColor, process.env) });
  write(formatDoctor(checks, renderer));
  return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
}

export type { RenderOptions };
