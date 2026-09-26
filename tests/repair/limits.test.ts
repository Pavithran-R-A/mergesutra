import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIMIT_CAPS, type LoopLimits } from '../../src/implement/limits.js';
import {
  REPAIR_DEFAULT_LIMITS,
  REPAIR_LIMIT_CEILINGS,
  resolveRepairLimits,
} from '../../src/repair/limits.js';

/**
 * How much a repair may spend — Stage 9R.
 *
 * A repair loop starts from a position Stage 6 never had: there is already a
 * patch, already a set of receipts, and already a second opinion saying what is
 * wrong with them. That makes it the more dangerous of the two, not the less —
 * an agent with a diff and a reviewer's suggestions can wander productively for
 * a very long time. So the numbers here are *below* Stage 6's defaults on every
 * axis, and a caller cannot lift them back up: this file clamps where
 * `implement/limits.ts` throws, because a repair that asks for too much should
 * still run, just not with the budget it asked for.
 *
 * The knobs are the same names as Stage 6's, deliberately. A second limits
 * vocabulary is a second thing for the loop to disagree with.
 */

const KEYS = Object.keys(DEFAULT_LIMITS) as (keyof LoopLimits)[];

describe('the ceiling a repair cycle may not be lifted past', () => {
  it('caps the three axes that grow a diff, at numbers stricter than Stage 6', () => {
    expect(REPAIR_LIMIT_CEILINGS.maxSteps).toBe(8);
    expect(REPAIR_LIMIT_CEILINGS.maxWrites).toBe(4);
    expect(REPAIR_LIMIT_CEILINGS.maxCommands).toBe(3);
  });

  it('is at or below Stage 6 default on every knob, so a repair is never looser', () => {
    const looser = KEYS.filter((key) => REPAIR_LIMIT_CEILINGS[key] > DEFAULT_LIMITS[key]);

    expect(looser).toEqual([]);
  });

  it('stays inside the global ceilings this product already enforces', () => {
    const over = KEYS.filter((key) => REPAIR_LIMIT_CEILINGS[key] > LIMIT_CAPS[key]);

    expect(over).toEqual([]);
  });

  it('gives a repair less room to read than an implementation had', () => {
    expect(REPAIR_LIMIT_CEILINGS.maxContextFiles).toBeLessThan(DEFAULT_LIMITS.maxContextFiles);
    expect(REPAIR_LIMIT_CEILINGS.maxContextBytes).toBeLessThan(DEFAULT_LIMITS.maxContextBytes);
  });

  it('ends sooner in wall-clock time, because a repair has a diff to keep small', () => {
    expect(REPAIR_LIMIT_CEILINGS.loopDeadlineMs).toBeLessThan(DEFAULT_LIMITS.loopDeadlineMs);
  });
});

describe('the budget a repair cycle gets when nobody asks', () => {
  it('is the default, not the ceiling, so the ceiling is only ever reached by asking', () => {
    expect(resolveRepairLimits()).toEqual(REPAIR_DEFAULT_LIMITS);
  });

  it('is stricter than its own ceiling on the axes that matter', () => {
    expect(REPAIR_DEFAULT_LIMITS.maxSteps).toBeLessThan(REPAIR_LIMIT_CEILINGS.maxSteps);
    expect(REPAIR_DEFAULT_LIMITS.maxWrites).toBeLessThan(REPAIR_LIMIT_CEILINGS.maxWrites);
  });

  it('names the same knobs as Stage 6, so one loop type serves both', () => {
    expect(Object.keys(REPAIR_DEFAULT_LIMITS).sort()).toEqual(Object.keys(DEFAULT_LIMITS).sort());
  });
});

describe('what a caller may change', () => {
  it('shrinks: an operator who wants a smaller repair gets the smaller repair', () => {
    const limits = resolveRepairLimits({ maxWrites: 1, maxSteps: 3 });

    expect(limits.maxWrites).toBe(1);
    expect(limits.maxSteps).toBe(3);
  });

  it('never grows: a caller who asks for forty steps is given the ceiling', () => {
    expect(resolveRepairLimits({ maxSteps: 40 }).maxSteps).toBe(REPAIR_LIMIT_CEILINGS.maxSteps);
  });

  it('never grows past the ceiling on any knob, whichever one is asked for', () => {
    // Larger than every ceiling on every axis, including the millisecond ones.
    const asked = Object.fromEntries(
      KEYS.map((key) => [key, 1_000_000_000]),
    ) as Partial<LoopLimits>;
    const limits = resolveRepairLimits(asked);

    for (const key of KEYS) expect(limits[key]).toBe(REPAIR_LIMIT_CEILINGS[key]);
  });

  it('leaves the untouched knobs alone while clamping the asked one', () => {
    const limits = resolveRepairLimits({ maxWrites: 99 });

    expect(limits.maxWrites).toBe(REPAIR_LIMIT_CEILINGS.maxWrites);
    expect(limits.maxCommands).toBe(REPAIR_DEFAULT_LIMITS.maxCommands);
  });

  it('carries the defaults it does not override, verbatim', () => {
    expect(resolveRepairLimits({ maxSteps: 4 }).commandTimeoutMs).toBe(
      REPAIR_DEFAULT_LIMITS.commandTimeoutMs,
    );
  });
});

describe('what is not a budget', () => {
  for (const [what, value] of [
    ['zero', 0],
    ['a negative count', -3],
    ['a fraction of a step', 2.5],
    ['not a number', Number.NaN],
  ] as [string, number][]) {
    it(`refuses ${what} rather than clamping it into a loop that never runs`, () => {
      expect(() => resolveRepairLimits({ maxSteps: value }), what).toThrow(/maxSteps/);
    });
  }

  it('says what the ceiling was, so a refused request is diagnosable', () => {
    expect(() => resolveRepairLimits({ maxWrites: 0 })).toThrow(/1 to 4/);
  });
});
