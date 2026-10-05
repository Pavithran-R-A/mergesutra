import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SECURITY = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');

describe('the public security-reporting surface', () => {
  it('describes the repository as public, not as a future visibility state', () => {
    expect(SECURITY).toContain('This repository is public.');
    expect(SECURITY).not.toMatch(/repository stays private|once the repository is public/i);
  });

  it('points sensitive reports at the canonical private-advisory route', () => {
    expect(SECURITY).toContain(
      'https://github.com/Pavithran-R-A/mergesutra/security/advisories/new',
    );
    expect(SECURITY).toMatch(/do \*\*not\*\*.*public issue/is);
  });

  it('does not invent a mailbox, SLA or private channel that the repository does not own', () => {
    expect(SECURITY).not.toMatch(/security@|within \d+ (?:hour|day)|discord|slack|telegram/i);
  });
});
