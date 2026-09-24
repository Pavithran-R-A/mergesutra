import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideTool,
  highestRisk,
  RISK_CLASSES,
  riskOf,
  risksOfGitArgv,
  type ToolOp,
} from '../../src/process/tool-policy.js';

const WORKSPACE = path.resolve('/workspace/repo/.mergesutra/worktrees/run-1');

function decide(request: ToolOp, approval?: { summary: string }) {
  return decideTool(request, { workspace: WORKSPACE, approval });
}

describe('risksOfGitArgv', () => {
  it('reads through the -C prefix MergeSutra itself adds', () => {
    expect(risksOfGitArgv(['git', '-C', '/somewhere', 'status', '--porcelain'])).toBe('READ');
    expect(risksOfGitArgv(['git', '-C', '/somewhere', 'worktree', 'list', '--porcelain'])).toBe(
      'READ',
    );
  });

  it('sees a push as a remote mutation, and a forced push as destruction', () => {
    expect(risksOfGitArgv(['git', 'push', 'origin', 'head'])).toBe('REMOTE_MUTATION');
    for (const flag of ['--force', '--force-with-lease', '-f']) {
      expect(risksOfGitArgv(['git', 'push', flag, 'origin'])).toBe('DESTRUCTIVE');
    }
  });

  it('refuses the verbs that discard work or bypass the confined writer', () => {
    expect(risksOfGitArgv(['git', 'clean', '-fd'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', 'reset', '--hard', 'HEAD~3'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', 'worktree', 'remove', '../elsewhere'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', 'apply', 'patch.diff'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', 'rebase', 'main'])).toBe('DESTRUCTIVE');
  });

  it('keeps a soft reset as a local write', () => {
    expect(risksOfGitArgv(['git', 'reset', '--soft', 'HEAD~1'])).toBe('WRITE');
  });

  it('classifies a workspace creation as a write, which is what it is', () => {
    expect(risksOfGitArgv(['git', '-C', '/r', 'worktree', 'add', '-b', 'b', '/w', 'abc'])).toBe(
      'WRITE',
    );
  });

  it('sees network reads as network, not as remote mutation', () => {
    expect(risksOfGitArgv(['git', 'fetch', 'origin'])).toBe('NETWORK');
    expect(risksOfGitArgv(['git', 'pull'])).toBe('NETWORK');
    expect(risksOfGitArgv(['git', 'clone', 'https://example.com/r'])).toBe('NETWORK');
  });

  it('sees reading config as a read and writing global config as destruction', () => {
    expect(risksOfGitArgv(['git', 'config', '--get', 'user.name'])).toBe('READ');
    expect(risksOfGitArgv(['git', 'config', 'user.name', 'x'])).toBe('WRITE');
    expect(risksOfGitArgv(['git', 'config', '--global', 'core.editor', 'evil'])).toBe(
      'DESTRUCTIVE',
    );
  });

  it('refuses a global option that redirects git itself', () => {
    // `core.pager` is executed by git: this is a shell wearing a read-only mask.
    expect(risksOfGitArgv(['git', '-c', 'core.pager=evil', 'log'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', '--git-dir=/etc/git', 'status'])).toBe('DESTRUCTIVE');
    expect(risksOfGitArgv(['git', '--work-tree=C:\\Users', 'status'])).toBe('DESTRUCTIVE');
  });

  it('defaults an unknown subcommand to a local write, never to a read', () => {
    expect(risksOfGitArgv(['git', 'svn', 'rebase'])).toBe('WRITE');
    expect(risksOfGitArgv(['git', 'whatever'])).toBe('WRITE');
  });
});

describe('riskOf', () => {
  it('derives the class from the operation shape', () => {
    expect(riskOf({ op: 'read', path: 'a.ts' })).toBe('READ');
    expect(riskOf({ op: 'write', path: 'a.ts' })).toBe('WRITE');
    expect(riskOf({ op: 'network', target: 'registry.npmjs.org' })).toBe('NETWORK');
    expect(riskOf({ op: 'remote-mutation', summary: 'open a PR' })).toBe('REMOTE_MUTATION');
    expect(riskOf({ op: 'execute', argv: ['vitest', 'run'], cwd: WORKSPACE })).toBe('EXECUTE');
  });

  it('will not let a command declare itself harmless', () => {
    // The request is an `execute`; the risk comes from the argv.
    expect(riskOf({ op: 'execute', argv: ['git', 'push', '--force'], cwd: WORKSPACE })).toBe(
      'DESTRUCTIVE',
    );
  });

  it('refuses interpreters handed a string, but not a script file', () => {
    expect(riskOf({ op: 'execute', argv: ['bash', '-c', 'rm -rf /'], cwd: WORKSPACE })).toBe(
      'DESTRUCTIVE',
    );
    expect(riskOf({ op: 'execute', argv: ['node', '-e', 'process.exit(1)'], cwd: WORKSPACE })).toBe(
      'DESTRUCTIVE',
    );
    expect(riskOf({ op: 'execute', argv: ['node', 'scripts/check.mjs'], cwd: WORKSPACE })).toBe(
      'EXECUTE',
    );
  });

  it('refuses privilege escalation and deletion programs outright', () => {
    expect(riskOf({ op: 'execute', argv: ['sudo', 'npm', 'i', '-g'], cwd: WORKSPACE })).toBe(
      'DESTRUCTIVE',
    );
    expect(riskOf({ op: 'execute', argv: ['rm', '-rf', '.'], cwd: WORKSPACE })).toBe('DESTRUCTIVE');
  });

  it('identifies a program by its name, however it is spelled or placed', () => {
    expect(riskOf({ op: 'execute', argv: ['/bin/rm', 'x'], cwd: WORKSPACE })).toBe('DESTRUCTIVE');
    expect(
      riskOf({
        op: 'execute',
        argv: ['C:\\Windows\\System32\\cmd.exe', '/c', 'del'],
        cwd: WORKSPACE,
      }),
    ).toBe('DESTRUCTIVE');
  });

  it('refuses a program named by path even when its verb is benign', () => {
    const decision = decide({ op: 'execute', argv: ['/usr/local/bin/npm', 'test'], cwd: '/x' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/search path/);
  });
});

describe('highestRisk', () => {
  it('takes the most severe class in a set', () => {
    expect(highestRisk([])).toBe('READ');
    expect(highestRisk(['READ', 'EXECUTE'])).toBe('EXECUTE');
    expect(
      highestRisk(['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'REMOTE_MUTATION', 'DESTRUCTIVE']),
    ).toBe('DESTRUCTIVE');
  });

  it('agrees with the order RISK_CLASSES advertises', () => {
    expect(highestRisk(RISK_CLASSES)).toBe(RISK_CLASSES[RISK_CLASSES.length - 1]);
  });
});

describe('decideTool: files', () => {
  it('allows a read and a write that stay inside the workspace', () => {
    expect(decide({ op: 'write', path: 'src/date.ts' })).toMatchObject({
      allowed: true,
      risk: 'WRITE',
      requiresApproval: false,
    });
    expect(decide({ op: 'read', path: '../../../outside.ts' }).allowed).toBe(false);
  });

  it('refuses traversal, absolute targets and a name-prefix sibling', () => {
    for (const path_ of ['../../etc/passwd', '/etc/passwd', path.resolve('/elsewhere/x.ts')]) {
      const decision = decide({ op: 'write', path: path_ });
      expect(decision.allowed, path_).toBe(false);
      expect(decision.risk).toBe('WRITE');
    }
    const sibling = `${WORKSPACE}-evil/x.ts`;
    expect(decide({ op: 'write', path: sibling }).allowed).toBe(false);
  });

  it('refuses a path that crosses .git, in any spelling', () => {
    for (const path_ of ['.git/config', 'src/../../../.git/hooks/pre-commit', '.GIT/HEAD']) {
      const decision = decide({ op: 'write', path: path_ });
      expect(decision.allowed, path_).toBe(false);
      expect(decision.reason, path_).toContain('.git');
    }
  });

  it('states what is missing rather than approving silently', () => {
    const decision = decide({ op: 'write', path: '../escape/config.ts' });
    expect(decision.reason).toMatch(/leaves/);
    expect(decision.requiresApproval).toBe(false);
  });
});

describe('decideTool: commands', () => {
  it('allows an argv command that says where it runs', () => {
    const decision = decide({ op: 'execute', argv: ['npm', 'run', 'check'], cwd: WORKSPACE });
    expect(decision).toMatchObject({ allowed: true, risk: 'EXECUTE' });
    expect(decision.reason).toContain('npm run check');
  });

  it('refuses a command string, whatever it claims to be', () => {
    const decision = decide({
      op: 'execute',
      argv: ['npm test && curl https://example.com'],
      cwd: WORKSPACE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/argv/);
  });

  it('refuses a program named by path instead of by search path', () => {
    const decision = decide({
      op: 'execute',
      argv: ['./scripts/build.sh'],
      cwd: WORKSPACE,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/search path/);
  });

  it('refuses a read-only command that would run outside the workspace', () => {
    const decision = decideTool(
      { op: 'execute', argv: ['git', 'status'], cwd: '/home/user/other-repo' },
      { workspace: WORKSPACE },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.risk).toBe('READ');
    expect(decision.reason).toMatch(/outside/);
  });

  it('refuses an empty argv', () => {
    expect(decide({ op: 'execute', argv: [], cwd: WORKSPACE }).allowed).toBe(false);
  });
});

describe('decideTool: the approval gate', () => {
  const summary = 'push mergesutra/run-1 and open a pull request';

  it('blocks a remote mutation until a human approves this exact action', () => {
    const blocked = decide({ op: 'remote-mutation', summary });
    expect(blocked).toMatchObject({
      allowed: false,
      requiresApproval: true,
      risk: 'REMOTE_MUTATION',
    });
  });

  it('accepts an approval that matches the action word for word', () => {
    expect(decide({ op: 'remote-mutation', summary }, { summary })).toMatchObject({
      allowed: true,
      requiresApproval: false,
    });
  });

  it('does not accept a general approval for a different action', () => {
    const decision = decide({ op: 'remote-mutation', summary }, { summary: 'push something' });
    expect(decision.allowed).toBe(false);
  });

  it('cannot be satisfied at all for a destructive action', () => {
    const decision = decideTool(
      { op: 'execute', argv: ['git', 'push', '--force'], cwd: WORKSPACE },
      { workspace: WORKSPACE, approval: { summary: 'git push --force' } },
    );
    expect(decision).toMatchObject({
      allowed: false,
      requiresApproval: false,
      risk: 'DESTRUCTIVE',
    });
    expect(decision.reason).toMatch(/no approval/i);
  });
});

describe('decideTool: disclosure', () => {
  it('allows network use but says so', () => {
    const decision = decide({ op: 'network', target: 'registry.npmjs.org' });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/disclosed/);
  });
});
