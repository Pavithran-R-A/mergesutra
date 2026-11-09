export const FIXTURE_ALLOWED_PATHS: readonly string[];
export const REQUIRED_SLUG_INPUTS: readonly string[];
export const BASELINE_SLUG_INPUTS: readonly string[];
export const MAX_MODEL_COMPLETIONS: 12;

export function changesOutsideAllowlist(
  changedPaths: readonly string[],
  allowedPaths?: readonly string[],
): string[];

export function isDependencyFree(fixturePackage: {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}): boolean;

export function missingAssertionInputs(
  source: string,
  requiredInputs?: readonly string[],
): string[];

export interface FixtureAcceptanceProof {
  directBehaviorsPass: boolean;
  checkedScriptPass: boolean;
  checkContainsAllThreeAssertions: boolean;
  missingAssertionInputs: string[];
  baselineAssertionsPreserved: boolean;
  missingBaselineAssertionInputs: string[];
  dependencyFree: boolean;
  changesWithinFixture: boolean;
  changedPaths: string[];
}

export function inspectFixtureAcceptance(input: {
  workspace: string;
  run: (
    label: string,
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => { exitCode: number | null };
  env: NodeJS.ProcessEnv;
  readFile: (file: string, encoding: 'utf8') => Promise<string>;
  changedPaths: string[];
}): Promise<FixtureAcceptanceProof>;

export function liveQualificationFailures(input: {
  completionCount: number;
  elapsedMs: number;
  deadlineMs: number;
  verifyExit: number | null;
  implementation: { status?: string } | null;
  fixtureProof: FixtureAcceptanceProof | null;
  review: { findings: readonly unknown[] } | null;
  repairPlanPresent: boolean;
  requiredChangedPaths?: readonly string[];
}): string[];
