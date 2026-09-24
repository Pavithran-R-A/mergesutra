import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  assertSafePathSegment,
  isCaseInsensitivePlatform,
  isInsideRoot,
  isSafePathSegment,
  resolveInsideRoot,
} from '../../src/security/path-safety.js';

const ROOT = path.resolve('/workspace/repo');

describe('isInsideRoot', () => {
  it('accepts the root itself and nested paths', () => {
    expect(isInsideRoot(ROOT, ROOT, { caseInsensitive: false })).toBe(true);
    expect(isInsideRoot(ROOT, path.join(ROOT, 'src', 'a.ts'), { caseInsensitive: false })).toBe(
      true,
    );
  });

  it('rejects siblings and escapes', () => {
    expect(isInsideRoot(ROOT, '/workspace/other', { caseInsensitive: false })).toBe(false);
    expect(isInsideRoot(ROOT, '/workspace', { caseInsensitive: false })).toBe(false);
    expect(isInsideRoot(ROOT, path.join(ROOT, '..', 'evil'), { caseInsensitive: false })).toBe(
      false,
    );
  });

  it('does not treat a name prefix as containment', () => {
    expect(isInsideRoot(ROOT, '/workspace/repo-evil/x', { caseInsensitive: false })).toBe(false);
  });

  it('honours case sensitivity per platform', () => {
    expect(isInsideRoot(ROOT, '/WORKSPACE/REPO/x', { caseInsensitive: true })).toBe(true);
    expect(isInsideRoot(ROOT, '/WORKSPACE/REPO/x', { caseInsensitive: false })).toBe(false);
    expect(isCaseInsensitivePlatform('win32')).toBe(true);
    expect(isCaseInsensitivePlatform('linux')).toBe(false);
  });
});

describe('resolveInsideRoot', () => {
  it('joins a relative path inside the root', () => {
    expect(resolveInsideRoot(ROOT, path.join('src', 'date.ts'))).toBe(
      path.join(ROOT, 'src', 'date.ts'),
    );
  });

  it('refuses absolute paths rather than normalising them', () => {
    expect(() => resolveInsideRoot(ROOT, '/etc/passwd')).toThrow(AppError);
    expect(() => resolveInsideRoot(ROOT, 'C:\\Users\\other\\file.ts')).toThrow(AppError);
    expect(() => resolveInsideRoot(ROOT, '\\\\server\\share\\x.ts')).toThrow(AppError);
  });

  it('refuses parent traversal even when it would land inside', () => {
    expect(() => resolveInsideRoot(ROOT, 'src/../src/ok.ts')).toThrow(/parent traversal/);
    expect(() => resolveInsideRoot(ROOT, 'sub/../../outside.ts')).toThrow(/parent traversal/);
    expect(() => resolveInsideRoot(ROOT, './a/../b')).toThrow(/parent traversal/);
  });

  it('refuses empty and NUL-bearing input', () => {
    expect(() => resolveInsideRoot(ROOT, '')).toThrow(/empty/);
    expect(() => resolveInsideRoot(ROOT, 'a\0b')).toThrow(/NUL/);
  });

  it('names the value it refused without echoing the whole path', () => {
    let error: AppError | undefined;
    try {
      resolveInsideRoot(ROOT, '../secret', 'evidence file');
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.kind).toBe('validation');
    expect(error?.message).toContain('evidence file');
    expect(error?.details?.['reason']).toBeTruthy();
  });
});

describe('path segments that become file names', () => {
  it('accepts ordinary ids', () => {
    for (const value of ['run-2026-09-24T10-11-12Z-abc123', 'AC-1', 'a_b.c-d']) {
      expect(isSafePathSegment(value), value).toBe(true);
    }
  });

  it('rejects separators, traversal, empty and over-long ids', () => {
    for (const value of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', '-lead', 'x'.repeat(81)]) {
      expect(isSafePathSegment(value), value).toBe(false);
    }
  });

  it('returns the value when it is safe', () => {
    expect(assertSafePathSegment('run-1', 'run id')).toBe('run-1');
  });

  it('throws a validation error that quotes the rejected value', () => {
    expect(() => assertSafePathSegment('../evil', 'run id')).toThrow(/run id/);
  });
});
