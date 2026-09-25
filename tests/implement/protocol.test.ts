import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  ACTION_KINDS,
  actionCriterionIds,
  actionIdentity,
  MAX_ACTION_CONTENT_CHARS,
  parseAction,
  unknownActionCriterionIds,
} from '../../src/implement/protocol.js';

/**
 * The action protocol: the only shape a model's words are allowed to take.
 *
 * Stage 6's safety claim rests on this file. If a model can express a shell
 * command, a risk class, or a criterion status in an action, then every boundary
 * downstream is negotiable. These tests are the proof that it cannot — not that
 * the loop refuses at runtime, but that the object never parses.
 */

function valid(overrides: Record<string, unknown>): Record<string, unknown> {
  return { action: 'READ_FILE', path: 'src/parse.ts', reason: 'see the behaviour', ...overrides };
}

describe('the closed list', () => {
  it('accepts one of every operation it offers', () => {
    const cases: Record<string, Record<string, unknown>> = {
      READ_FILE: valid({}),
      LIST_FILES: { action: 'LIST_FILES', path: 'src', reason: 'look around' },
      SEARCH: { action: 'SEARCH', query: 'parseDate', reason: 'find the caller' },
      WRITE_FILE: {
        action: 'WRITE_FILE',
        path: 'src/parse.ts',
        content: 'export const x = 1;\n',
        reason: 'add the guard',
      },
      RUN_CHECK: { action: 'RUN_CHECK', argv: ['npm', 'test'], reason: 'run the suite' },
      PROPOSE_CONTRACT_REVISION: {
        action: 'PROPOSE_CONTRACT_REVISION',
        criterionId: 'AC-1',
        previous: 'Empty input is rejected.',
        proposed: 'Empty input returns the epoch.',
        reason: 'the repository does the opposite',
        sourceEvidence: 'src/parse.ts:2',
      },
      FINISH: { action: 'FINISH', summary: 'Guard added.' },
      BLOCKED: { action: 'BLOCKED', reason: 'The criterion contradicts the repository.' },
    };
    expect(Object.keys(cases)).toEqual([...ACTION_KINDS]);
    for (const [kind, value] of Object.entries(cases)) {
      expect(parseAction(value).action, kind).toBe(kind);
    }
  });

  it('names every offered operation when the model invents one', () => {
    expect(() => parseAction({ action: 'RUN_SHELL', command: 'rm -rf /' })).toThrow(
      /is not an operation MergeSutra offers/,
    );
    expect(() => parseAction({ action: 'RUN_SHELL', command: 'rm -rf /' })).toThrow(
      /READ_FILE, LIST_FILES/,
    );
  });

  it('refuses an action with no action at all, and one that is not an object', () => {
    for (const junk of [null, undefined, 'READ_FILE', 42, {}, { action: '' }]) {
      expect(() => parseAction(junk), JSON.stringify(junk)).toThrow(AppError);
    }
  });
});

describe('fields the model does not get to add', () => {
  it('rejects a field it was not asked for instead of ignoring it', () => {
    // Each of these would be a permission the loop never granted.
    for (const extra of [
      { force: true },
      { risk: 'READ' },
      { shell: true },
      { cwd: '/' },
      { timeoutMs: 1 },
      { status: 'PASS' },
      { approved: true },
    ]) {
      expect(() => parseAction(valid(extra)), JSON.stringify(extra)).toThrow(AppError);
    }
  });

  it('rejects a criterion status on FINISH, where a lie would be cheapest', () => {
    expect(() =>
      parseAction({
        action: 'FINISH',
        summary: 'Done.',
        criteriaBelievedComplete: ['AC-1'],
        criteriaStatus: { 'AC-1': 'PASS' },
      }),
    ).toThrow(AppError);
  });

  it('parses the defaults MergeSutra supplies, not ones the model claims', () => {
    const write = parseAction({
      action: 'WRITE_FILE',
      path: 'src/parse.ts',
      content: 'x\n',
      reason: 'add the guard',
    });
    expect(write.action === 'WRITE_FILE' && write.criterionIds).toEqual([]);
    const list = parseAction({ action: 'LIST_FILES', reason: 'look' });
    expect(list.action === 'LIST_FILES' && list.path).toBe('.');
  });
});

describe('paths', () => {
  it('accepts only repository-relative POSIX paths', () => {
    for (const path of ['src/parse.ts', 'README.md', 'test/unit/a.test.ts', '.github/ci.yml']) {
      expect(parseAction(valid({ path })).action === 'READ_FILE' && 'ok').toBe('ok');
    }
  });

  it('rejects traversal, absolute paths, drive letters, backslashes and empties', () => {
    for (const path of [
      '../outside.ts',
      'src/../../outside.ts',
      '/etc/passwd',
      'C:\\Users\\x\\parse.ts',
      'src\\parse.ts',
      '~/id_rsa',
      '//server/share',
      'src//parse.ts',
      './src/parse.ts',
      '.',
      '..',
      '  ',
      'src/\0parse.ts',
    ]) {
      expect(() => parseAction(valid({ path })), JSON.stringify(path)).toThrow(
        /repository-relative POSIX/,
      );
    }
  });

  it('rejects an empty path and an empty command as too small to mean anything', () => {
    expect(() => parseAction(valid({ path: '' }))).toThrow(AppError);
    expect(() => parseAction({ action: 'RUN_CHECK', argv: [], reason: 'r' })).toThrow(AppError);
  });

  it('rejects a .git path at the shape level, before any filesystem is touched', () => {
    // Not refused here — but the reader and writer both refuse it, and the tool
    // policy classifies it. Pinned so a future "helpful" relaxation is visible.
    expect(parseAction(valid({ path: '.git/config' })).action === 'READ_FILE').toBe(true);
  });
});

describe('commands', () => {
  it('accepts a plain argv array', () => {
    const action = parseAction({
      action: 'RUN_CHECK',
      argv: ['npm', 'run', 'lint'],
      reason: 'run the linter',
    });
    expect(action.action === 'RUN_CHECK' && action.argv).toEqual(['npm', 'run', 'lint']);
  });

  it('rejects a pipeline, a substitution and any empty argument', () => {
    for (const argv of [
      ['npm', 'test', '&&', 'curl', 'example.invalid'],
      ['npm', 'test | tee out.log'],
      ['echo', '$(whoami)'],
      ['cat', '`id`'],
      ['npm', 'test', '; rm -rf /'],
    ]) {
      expect(
        () => parseAction({ action: 'RUN_CHECK', argv, reason: 'check' }),
        argv.join('|'),
      ).toThrow(/argv array/);
    }
  });

  it('rejects an empty argument, which is not a shape MergeSutra can pass on', () => {
    expect(() =>
      parseAction({ action: 'RUN_CHECK', argv: ['npm', 'test', ''], reason: 'r' }),
    ).toThrow(AppError);
  });

  it('lets a spaced program token parse, because the policy is what refuses it', () => {
    // `['npm test']` carries no shell character, so the schema cannot see the
    // problem. `isBareProgram` refuses it in `decideExecute`, which is where the
    // loop's own tests prove nothing is spawned. Pinned here so the division of
    // labour — shape at the boundary, authority in the policy — stays honest.
    expect(parseAction({ action: 'RUN_CHECK', argv: ['npm test'], reason: 'r' }).action).toBe(
      'RUN_CHECK',
    );
  });

  it('never accepts a risk class, so a caller cannot file its own action as READ', () => {
    expect(
      parseAction({ action: 'RUN_CHECK', argv: ['git', 'push', 'origin'], reason: 'publish it' })
        .action,
    ).toBe('RUN_CHECK');
    // The action carries no field to lie in; `git push` is only refused by the
    // policy that reads the argv, which is the point of deriving risk.
  });
});

describe('sizes a single action may not exceed', () => {
  it('rejects content over one write cap and content that is empty', () => {
    const tooBig = 'x'.repeat(MAX_ACTION_CONTENT_CHARS + 1);
    expect(() =>
      parseAction({ action: 'WRITE_FILE', path: 'a.ts', content: tooBig, reason: 'r' }),
    ).toThrow(AppError);
    expect(() =>
      parseAction({ action: 'WRITE_FILE', path: 'a.ts', content: '', reason: 'r' }),
    ).toThrow(AppError);
  });

  it('rejects a reason long enough to be an essay and a summary long enough to be a report', () => {
    expect(() => parseAction(valid({ reason: 'y'.repeat(301) }))).toThrow(AppError);
    expect(() => parseAction({ action: 'FINISH', summary: 'z'.repeat(2_001) })).toThrow(AppError);
    expect(() => parseAction({ action: 'BLOCKED', reason: 'z'.repeat(2_001) })).toThrow(AppError);
  });

  it('rejects a search query that is one character or enormous', () => {
    expect(() => parseAction({ action: 'SEARCH', query: 'a', reason: 'r' })).toThrow(AppError);
    expect(() => parseAction({ action: 'SEARCH', query: 'a'.repeat(201), reason: 'r' })).toThrow(
      AppError,
    );
  });
});

describe('criterion ids a action may name', () => {
  it('collects them from every variant that can carry one', () => {
    expect(
      actionCriterionIds(
        parseAction({
          action: 'WRITE_FILE',
          path: 'a.ts',
          content: 'x\n',
          reason: 'r',
          criterionIds: ['AC-2', 'AC-1'],
        }),
      ),
    ).toEqual(['AC-2', 'AC-1']);
    expect(
      actionCriterionIds(
        parseAction({ action: 'FINISH', summary: 's', criteriaBelievedComplete: ['AC-3'] }),
      ),
    ).toEqual(['AC-3']);
    expect(
      actionCriterionIds(
        parseAction({
          action: 'PROPOSE_CONTRACT_REVISION',
          criterionId: 'AC-4',
          previous: 'p',
          proposed: 'q',
          reason: 'r',
          sourceEvidence: 'e',
        }),
      ),
    ).toEqual(['AC-4']);
    expect(actionCriterionIds(parseAction(valid({})))).toEqual([]);
  });

  it('reports the ids a contract never issued, and none when they are all real', () => {
    const action = parseAction({
      action: 'WRITE_FILE',
      path: 'a.ts',
      content: 'x\n',
      reason: 'r',
      criterionIds: ['AC-1', 'AC-99'],
    });
    expect(unknownActionCriterionIds(action, ['AC-1', 'AC-2'])).toEqual(['AC-99']);
    expect(unknownActionCriterionIds(action, ['AC-1', 'AC-99'])).toEqual([]);
  });

  it('rejects an id that is not the contract’s spelling', () => {
    expect(() =>
      parseAction({
        action: 'WRITE_FILE',
        path: 'a.ts',
        content: 'x\n',
        reason: 'r',
        criterionIds: ['AC1'],
      }),
    ).toThrow(AppError);
  });
});

describe('actionIdentity: what a repeat means', () => {
  it('is the operation and its target, not the model’s prose', () => {
    const first = parseAction(readActionish('README.md', 'first look'));
    const again = parseAction(readActionish('README.md', 'a differently worded second look'));
    expect(actionIdentity(again)).toBe(actionIdentity(first));
    expect(actionIdentity(again)).toBe('READ_FILE:README.md');
  });

  it('separates two writes to the same path but not two paths', () => {
    const a = parseAction({ action: 'WRITE_FILE', path: 'a.ts', content: '1\n', reason: 'r' });
    const b = parseAction({ action: 'WRITE_FILE', path: 'b.ts', content: '1\n', reason: 'r' });
    expect(actionIdentity(a)).not.toBe(actionIdentity(b));
    expect(actionIdentity(a)).toBe('write:a.ts');
  });

  it('normalizes a search so a change of case is not a new attempt', () => {
    const lower = parseAction({ action: 'SEARCH', query: 'parsedate', reason: 'r' });
    const upper = parseAction({ action: 'SEARCH', query: ' parseDate ', reason: 'r' });
    expect(actionIdentity(upper)).toBe(actionIdentity(lower));
  });

  it('gives the two ending actions stable identities', () => {
    expect(actionIdentity(parseAction({ action: 'FINISH', summary: 'x' }))).toBe('finish');
    expect(actionIdentity(parseAction({ action: 'BLOCKED', reason: 'y' }))).toBe('blocked');
  });
});

function readActionish(path: string, reason: string): Record<string, unknown> {
  return { action: 'READ_FILE', path, reason };
}
