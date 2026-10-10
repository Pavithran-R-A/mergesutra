import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { abbreviateHomePath } from '../../src/intake/intake.js';

describe('abbreviateHomePath', () => {
  it('normalizes Windows separators before comparing HOME', () => {
    expect(
      abbreviateHomePath(
        'C:/Users/alice/AppData/Local/Temp/repo',
        { HOME: 'C:\\Users\\alice' },
        'win32',
      ),
    ).toBe('~/AppData/Local/Temp/repo');
  });

  it('falls back to USERPROFILE when HOME names a different root', () => {
    expect(
      abbreviateHomePath(
        'C:/Users/alice/repo',
        { HOME: 'D:\\elsewhere', USERPROFILE: 'C:\\Users\\alice' },
        'win32',
      ),
    ).toBe('~/repo');
  });

  it('compares Windows paths case-insensitively', () => {
    expect(abbreviateHomePath('C:/USERS/ALICE/repo', { HOME: 'c:\\users\\alice' }, 'win32')).toBe(
      '~/repo',
    );
  });

  it('does not mistake a sibling prefix for the home directory', () => {
    expect(abbreviateHomePath('C:/Users/alice2/repo', { HOME: 'C:\\Users\\alice' }, 'win32')).toBe(
      'C:/Users/alice2/repo',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'canonicalizes macOS aliases before comparing existing HOME and Git paths',
    () => {
      const realHome = mkdtempSync(path.join(tmpdir(), 'mergesutra-home-alias-'));
      const alias = realHome + '-alias';
      try {
        mkdirSync(path.join(realHome, 'repo'));
        symlinkSync(realHome, alias);
        expect(abbreviateHomePath(path.join(realHome, 'repo'), { HOME: alias }, 'darwin')).toBe(
          '~/repo',
        );
      } finally {
        rmSync(alias, { force: true });
        rmSync(realHome, { recursive: true, force: true });
      }
    },
  );

  it('keeps POSIX comparison case-sensitive', () => {
    expect(abbreviateHomePath('/home/alice/repo', { HOME: '/home/alice' }, 'linux')).toBe('~/repo');
    expect(abbreviateHomePath('/home/Alice/repo', { HOME: '/home/alice' }, 'linux')).toBe(
      '/home/Alice/repo',
    );
  });
});
