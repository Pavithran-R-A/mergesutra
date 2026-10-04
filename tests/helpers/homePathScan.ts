/**
 * The home-directory identity of the machine this project was built on, applied
 * as a *detector* at the release boundary.
 *
 * `credentialScan.ts` answers "does this artifact carry a secret". This file
 * answers the other question a public repository forces: "does this artifact
 * carry the developer". A personal path is not a credential — nothing is
 * invalidated by it — but it is data about a person that a tool never needed to
 * publish, and once a repository is public it cannot be unpublished. Two
 * different boundaries follow from that difference, and they are deliberately
 * scanned with different rules:
 *
 * 1. **The owner token, in a path position** (the repository boundary). A public
 *    GitHub repository publishes every tracked file, `tests/` included, so the
 *    scan that protects a public clone cannot exclude the suite the way the
 *    credential scan does. What it does distinguish is *position*: the token as an
 *    approval actor in a fixture is a name a test needs, while the token inside
 *    `C:\Users\<owner>\…` is this machine's filesystem, and only the second one
 *    says something about the person that they did not choose to publish. So the
 *    rule is anchored to a path separator rather than to the string. The 8.3 short
 *    form has no such excuse: it only ever occurs inside a path, so it is matched
 *    anywhere.
 * 2. **Any concrete home path** (the artifact boundary). The package is the one
 *    surface with no legitimate reason to name a directory belonging to anybody,
 *    so its rule does not care whose — `Users/<word>/` and `home/<word>/` are both
 *    findings. An elision (`C:/Users/…/`) is not, because the elision is the
 *    spelling this project already uses when it quotes a real screen.
 *
 * The token is composed from fragments: this file is itself tracked, and a
 * detector that carried the string it hunts would be the only copy left after the
 * scrub, and would then fail its own scan.
 */

/** The account that owns the home directory on the build machine. */
export const HOME_OWNER = ['pav', 'ithran'].join('');

/** Its 8.3 alias, which Windows resolves to the same directory. */
export const HOME_OWNER_83 = `${HOME_OWNER.slice(0, 6)}~1`;

export type HomePathForm = 'owner-path' | 'owner-short' | 'concrete-home-path';

export interface HomePathFinding {
  readonly file: string;
  readonly line: number;
  readonly form: HomePathForm;
  /** The offending span with the owner's identity removed. Never the raw match. */
  readonly excerpt: string;
}

/**
 * `/Users/<owner>` or `/home/<owner>`, either slash direction, any case.
 *
 * The gap between the separator and the token is any run that is not whitespace
 * or a quoting character, which is what lets one pattern cover both the prose
 * spelling (`\Users\Alex`) and the source spelling (`\\Users\\alex`, where a second
 * separator sits in the gap).
 */
const OWNER_IN_PATH = new RegExp(
  '[/\\\\](?:users|home)[/\\\\][^\\s"\\u0027\\u0060),]*' + HOME_OWNER,
  'gi',
);

/** The 8.3 alias, anywhere: it is not a word that occurs outside a path. */
const OWNER_SHORT = new RegExp(HOME_OWNER_83, 'gi');

/**
 * A home path naming *somebody*: the user component has to read as a segment and
 * has to be followed by another directory (or end the text). Requiring the
 * trailing separator is what keeps a code pattern like `/[\\]Users[\\/]/i` from
 * reading as a username.
 */
const CONCRETE_HOME_PATH =
  /[/\\](?:users|home)[/\\][A-Za-z0-9._-]{2,}[/\\]|[/\\](?:users|home)[/\\][A-Za-z0-9._-]{2,}$/gi;

/** Offset in `text` of each line start, so a match index becomes a line number. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** The matched span, with the identity replaced and the surrounding shape kept. */
function excerptFor(form: HomePathForm, match: string): string {
  if (form === 'owner-path') return match.replace(new RegExp(HOME_OWNER, 'gi'), '[OWNER]');
  if (form === 'owner-short') return match.replace(new RegExp(HOME_OWNER_83, 'gi'), '[OWNER]');
  // A concrete path names *somebody*, and a failure message that repeats it would
  // publish the thing the gate exists to keep out of the published surface.
  return match.replace(
    /^([/\\](?:users|home)[/\\])([A-Za-z0-9._-]{2,})([/\\]?)$/i,
    (_all, sep: string, _user: string, tail: string) => `${sep}[USER]${tail}`,
  );
}

function collect(
  file: string,
  text: string,
  pattern: RegExp,
  form: HomePathForm,
  findings: HomePathFinding[],
): void {
  const re = new RegExp(pattern.source, pattern.flags);
  const starts = lineStarts(text);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    findings.push({
      file,
      line: lineOf(starts, match.index),
      form,
      excerpt: excerptFor(form, match[0]),
    });
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
}

/** Findings for one text, over whichever boundaries the caller is standing at. */
export function scanHomePaths(
  file: string,
  text: string,
  boundaries: readonly ('owner' | 'concrete')[] = ['owner', 'concrete'],
): HomePathFinding[] {
  const findings: HomePathFinding[] = [];
  if (boundaries.includes('owner')) {
    collect(file, text, OWNER_IN_PATH, 'owner-path', findings);
    collect(file, text, OWNER_SHORT, 'owner-short', findings);
  }
  if (boundaries.includes('concrete')) {
    collect(file, text, CONCRETE_HOME_PATH, 'concrete-home-path', findings);
  }
  return findings.sort((a, b) => a.line - b.line || a.form.localeCompare(b.form));
}
