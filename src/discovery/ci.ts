import type { RepoReader } from './repo-fs.js';

/**
 * What CI already runs — the closest thing a repository has to a proof of its
 * own requirements.
 *
 * A workflow file is YAML, and YAML has anchors, aliases, merges and matrix
 * expansion that a line scanner cannot resolve. Rather than pretend, this
 * reader extracts the two constructs that actually carry the information
 * MergeSutra needs (`run:` steps and `uses:` actions), and reports
 * `coverage: 'partial'` with a reason whenever a file uses a construct it did
 * not resolve. A later stage may then propose running a command, but it can
 * never claim CI requires one it could not read.
 */

export interface CiCommand {
  readonly workflow: string;
  readonly line: number;
  readonly command: string;
}

export interface CiAction {
  readonly workflow: string;
  readonly uses: string;
}

export interface CiFacts {
  readonly provider: 'github-actions' | 'none';
  readonly workflows: readonly { path: string; jobs: readonly string[] }[];
  readonly commands: readonly CiCommand[];
  readonly actions: readonly CiAction[];
  /** 'full' means every workflow was line-scannable without unresolved YAML. */
  readonly coverage: 'full' | 'partial';
  readonly caveats: readonly string[];
}

const WORKFLOW_LIMIT = 20;

/**
 * YAML constructs this scanner does not resolve. Each one is a reason to report
 * partial coverage rather than claim a complete reading.
 */
const UNRESOLVED_YAML: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'anchors', pattern: /(?:^|[\s[,&{])&[\w-]+(?:\s|$|[\],}])/m },
  { label: 'aliases', pattern: /(?:^|[\s:,-])\*[\w-]+(?:\s|$|[\],}])/m },
  { label: 'merge keys', pattern: /<<\s*:/ },
  { label: 'a matrix', pattern: /\bmatrix\b/ },
];

export async function detectCi(reader: RepoReader): Promise<CiFacts> {
  const files = (await reader.walk('.github/workflows', 1, WORKFLOW_LIMIT)).filter((f) =>
    /\.(ya?ml)$/.test(f),
  );
  if (files.length === 0) {
    return {
      provider: 'none',
      workflows: [],
      commands: [],
      actions: [],
      coverage: 'full',
      caveats: ['no GitHub Actions workflow found at .github/workflows'],
    };
  }

  const commands: CiCommand[] = [];
  const actions: CiAction[] = [];
  const workflows: { path: string; jobs: string[] }[] = [];
  const caveats: string[] = [];
  let coverage: CiFacts['coverage'] = 'full';

  for (const file of files) {
    const read = await reader.readText(file, 48 * 1024);
    if (!read) {
      caveats.push(`${file}: listed but could not be read`);
      coverage = 'partial';
      continue;
    }
    if (read.truncated) {
      caveats.push(`${file}: larger than the read limit, only the first part was scanned`);
      coverage = 'partial';
    }
    const unresolved = UNRESOLVED_YAML.filter((construct) => construct.pattern.test(read.text)).map(
      (construct) => construct.label,
    );
    if (unresolved.length > 0) {
      caveats.push(
        `${file}: uses ${unresolved.join(', ')} in YAML, which MergeSutra does not expand`,
      );
      coverage = 'partial';
    }
    const jobs: string[] = [];
    const lines = read.text.split(/\r?\n/);
    let blockIndent = -1;
    lines.forEach((line, index) => {
      const jobName = /^ {2}(\w[\w.-]*):\s*(?:#.*)?$/.exec(line);
      if (jobName) jobs.push(jobName[1] ?? '');
      const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
      if (run) {
        const inline = (run[2] ?? '').trim();
        if (inline.length > 0 && !/^[|>][-+]?$/.test(inline)) {
          commands.push({ workflow: file, line: index + 1, command: inline.slice(0, 300) });
        } else {
          blockIndent = (run[1] ?? '').length;
        }
        return;
      }
      if (blockIndent >= 0) {
        const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
        const body = line.trim();
        if (body.length > 0 && indent > blockIndent) {
          commands.push({ workflow: file, line: index + 1, command: body.slice(0, 300) });
          return;
        }
        blockIndent = -1;
      }
      const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      if (uses?.[1]) actions.push({ workflow: file, uses: uses[1] });
    });
    workflows.push({ path: file, jobs });
  }

  return {
    provider: 'github-actions',
    workflows: workflows.map((w) => ({ path: w.path, jobs: w.jobs })),
    commands: dedupe(commands),
    actions,
    coverage,
    caveats,
  };
}

function dedupe(commands: CiCommand[]): CiCommand[] {
  const seen = new Set<string>();
  const out: CiCommand[] = [];
  for (const command of commands) {
    const key = `${command.workflow}:${command.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}
