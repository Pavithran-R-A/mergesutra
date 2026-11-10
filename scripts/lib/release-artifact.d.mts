export interface ReleaseArtifactInput {
  readonly directory: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sourceCommit: string;
}

export interface ReleaseArtifactManifestResult {
  readonly tarball: string;
  readonly sha256: string;
}

export function writeReleaseArtifactManifest(
  input: ReleaseArtifactInput,
): ReleaseArtifactManifestResult;
