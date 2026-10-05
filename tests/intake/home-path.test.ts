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
    expect(
      abbreviateHomePath('C:/USERS/ALICE/repo', { HOME: 'c:\\users\\alice' }, 'win32'),
    ).toBe('~/repo');
  });

  it('does not mistake a sibling prefix for the home directory', () => {
    expect(
      abbreviateHomePath('C:/Users/alice2/repo', { HOME: 'C:\\Users\\alice' }, 'win32'),
    ).toBe('C:/Users/alice2/repo');
  });

  it('keeps POSIX comparison case-sensitive', () => {
    expect(abbreviateHomePath('/home/alice/repo', { HOME: '/home/alice' }, 'linux')).toBe(
      '~/repo',
    );
    expect(abbreviateHomePath('/home/Alice/repo', { HOME: '/home/alice' }, 'linux')).toBe(
      '/home/Alice/repo',
    );
  });
});
