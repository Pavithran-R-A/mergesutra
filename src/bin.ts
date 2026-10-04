#!/usr/bin/env node
import { run } from './cli/program.js';

/**
 * The command line, executed unconditionally.
 *
 * This is the file the manifest registers as `bin`, and it decides nothing about how it
 * was started. npm's POSIX launcher is a symlink to it, so the script runs under a path
 * that is not its own realpath; a launcher that asked "am I the module being run?" by
 * comparing `process.argv[1]` with `import.meta.url` would answer no and do nothing —
 * exit code 0, no output — on Linux and macOS while passing on Windows, whose launcher
 * calls `node` with the realpath. `src/index.ts` carries no such question now: importing
 * the library cannot run a command line, and running the command cannot be declined.
 */
try {
  process.exitCode = await run(process.argv);
} catch {
  process.exitCode = 1;
}
