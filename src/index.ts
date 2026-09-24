#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { run } from './cli/program.js';

export { run, buildProgram } from './cli/program.js';
export type { ProgramDeps } from './cli/program.js';
export { VERSION, PRODUCT_NAME, TAGLINE } from './version.js';
export { createBharatCodeClient, HttpBharatCodeClient } from './bharatcode/client.js';
export type { BharatCodeClient, FetchLike, ClientDeps } from './bharatcode/client.js';
export { Redactor, redactText, redactHeader } from './security/redaction.js';
export { AppError, isAppError } from './core/errors.js';
export { loadBharatCodeConfig, summarizeConfig } from './config/load-config.js';

/** Only execute when invoked as a program (not when imported by tests). */
async function main(): Promise<void> {
  try {
    const code = await run(process.argv);
    process.exitCode = code;
  } catch {
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
