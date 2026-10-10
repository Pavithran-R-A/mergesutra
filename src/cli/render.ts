/**
 * Restrained terminal rendering.
 *
 * Deliberate, clean, and honest: real status words, no fake progress bars, no
 * emoji spam. Colour is disabled automatically when `NO_COLOR` is set or when
 * `--no-color` / a non-TTY stream is detected.
 *
 * Colour is also the *last* thing added to a string, which is why the escaping lives
 * here rather than in each command: `NO_COLOR` decides how a line looks and must never
 * decide whether a value may take over the terminal. See
 * `src/security/terminal-safety.ts`.
 */

import { terminalSafeText } from '../security/terminal-safety.js';

export type Status =
  'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'NOT_AVAILABLE' | 'INFO' | 'READY' | 'WAITING';

/** Wide enough that the longest truthful state still lines up in a column. */
export const STATUS_WIDTH = 13;

export interface RenderOptions {
  color: boolean;
}

const COLORS: Record<Status | 'dim' | 'bold', string> = {
  PASS: '32',
  FAIL: '31',
  WARN: '33',
  SKIP: '90',
  NOT_AVAILABLE: '90',
  INFO: '36',
  READY: '32',
  WAITING: '33',
  dim: '90',
  bold: '1',
};

export function resolveColor(
  noColorFlag: boolean | undefined,
  env: NodeJS.ProcessEnv,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  // A caller can explicitly request colour, but piped output is plain by default.
  if (['1', '2', '3'].includes(env.FORCE_COLOR ?? '')) return true;
  return isTTY;
}

export function createRenderer(options: RenderOptions) {
  const { color } = options;
  // Every string that reaches a style wrapper is made inert *first*, so the only escape
  // sequences on the line are the ones written below. Escaping afterwards would destroy
  // this renderer's own colour, and escaping nothing here would let a value that carries
  // a cursor movement sit inside a trusted row.
  const wrap = (code: string, text: string): string =>
    color ? `\x1b[${code}m${terminalSafeText(text)}\x1b[0m` : terminalSafeText(text);

  return {
    color,
    status(label: Status): string {
      return wrap(COLORS[label], label.padEnd(STATUS_WIDTH));
    },
    heading(text: string): string {
      return wrap(COLORS.bold, text);
    },
    dim(text: string): string {
      return wrap(COLORS.dim, text);
    },
    line(text = ''): string {
      return text;
    },
    /** One status row: `<badge> <name> <detail?>` */
    row(status: Status, name: string, detail?: string): string {
      const suffix = detail ? `  ${this.dim(detail)}` : '';
      return `${this.status(status)} ${terminalSafeText(name)}${suffix}`;
    },
  };
}

export type Renderer = ReturnType<typeof createRenderer>;
