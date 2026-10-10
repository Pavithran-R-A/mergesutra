import { describe, expect, it } from 'vitest';
import { sanitizeInline } from '../../src/github/schemas.js';

describe('GitHub issue-title control characters', () => {
  it('removes C0, DEL and C1 controls before a title is displayed', () => {
    expect(sanitizeInline('alpha\u009bbeta\u0085gamma\u007fdelta\u001bomega')).toBe(
      'alpha beta gamma delta omega',
    );
  });

  it('keeps ordinary Unicode text and collapses whitespace', () => {
    expect(sanitizeInline('  தமிழ் \n भारत  \t hello  ')).toBe('தமிழ் भारत hello');
  });

  it('still truncates after normalization', () => {
    expect(sanitizeInline(' \u009babcdef\u009d ', 3)).toBe('abc…');
  });
});
