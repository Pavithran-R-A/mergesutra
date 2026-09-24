import { describe, expect, it } from 'vitest';
import {
  GATE_KINDS,
  buildRepositoryContract,
  gatesEnforced,
  parseRepositoryContract,
  runsGate,
  type BuildContractInput,
  type RepositoryContract,
} from '../../src/discovery/contract.js';
import type { CiCommand, CiFacts } from '../../src/discovery/ci.js';
import type { DeclaredScript, ManifestFacts } from '../../src/discovery/manifests.js';
import type { ContributionDocFact, ProtectedAreasFact } from '../../src/discovery/policy.js';

/**
 * The contract is the document a reviewer trusts later stages to honour, so the
 * bar for every line in it is "which file says so?". These tests are mostly
 * about the two ways that bar gets lowered by accident: promoting a MergeSutra
 * preference into a repository requirement, and quietly ignoring a CI step this
 * scanner could not classify.
 */

const WORKFLOW = '.github/workflows/ci.yml';

function manifests(overrides: Partial<ManifestFacts> = {}): ManifestFacts {
  return {
    ecosystem: 'node',
    ecosystemSources: [{ file: 'package.json', detail: 'package.json exists' }],
    packageManager: {
      name: 'npm',
      source: { file: 'package-lock.json', detail: 'package-lock.json exists' },
    },
    runtimeVersion: null,
    scripts: [],
    lockfiles: ['package-lock.json'],
    unreadable: [],
    ...overrides,
  };
}

function script(name: string, command: string): DeclaredScript {
  return { name, command, source: { file: 'package.json', detail: `scripts.${name}` } };
}

function ci(overrides: Partial<CiFacts> = {}): CiFacts {
  return {
    provider: 'github-actions',
    workflows: [{ path: WORKFLOW, jobs: ['checks'] }],
    commands: [],
    actions: [],
    coverage: 'full',
    caveats: [],
    ...overrides,
  };
}

function cmd(command: string, line = 8): CiCommand {
  return { workflow: WORKFLOW, line, command };
}

const DECLARED_AREAS: ProtectedAreasFact = {
  declaredIn: 'CODEOWNERS',
  status: 'declared',
  entryCount: 2,
  samplePaths: ['src/', 'docs/'],
};

const DOC: ContributionDocFact = {
  path: 'CONTRIBUTING.md',
  status: 'read',
  bytes: 512,
  truncated: false,
  instructionLikeRules: [],
};

function build(input: Partial<BuildContractInput> = {}): RepositoryContract {
  return buildRepositoryContract({
    manifests: manifests(),
    ci: ci(),
    protectedAreas: DECLARED_AREAS,
    contributionDocs: [DOC],
    ...input,
  });
}

function gate(contract: RepositoryContract, kind: (typeof GATE_KINDS)[number]) {
  const found = contract.gates.find((g) => g.kind === kind);
  if (!found) throw new Error(`no gate row for ${kind}`);
  return found;
}

describe('buildRepositoryContract — gate status', () => {
  it('calls a gate required only when CI runs a script the repository declares', () => {
    const contract = build({
      manifests: manifests({ scripts: [script('lint', 'eslint src/')] }),
      ci: ci({ commands: [cmd('npm run lint', 12)] }),
    });
    expect(gate(contract, 'lint')).toMatchObject({
      status: 'REPOSITORY_REQUIRED',
      source: 'REPOSITORY_REQUIRED',
      command: 'eslint src/',
      provenance: {
        file: WORKFLOW,
        detail: `${WORKFLOW}:12 runs it; package.json:scripts.lint declares it`,
      },
      why: "CI executes the 'lint' the repository declares",
    });
  });

  it('reports a declared script no CI step runs as DECLARED_ONLY, not as a requirement', () => {
    const contract = build({
      manifests: manifests({ scripts: [script('format:check', 'prettier --check .')] }),
    });
    const row = gate(contract, 'format');
    expect(row.status).toBe('DECLARED_ONLY');
    expect(row.source).toBe('OPTIONAL');
    expect(row.command).toBe('prettier --check .');
    expect(row.provenance).toEqual({
      file: 'package.json',
      detail: 'scripts.format:check',
      line: null,
    });
    expect(row.why).toContain('no CI step was found that runs it');
  });

  it('says nothing is declared when neither the manifest nor CI mentions a gate', () => {
    const row = gate(build(), 'typecheck');
    expect(row).toMatchObject({
      status: 'NOT_DECLARED',
      source: 'OPTIONAL',
      command: null,
      provenance: null,
    });
    expect(row.why).toBe('nothing in the manifests or CI declares this gate');
  });

  it('accepts CI that invokes the tool directly, citing the workflow line', () => {
    const contract = build({ ci: ci({ commands: [cmd('npx eslint .', 9)] }) });
    expect(gate(contract, 'lint')).toMatchObject({
      status: 'REPOSITORY_REQUIRED',
      command: 'npx eslint .',
      provenance: { file: WORKFLOW, detail: 'line 9' },
      why: 'CI runs a command that performs this gate',
    });
  });

  it('marks every gate a composite CI script runs as required', () => {
    // The shape most real repositories actually use: one CI step, one script
    // that runs the rest. Reporting "0 required gates" here would be a lie.
    const contract = build({
      manifests: manifests({
        scripts: [
          script(
            'check',
            'npm run format:check && npm run lint && npm run typecheck && npm run test',
          ),
          script('format:check', 'prettier --check .'),
          script('lint', 'eslint .'),
          script('typecheck', 'tsc -p tsconfig.json --noEmit'),
          script('test', 'vitest run'),
          script('build', 'tsc -p tsconfig.build.json'),
        ],
      }),
      ci: ci({ commands: [cmd('npm ci', 7), cmd('npm run check', 8)] }),
    });
    for (const kind of ['format', 'lint', 'typecheck', 'test'] as const) {
      expect(gate(contract, kind).status).toBe('REPOSITORY_REQUIRED');
    }
    expect(gate(contract, 'build').status).toBe('DECLARED_ONLY');
    expect(gate(contract, 'lint')).toMatchObject({
      command: 'eslint .',
      why: `CI runs 'check', which reaches the 'lint' this gate needs`,
    });
    expect(gate(contract, 'lint').provenance?.detail).toContain(`runs 'npm run check'`);
    // An install step is not an unexplained requirement.
    expect(contract.limitations.join(' ')).not.toContain('could not classify');
  });

  it('never names a write-capable script as the gate a check needs', () => {
    // Stage 4 will run what this row says. `prettier --write .` would edit the
    // user's checkout, so the read-only spelling has to win wherever both exist.
    const both = manifests({
      scripts: [
        script('format', 'prettier --write .'),
        script('format:check', 'prettier --check .'),
      ],
    });
    expect(gate(build({ manifests: both }), 'format').command).toBe('prettier --check .');

    const contract = build({
      manifests: manifests({
        scripts: [
          script('format', 'prettier --write .'),
          script('format:check', 'prettier --check .'),
          script('check', 'npm run format:check'),
        ],
      }),
      ci: ci({ commands: [cmd('npm run check', 8)] }),
    });
    const format = gate(contract, 'format');
    expect(format.status).toBe('REPOSITORY_REQUIRED');
    expect(format.command).toBe('prettier --check .');
    expect(format.why).toBe(`CI runs 'check', which reaches the 'format:check' this gate needs`);
  });

  it('never adds a gate MergeSutra merely prefers', () => {
    const contract = build();
    expect(contract.gates.map((g) => g.kind)).toEqual([...GATE_KINDS]);
    expect(contract.gates.some((g) => g.source === 'MERGESUTRA_ADDITIONAL')).toBe(false);
    expect(contract.limitations.join(' ')).toContain('MergeSutra adds no requirement of its own');
  });

  it('does not guess a gate from a command it cannot read', () => {
    const contract = build({
      manifests: manifests({ scripts: [script('verify', 'node tools/verify.js')] }),
      ci: ci({ commands: [cmd('npm run verify', 10)] }),
    });
    // `verify` names no recognised tool and no script for a gate, so no gate
    // claims it — and the contract has to admit the step is unexplained.
    for (const kind of GATE_KINDS) {
      expect(gate(contract, kind).status).toBe('NOT_DECLARED');
    }
    expect(contract.limitations.join(' ')).toContain(
      `CI runs 1 step(s) this contract could not classify as a gate: 'npm run verify' (${WORKFLOW}:10).`,
    );
    expect(contract.limitations.join(' ')).toContain('may enforce requirements not listed here');
  });

  it('counts every unexplained CI step instead of hiding the rest', () => {
    const contract = build({
      ci: ci({
        commands: [
          cmd('node tools/one.js', 10),
          cmd('node tools/two.js', 11),
          cmd('node tools/three.js', 12),
          cmd('node tools/four.js', 13),
        ],
      }),
    });
    const line = contract.limitations.filter((l) => l.includes('could not classify'));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('CI runs 4 step(s)');
    expect(line[0]).toContain(', and more');
    expect(line[0]).not.toContain('four.js');
  });

  it('does not call a setup step an unexplained requirement', () => {
    const contract = build({ ci: ci({ commands: [cmd('npm ci', 7)] }) });
    expect(contract.limitations.join(' ')).not.toContain('could not classify');
    expect(contract.ci.observedCommandCount).toBe(1);
  });
});

describe('buildRepositoryContract — what it carries forward', () => {
  it('keeps the toolchain facts together with the file each came from', () => {
    const contract = build({
      manifests: manifests({
        runtimeVersion: { value: '22.14.0', source: { file: '.nvmrc', detail: '.nvmrc' } },
      }),
    });
    expect(contract.ecosystem).toBe('node');
    expect(contract.packageManager).toEqual({
      name: 'npm',
      source: { file: 'package-lock.json', detail: 'package-lock.json exists' },
    });
    expect(contract.runtimeVersion).toEqual({
      value: '22.14.0',
      source: { file: '.nvmrc', detail: '.nvmrc' },
    });
  });

  it('records CI coverage and command count without copying every command', () => {
    const contract = build({
      ci: ci({
        commands: [cmd('npm ci', 7), cmd('npm test', 8)],
        coverage: 'partial',
        caveats: [`${WORKFLOW}: uses anchors in YAML, which MergeSutra does not expand`],
      }),
    });
    expect(contract.ci).toEqual({
      provider: 'github-actions',
      workflows: [{ path: WORKFLOW, jobs: ['checks'] }],
      coverage: 'partial',
      caveats: [`${WORKFLOW}: uses anchors in YAML, which MergeSutra does not expand`],
      observedCommandCount: 2,
    });
    expect(contract.limitations.join(' ')).toContain('CI coverage was partial');
  });

  it('states plainly that CI was never found', () => {
    const contract = build({
      ci: ci({ provider: 'none', workflows: [], caveats: ['no GitHub Actions workflow found'] }),
    });
    expect(contract.ci.provider).toBe('none');
    expect(contract.limitations.join(' ')).toContain(
      'No CI workflow found: nothing can be marked required from CI evidence',
    );
  });

  it('flags an unrecognised toolchain and unreadable manifests', () => {
    const contract = build({
      manifests: manifests({
        ecosystem: 'unknown',
        ecosystemSources: [],
        packageManager: null,
        scripts: [],
        lockfiles: [],
        unreadable: [{ file: 'pyproject.toml', reason: 'is not a JSON object' }],
      }),
    });
    expect(contract.limitations.join(' ')).toContain('No recognised manifest');
    expect(contract.limitations.join(' ')).toContain(
      'Unreadable manifests: pyproject.toml (is not a JSON object).',
    );
  });

  it('reports ownership as unknown rather than absent by silence', () => {
    const absent = build({
      protectedAreas: { declaredIn: null, status: 'absent', entryCount: 0, samplePaths: [] },
    });
    expect(absent.limitations.join(' ')).toContain('No CODEOWNERS file found');

    const unreadable = build({
      protectedAreas: {
        declaredIn: 'CODEOWNERS',
        status: 'unreadable',
        entryCount: 0,
        samplePaths: [],
      },
    });
    expect(unreadable.limitations.join(' ')).toContain('CODEOWNERS exists but could not be read');
  });

  it('always admits that repository settings were not queried', () => {
    expect(build().limitations).toContain(
      'Branch protection, required reviewers and merge policies live in repository settings and were not queried.',
    );
  });

  it('marks the whole contract as untrusted data from this repository', () => {
    const contract = build();
    expect(contract.untrusted).toBe(true);
    expect(contract.schemaVersion).toBe(1);
    expect(contract.contributionDocs).toEqual([DOC]);
  });
});

describe('gatesEnforced — following the repository’s own scripts', () => {
  const scriptMap = (...scripts: DeclaredScript[]): Map<string, DeclaredScript> =>
    new Map(scripts.map((s) => [s.name, s]));

  it('learns nothing from a composite script name on its own', () => {
    // `check` is not a tool. Only the body the repository declares can say what
    // it enforces, and a contract that guessed from the name would be inventing.
    expect(runsGate('npm run check', 'lint')).toBe(false);
    expect(gatesEnforced('npm run check', scriptMap())).toEqual([]);
  });

  it('reaches a gate through a script that runs another script', () => {
    const scripts = scriptMap(
      script('check', 'npm run static && npm test'),
      script('static', 'npm run lint'),
      script('lint', 'eslint .'),
    );
    expect(
      gatesEnforced('npm run check', scripts)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['lint', 'test']);
  });

  it('reports the script CI actually invoked, and the one that carries the gate', () => {
    const scripts = scriptMap(script('check', 'npm run lint'), script('lint', 'eslint .'));
    expect(gatesEnforced('npm run check', scripts)).toEqual([
      { kind: 'lint', via: 'check', script: 'lint' },
    ]);
  });

  it('treats a bare tool step as evidence with no script behind it', () => {
    expect(gatesEnforced('npx vitest run', scriptMap())).toEqual([
      { kind: 'test', via: null, script: null },
    ]);
  });

  it('cites the named script over the composite body that happens to contain it', () => {
    const scripts = scriptMap(
      script('check', 'npm test && npm run lint'),
      script('test', 'vitest run'),
      script('lint', 'eslint .'),
    );
    // The step proves both gates, and `check`'s own text is enough to prove
    // `test` — but the command a contributor should run is the one named `test`.
    expect(gatesEnforced('npm run check', scripts)).toEqual([
      { kind: 'test', via: 'check', script: 'test' },
      { kind: 'lint', via: 'check', script: 'lint' },
    ]);
  });

  it('stops following the chain at the documented depth', () => {
    const fourHops = scriptMap(
      script('a', 'npm run b'),
      script('b', 'npm run c'),
      script('c', 'npm run d'),
      script('d', 'eslint .'),
    );
    expect(runsGate('npm run a', 'lint', fourHops)).toBe(false);

    const threeHops = scriptMap(
      script('a', 'npm run b'),
      script('b', 'npm run c'),
      script('c', 'eslint .'),
    );
    expect(runsGate('npm run a', 'lint', threeHops)).toBe(true);
  });

  it('survives a script chain that refers to itself', () => {
    const cyclic = scriptMap(script('a', 'npm run b'), script('b', 'npm run a'));
    expect(gatesEnforced('npm run a', cyclic)).toEqual([]);
  });

  it('does not mistake an install step for a gate', () => {
    for (const command of ['npm ci', 'pnpm install --frozen-lockfile', 'uv sync', 'cargo fetch']) {
      expect(gatesEnforced(command, scriptMap())).toEqual([]);
    }
  });
});

describe('runsGate — the classifier on its own', () => {
  it('recognises tools without inventing gates from unrelated commands', () => {
    expect(runsGate('vitest run', 'test')).toBe(true);
    expect(runsGate('cargo clippy -- -D warnings', 'lint')).toBe(true);
    expect(runsGate('go build ./...', 'build')).toBe(true);
    expect(runsGate('git status --porcelain', 'build')).toBe(false);
    expect(runsGate('echo done', 'test')).toBe(false);
  });

  it('does not count a bare type-emitting tsc as a typecheck gate', () => {
    expect(runsGate('tsc --outDir dist', 'typecheck')).toBe(false);
    expect(runsGate('tsc --noEmit', 'typecheck')).toBe(true);
  });
});

describe('parseRepositoryContract', () => {
  it('round-trips a contract it produced', () => {
    const contract = build();
    expect(parseRepositoryContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
  });

  it('rejects fields nobody declared', () => {
    const inflated = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    inflated.confidence = 'high';
    expect(() => parseRepositoryContract(inflated)).toThrow();
  });

  it('rejects a gate that claims a source outside the vocabulary', () => {
    const contract = JSON.parse(JSON.stringify(build())) as {
      gates: { source: string }[];
    };
    const lint = contract.gates.find((g) => g.source === 'OPTIONAL');
    if (!lint) throw new Error('expected an OPTIONAL gate row');
    lint.source = 'TRUSTED_UPSTREAM';
    expect(() => parseRepositoryContract(contract)).toThrow();
  });
});
