import { describe, expect, it } from 'vitest';
import { hasShellSyntax, isArgvShaped, isBareProgram } from '../../src/security/command-safety.js';

describe('hasShellSyntax', () => {
  it('flags every character a shell would re-parse', () => {
    for (const token of [';', '&&', 'a|b', '`id`', '$HOME', 'x>y', 'y<x', 'a\nb', 'a\rb']) {
      expect(hasShellSyntax(token)).toBe(true);
    }
  });

  it('leaves ordinary argument characters alone', () => {
    for (const token of ['test', '--check', 'src/date.ts', 'v1.2.3', 'a b', '--pattern=[^a]']) {
      expect(hasShellSyntax(token)).toBe(false);
    }
  });
});

describe('isArgvShaped', () => {
  it('requires a non-empty array of non-empty tokens', () => {
    expect(isArgvShaped([])).toBe(false);
    expect(isArgvShaped(['npm', ''])).toBe(false);
    expect(isArgvShaped(['npm', 'run', 'check'])).toBe(true);
  });

  it('refuses a command string that arrived where an argv belonged', () => {
    expect(isArgvShaped(['npm test && curl https://example.com'])).toBe(false);
    expect(isArgvShaped(['git', 'push; rm -rf /'])).toBe(false);
  });
});

describe('isBareProgram', () => {
  it('accepts only a program found on the search path', () => {
    expect(isBareProgram('git')).toBe(true);
    expect(isBareProgram('npm')).toBe(true);
  });

  it('refuses paths, drive letters, separators and blanks', () => {
    for (const token of [
      '',
      '   ',
      'npm test',
      'git commit',
      './scripts/build.sh',
      '/usr/bin/curl',
      'C:\\tools\\git.exe',
      '\\\\server\\share\\x.exe',
    ]) {
      expect(isBareProgram(token), JSON.stringify(token)).toBe(false);
    }
  });

  it('refuses shell syntax in the program position', () => {
    expect(isBareProgram('git;status')).toBe(false);
  });

  it('refuses a program named with a tab, which is a command string again', () => {
    expect(isBareProgram('npm\ttest')).toBe(false);
  });
});
