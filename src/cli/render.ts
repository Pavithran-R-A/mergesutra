/**
 * Restrained terminal rendering.
 *
 * Deliberate, clean, and honest: real status words, no fake progress bars, no
 * emoji spam. Colour is disabled automatically when `NO_COLOR` is set or when
 * `--no-color` / a non-TTY stream is detected.
 */

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

export function resolveColor(noColorFlag: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  return true;
}

export function createRenderer(options: RenderOptions) {
  const { color } = options;
  const wrap = (code: string, text: string): string =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;

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
      return `${this.status(status)} ${name}${suffix}`;
    },
  };
}

export type Renderer = ReturnType<typeof createRenderer>;
