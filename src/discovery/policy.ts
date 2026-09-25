import { scanUntrustedText } from '../security/injection-scan.js';
import type { RepoReader } from './repo-fs.js';

/**
 * The documents a human contributor is told to obey — read as data.
 *
 * CONTRIBUTING.md and friends are the repository's *policy* text, and policy
 * text is exactly where a planted instruction would sit. So this module records
 * what those files look like (size, whether the read was complete, which
 * injection rules they trip) without ever turning their prose into a MergeSutra
 * requirement. If a later stage wants to honour "always run `make checks`", it
 * must do so as an explicitly labelled, human-approved check — not because a
 * markdown file said so.
 */

/**
 * Where a repository tells a human how to work.
 *
 * Exported so that Stage 7 looks for corroboration in exactly these files
 * rather than in a second, drifting list.
 */
export const CONTRIBUTION_CANDIDATES = [
  'CONTRIBUTING.md',
  'CONTRIBUTING.rst',
  'docs/CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'DEVELOPMENT.md',
  'docs/DEVELOPMENT.md',
];

export const MAX_DOC_BYTES = 32 * 1024;

export interface ContributionDocFact {
  readonly path: string;
  /** 'unreadable' means the file was listed but produced no content. */
  readonly status: 'read' | 'unreadable';
  readonly bytes: number;
  readonly truncated: boolean;
  /** Injection rule ids found in the document; each is a label, not a command. */
  readonly instructionLikeRules: readonly string[];
}

export async function scanContributionDocs(reader: RepoReader): Promise<ContributionDocFact[]> {
  const present = await reader.existsAny(CONTRIBUTION_CANDIDATES);
  const docs: ContributionDocFact[] = [];
  for (const relativePath of present) {
    const file = await reader.readText(relativePath, MAX_DOC_BYTES);
    if (!file) {
      docs.push({
        path: relativePath,
        status: 'unreadable',
        bytes: 0,
        truncated: false,
        instructionLikeRules: [],
      });
      continue;
    }
    docs.push({
      path: file.relativePath,
      status: 'read',
      bytes: file.bytesOnDisk,
      truncated: file.truncated,
      instructionLikeRules: scanUntrustedText(file.text).map((finding) => finding.ruleId),
    });
  }
  return docs;
}

const CODEOWNERS_CANDIDATES = [
  'CODEOWNERS',
  'docs/CODEOWNERS',
  '.github/CODEOWNERS',
  '.gitlab/CODEOWNERS',
];

const MAX_OWNERSHIP_SAMPLE = 12;

export interface ProtectedAreasFact {
  /** The file the ownership rules came from, or null when none exists. */
  readonly declaredIn: string | null;
  readonly status: 'declared' | 'unreadable' | 'absent';
  readonly entryCount: number;
  /** Path patterns only; owner identities are not copied into the record. */
  readonly samplePaths: readonly string[];
}

/**
 * Which paths the repository treats as specially owned.
 *
 * A CODEOWNERS file is the closest thing a public repository has to a machine
 * readable "don't touch this without asking these people" list. MergeSutra
 * records the patterns so a later scope guard can flag a patch that steps onto
 * owned ground; it does not fetch the owners and cannot see branch protection,
 * which lives in repository settings rather than in the tree.
 */
export async function scanProtectedAreas(reader: RepoReader): Promise<ProtectedAreasFact> {
  const [declaredIn] = await reader.existsAny(CODEOWNERS_CANDIDATES);
  if (!declaredIn) {
    return { declaredIn: null, status: 'absent', entryCount: 0, samplePaths: [] };
  }

  const file = await reader.readText(declaredIn, 16 * 1024);
  if (!file) {
    return { declaredIn, status: 'unreadable', entryCount: 0, samplePaths: [] };
  }

  const patterns: string[] = [];
  for (const line of file.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const pattern = trimmed.split(/\s+/)[0] ?? '';
    if (pattern.length > 0) patterns.push(pattern);
  }
  return {
    declaredIn: file.relativePath,
    status: 'declared',
    entryCount: patterns.length,
    samplePaths: patterns.slice(0, MAX_OWNERSHIP_SAMPLE),
  };
}
