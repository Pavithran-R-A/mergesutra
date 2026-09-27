import { PRODUCT_NAME } from '../version.js';
import type { PublicationCandidate } from '../pr/candidate.js';
import { runPrStage, type PrStageDeps, type PrStageResult } from '../pr/stage.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';

/**
 * `mergesutra pr <run-id>` — Stage 10.
 *
 * This screen is where a decision to publish is either informed or misled, so it is
 * built from one rule: show the page, and show nothing else as though it had happened.
 * The body a reviewer would read is printed in full, because a digest is only worth
 * typing against something a person has actually looked at; the eight readiness rows
 * are printed whether they passed or not, because a list of eight green lines is also
 * the evidence that the list means something narrow.
 *
 * The run id is a required argument rather than a defaulted one. Every other stage
 * can pick "the newest run" harmlessly — it re-reads bytes and writes a record. This
 * one answers for a repository somebody else owns, and a command that guessed which
 * run a person meant would be capable of approving the wrong page under a digest that
 * was right about something else.
 *
 * There is exactly one way to say yes: `--approve <digest>`, the digest of the page
 * printed above, typed after reading it. No `--yes`, `--force`, `--approve-all`,
 * `--all` or `--dangerously-skip-approval` is declared, and commander refuses them as
 * unknown options — which is the honest shape of the answer, since a flag declared in
 * order to refuse it would still be a flag readers could believe exists.
 *
 * Nothing here reaches a network. The stage has no client, no transport and no
 * publisher, and this module imports none, so `published` is a literal false by
 * construction rather than by a check. The last line of every screen says so in the
 * words the spec asked for, including on the screen where a person has just approved.
 */

export interface PrCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  /** The 64-hex digest of the page being approved — the only way to say yes. */
  readonly approve?: string;
}

export async function prAction(
  runId: string,
  options: PrCommandOptions,
  deps: Partial<PrStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const env = options.env ?? process.env;
  const renderer = createRenderer({ color: resolveColor(options.noColor === true, env) });
  const result = await runPrStage(
    {
      runId,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.approve ? { approve: options.approve } : {}),
    },
    deps,
  );

  if (options.json) {
    write(
      JSON.stringify(
        {
          runId: result.runId,
          outcome: result.outcome,
          readiness: result.readiness.readiness,
          digest: result.digest,
          // Two different questions, answered separately: did a human agree, and did
          // anything happen. In this build the second is always false, and a consumer
          // that reads only the first would be reading half the news.
          approved: result.decision?.allowed === true,
          published: result.published,
          candidate: result.candidate,
          decision: result.decision,
          recordFile: result.recordFile,
          checks: result.checks,
          record: result.record,
        },
        null,
        2,
      ),
    );
    return exitForOutcome(result.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — the pull request a human approves`));
  write('');
  write(formatPr(result, renderer));
  return exitForOutcome(result.outcome);
}

export function formatPr(result: PrStageResult, renderer: Renderer): string {
  const lines: string[] = [];

  for (const check of result.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(24)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', result.record.runId));
  lines.push(label('Outcome', result.record.outcome));
  lines.push(label('Readiness', result.readiness.readiness));
  lines.push(label('Page', pageText(result.candidate)));
  lines.push('');

  if (result.candidate) {
    lines.push(renderer.heading('The page a reviewer would read'));
    lines.push(...bodyLines(result.candidate));
    lines.push('');
  } else {
    lines.push(renderer.heading('There is no page to read yet'));
    lines.push(
      `  ${renderer.dim(
        'Everything above names what is missing. This command assembles a page from recorded evidence and will not write one from a guess.',
      )}`,
    );
    lines.push('');
  }

  if (result.decision?.requiresApproval && result.digest) {
    // A reader must never have to re-derive a digest to say yes, and must never be
    // offered a yes that was not printed with a page above it.
    lines.push(
      `  to record that you approve exactly the page above: mergesutra pr ${result.runId} --approve ${result.digest}`,
    );
    lines.push('');
  }

  if (result.record.limitations.length > 0) {
    lines.push(renderer.heading('What the run itself could not settle'));
    for (const limitation of result.record.limitations) {
      lines.push(`  - ${limitation}`);
    }
    lines.push('');
  }

  if (result.recordFile) lines.push(label('Record', result.recordFile));
  lines.push(label('Next', result.record.nextStage));
  lines.push('');
  lines.push(renderer.heading('NO REMOTE CHANGE HAS BEEN MADE.'));
  lines.push(
    `  ${renderer.dim(
      'No branch was pushed and no pull request was opened. An approval here records a decision ' +
        'about one page; this build has no publication remote, so it has no action to take on it.',
    )}`,
  );
  return lines.join('\n');
}

function pageText(candidate: PublicationCandidate | null): string {
  if (!candidate) return 'none assembled — nothing has been proposed';
  return `${candidate.proposedBranch} → ${candidate.targetBranch} (${candidate.repository})`;
}

/**
 * The body as it would be sent, indented rather than re-summarised. A screen that
 * paraphrased the page it was asking to be approved would be approving its own
 * wording instead of the record's.
 */
function bodyLines(candidate: PublicationCandidate): string[] {
  return [`  ${candidate.prTitle}`, '', ...candidate.prBody.split('\n').map((l) => `  ${l}`)];
}

function label(name: string, value: string): string {
  return `${name.padEnd(12)}${value}`;
}
