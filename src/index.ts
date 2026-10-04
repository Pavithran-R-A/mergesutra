/**
 * The library surface of MergeSutra: re-exports only, so importing this module can
 * never run a command line. The executable the manifest registers is `src/bin.ts`.
 */
export { run, buildProgram } from './cli/program.js';
export type { ProgramDeps } from './cli/program.js';
export { VERSION, PRODUCT_NAME, TAGLINE } from './version.js';
export { createBharatCodeClient, HttpBharatCodeClient } from './bharatcode/client.js';
export type { BharatCodeClient, FetchLike, ClientDeps } from './bharatcode/client.js';
export { Redactor, redactText, redactHeader } from './security/redaction.js';
export { AppError, isAppError } from './core/errors.js';
export { loadBharatCodeConfig, summarizeConfig } from './config/load-config.js';
