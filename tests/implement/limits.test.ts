import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS, LIMIT_CAPS, resolveLimits } from '../../src/implement/limits.js';

/**
 * The bounds of one loop, and what happens when someone asks for bigger ones.
 *
 * An agent's default failure is not a wrong answer, it is never finishing — so
 * the ceiling is a fact about the product, not a knob. These tests pin that the
 * defaults are inside the ceiling, that the ceiling is enforced in code, and that
 * asking for more is a refusal with a remediation rather than a silent yes.
 */

const KNOBS = Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[];

describe('the shape of the limits', () => {
  it('has a ceiling for every knob, and no default above it', () => {
    expect(KNOBS).toContain('maxSteps');
    expect(KNOBS).toContain('loopDeadlineMs');
    for (const knob of KNOBS) {
      expect(LIMIT_CAPS, knob).toHaveProperty(knob);
      expect(DEFAULT_LIMITS[knob], knob).toBeLessThanOrEqual(LIMIT_CAPS[knob]);
      expect(DEFAULT_LIMITS[knob], knob).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the ceilings small enough that one run cannot spend the day', () => {
    // Deliberate: a run that could be extended to anything is an unbounded run.
    expect(LIMIT_CAPS.maxSteps).toBeLessThanOrEqual(40);
    expect(LIMIT_CAPS.loopDeadlineMs).toBeLessThanOrEqual(20 * 60_000);
    expect(LIMIT_CAPS.maxContextBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('names every knob it enforces, so a new one cannot arrive unbounded', () => {
    const keys = Object.keys(DEFAULT_LIMITS).sort();
    expect(keys).toEqual([
      'commandTimeoutMs',
      'loopDeadlineMs',
      'maxCommandOutputBytes',
      'maxCommands',
      'maxContextBytes',
      'maxContextFiles',
      'maxModelOutputChars',
      'maxRefusals',
      'maxRepeatedFailures',
      'maxSchemaRepairs',
      'maxSteps',
      'maxWrites',
    ]);
  });
});

describe('resolveLimits', () => {
  it('returns the defaults untouched when nothing is asked for', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
  });

  it('applies a smaller number and leaves the others alone', () => {
    const limits = resolveLimits({ maxSteps: 3, maxWrites: 1 });
    expect(limits.maxSteps).toBe(3);
    expect(limits.maxWrites).toBe(1);
    expect(limits.maxCommands).toBe(DEFAULT_LIMITS.maxCommands);
  });

  it('ignores an explicit undefined rather than turning a knob into NaN', () => {
    expect(resolveLimits({ maxSteps: undefined, maxWrites: 2 })).toEqual({
      ...DEFAULT_LIMITS,
      maxWrites: 2,
    });
  });

  it('refuses a bound above the ceiling and says what to do instead', () => {
    expect(() => resolveLimits({ maxSteps: LIMIT_CAPS.maxSteps + 1 })).toThrow(
      /exceeds the MergeSutra ceiling/,
    );
    expect(() => resolveLimits({ maxContextBytes: 10_000_000 })).toThrow(AppError);
    try {
      resolveLimits({ maxSteps: 9_999 });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).kind).toBe('validation');
      expect((error as AppError).remediation).toContain('several runs');
    }
  });

  it('refuses a zero, a negative, and a non-number on every knob', () => {
    for (const knob of KNOBS) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => resolveLimits({ [knob]: value }), `${knob}=${String(value)}`).toThrow(
          /must be a positive number|ceiling/,
        );
      }
    }
  });

  it('accepts a knob at exactly its ceiling', () => {
    for (const knob of KNOBS) {
      expect(resolveLimits({ [knob]: LIMIT_CAPS[knob] })[knob], knob).toBe(LIMIT_CAPS[knob]);
    }
  });
});
