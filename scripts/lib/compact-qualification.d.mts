export const COMPACT_ALLOWED_PATHS: readonly string[];

export interface CompactAcceptanceProof {
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

export function inspectCompactAcceptance(input: {
  workspace: string;
  changedPaths: string[];
  env: NodeJS.ProcessEnv;
  readFile: (file: string, encoding: 'utf8') => Promise<string>;
  run: (
    label: string,
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => { exitCode: number | null };
}): Promise<CompactAcceptanceProof>;
