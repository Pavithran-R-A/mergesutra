export interface ReleaseIdentityInput {
  readonly version: string;
  readonly releaseTag: string | undefined;
  readonly eventName: string | undefined;
  readonly ref: string | undefined;
  readonly repository: string | undefined;
  readonly expectedRepository: string;
  readonly head: string;
  readonly workflowSha: string | undefined;
  readonly tagCommit: string;
  readonly remoteMainLine: string;
}

export declare function releaseIdentityProblems(input: ReleaseIdentityInput): string[];
