import { describe, expect, it } from 'vitest';
import { createRenderer, resolveColor } from '../../src/cli/render.js';

describe('CLI colour portability', () => {
  it('prints plain text when stdout is redirected, even without NO_COLOR', () => {
    const renderer = createRenderer({ color: resolveColor(false, {}, false) });
    expect(renderer.row('PASS', 'gate', 'done')).toContain('PASS');
    expect(renderer.row('PASS', 'gate', 'done')).not.toContain(`${String.fromCharCode(27)}[`);
  });

  it('uses colour on TTY and supports an explicit FORCE_COLOR override', () => {
    expect(resolveColor(false, {}, true)).toBe(true);
    expect(resolveColor(false, { FORCE_COLOR: '1' }, false)).toBe(true);
    expect(resolveColor(false, { FORCE_COLOR: '2' }, false)).toBe(true);
    expect(resolveColor(false, { FORCE_COLOR: '3' }, false)).toBe(true);
  });

  it('lets opt-outs win over FORCE_COLOR and TTY', () => {
    expect(resolveColor(true, { FORCE_COLOR: '3' }, true)).toBe(false);
    expect(resolveColor(false, { NO_COLOR: '1', FORCE_COLOR: '3' }, true)).toBe(false);
    expect(resolveColor(false, { FORCE_COLOR: '0' }, true)).toBe(false);
    expect(resolveColor(false, { FORCE_COLOR: 'bogus' }, false)).toBe(false);
  });
});
