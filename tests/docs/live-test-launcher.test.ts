import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = path.join(root, 'scripts', 'run-live-tests.mjs');
const execFileAsync = promisify(execFile);

describe('opt-in real-model suite command', () => {
  it('uses a portable Node launcher instead of POSIX-only shell assignments', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['test:live']).toBe('node scripts/run-live-tests.mjs');
  });

  it('boots the live suite help without a key or a model request', async () => {
    const result = await execFileAsync(process.execPath, [launcher, '--help'], {
      cwd: root,
      env: {
        ...process.env,
        BHARATCODE_API_KEY: '',
        BHARATCODE_MODEL: '',
        NO_COLOR: '1',
      },
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.stdout.toLowerCase()).toContain('vitest');
  });
});
