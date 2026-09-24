import { defaultRedactor } from './redaction.js';

/**
 * Prompt-injection signalling.
 *
 * Issue bodies, repository files, comments and filenames are DATA. MergeSutra's
 * authority hierarchy (docs/SECURITY_MODEL.md) already decides that, and this
 * module makes the case visible instead of silent: when external text looks
 * like it is trying to give instructions, we record a finding, keep the text in
 * the untrusted lane, and surface it for the human reader.
 *
 * A finding never blocks intake and never grants authority. It is a label, not
 * a filter — the real defence is that no code path turns this text into
 * commands or credential access.
 */

export type InjectionSeverity = 'medium' | 'high';

export interface InjectionRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: InjectionSeverity;
  readonly note: string;
}

export interface InjectionFinding {
  readonly ruleId: string;
  readonly severity: InjectionSeverity;
  readonly note: string;
  /** Bounded, redacted snippet of the offending text. Never the whole body. */
  readonly excerpt: string;
}

export const INJECTION_RULES: readonly InjectionRule[] = [
  {
    id: 'override-instructions',
    pattern:
      /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all)\b[\s\S]{0,40}\binstructions?\b/i,
    severity: 'high',
    note: 'attempts to override prior instructions',
  },
  {
    id: 'role-reassignment',
    pattern:
      /\byou\s+are\s+now\b|\bact\s+as\s+(if\s+you\s+are\s+)?\b(unrestricted|root|admin|an?\s+unfiltered)/i,
    severity: 'high',
    note: 'attempts to reassign the agent role',
  },
  {
    id: 'secret-exfiltration',
    pattern:
      /\b(print|show|reveal|dump|export|send|upload|leak|paste)\b[\s\S]{0,60}\b(api[_ -]?key|token|secret|credential|password|\.ssh|id_rsa|\.aws|env(ironment)? variables?)\b/i,
    severity: 'high',
    note: 'attempts to obtain credentials or environment contents',
  },
  {
    id: 'safety-disable',
    pattern:
      /\b(disable|turn off|bypass|skip)\b[\s\S]{0,40}\b(safety|guard|risk check|approval|human review|sandbox|verification)\b/i,
    severity: 'high',
    note: 'attempts to disable safety or review gates',
  },
  {
    id: 'shell-download-exec',
    pattern: /\b(curl|wget)\b[\s\S]{0,120}\|\s*(ba|z|fc|)sh\b/i,
    severity: 'high',
    note: 'requests piping a remote download into a shell',
  },
  {
    id: 'destructive-command',
    pattern: /\brm\s+-[rf]{1,2}\s+\/|\bgit\s+push\b[\s\S]{0,30}--force|\bchmod\s+-R\s+777\b/i,
    severity: 'medium',
    note: 'mentions a destructive command',
  },
  {
    id: 'deceive-reviewer',
    pattern:
      /\b(do not|don't|never)\b[\s\S]{0,60}\b(tell|inform|mention|reveal to|show the)\b[\s\S]{0,60}\b(user|reviewer|maintainer|human)\b/i,
    severity: 'high',
    note: 'attempts to hide information from the reviewer',
  },
  {
    id: 'system-prompt-probe',
    pattern:
      /\b(system prompt|system message|hidden instructions|your instructions are|repeat your prompt)\b/i,
    severity: 'medium',
    note: 'probes for internal instructions',
  },
];

const EXCERPT_RADIUS = 60;
const MAX_EXCERPT_LENGTH = 160;

/** Scan untrusted text and report rule hits. Findings are capped so a crafted
 *  megabyte of noise cannot produce an unbounded report. */
export function scanUntrustedText(
  text: string,
  options: { readonly maxFindings?: number } = {},
): InjectionFinding[] {
  if (text.length === 0) return [];
  const maxFindings = options.maxFindings ?? 8;
  const findings: InjectionFinding[] = [];
  const seen = new Set<string>();
  for (const rule of INJECTION_RULES) {
    const match = rule.pattern.exec(text);
    if (!match || seen.has(rule.id)) continue;
    seen.add(rule.id);
    findings.push({
      ruleId: rule.id,
      severity: rule.severity,
      note: rule.note,
      excerpt: excerpt(text, match.index, match[0].length),
    });
    if (findings.length >= maxFindings) break;
  }
  return findings;
}

function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const clipped =
    slice.length > MAX_EXCERPT_LENGTH ? slice.slice(0, MAX_EXCERPT_LENGTH) + '…' : slice;
  return defaultRedactor.text(clipped);
}

/** One-line human summary of findings for terminal output. */
export function describeFindings(findings: readonly InjectionFinding[]): string {
  if (findings.length === 0) return 'no instruction-like patterns detected';
  const ids = findings.map((f) => `${f.ruleId}(${f.severity})`).join(', ');
  return `${findings.length} pattern(s) treated as data, not authority: ${ids}`;
}
