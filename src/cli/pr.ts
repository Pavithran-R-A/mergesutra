import { PRODUCT_NAME } from '../version.js';
import type { PublicationCandidate } from '../pr/candidate.js';
import { createGitHubPublicationRemote } from '../pr/github-publisher.js';
import { runPrStage, type PrStageDeps, type PrStageResult } from '../pr/stage.js';
import { exitForOutcome } from './exit-codes.js';
import {
  terminalSafeDocument,
  terminalSafeJson,
  terminalSafeText,
} from '../security/terminal-safety.js';
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
 * A yes is not a publication. Sending the approved page requires a second, explicit
 * `--publish`, and this module constructs the real transport only when that flag is
 * present. Without it the stage's own refusal is the only remote it has, and the
 * screen says no remote action was performed. With it, the screen reports exactly what
 * GitHub answered: a draft URL, or a failure that tells a person to inspect the remote.
 */

export interface PrCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  /** The 64-hex digest of the page being approved — the only way to say yes. */
  readonly approve?: string;
  /** Ask the GitHub transport to push the approved patch and open a draft PR. */
  readonly publish?: boolean;
}

export async function prAction(
  runId: string,
  options: PrCommandOptions,
  deps: Partial<PrStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const env = options.env ?? process.env;
  const renderer = createRenderer({ color: resolveColor(options.noColor === true, env) });
  const remote =
    deps.remote ?? (options.publish === true ? createGitHubPublicationRemote() : undefined);
  const result = await runPrStage(
    {
      runId,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.publish === true ? { publish: true } : {}),
    },
    { ...deps, ...(remote ? { remote } : {}) },
  );

  if (options.json) {
    write(
      terminalSafeJson({
        runId: result.runId,
        outcome: result.outcome,
        readiness: result.readiness.readiness,
        digest: result.digest,
        // Two different questions, answered separately: did a human agree, and did
        // GitHub report a draft. A consumer that reads only the first is reading a
        // decision, not a publication.
        approved: result.decision?.allowed === true,
        // `published` answers "did this invocation open one"; `recordedPublication`
        // is the draft this run already owns. A later read can have the second
        // without the first, and saying so is the difference between a fact and a
        // claim that nothing ever happened.
        published: result.published,
        publication: result.publication,
        recordedPublication: result.recordedPublication,
        candidate: result.candidate,
        decision: result.decision,
        recordFile: result.recordFile,
        checks: result.checks,
        record: result.record,
      }),
    );
    return exitForOutcome(result.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — the pull request a human approves`));
  write('');
  write(formatPr(result, renderer));
  return exitForOutcome(result.outcome);
}

export function formatPr(input: PrStageResult, renderer: Renderer): string {
  // Every row on this page is a single-line slot, so the document view escapes the line
  // break a value may carry. The page preview below is the deliberate exception: it is
  // the one block whose breaks are this screen's own structure, and it is escaped line by
  // line from the candidate itself, which is never modified.
  const result = terminalSafeDocument(input);
  const lines: string[] = [];

  // The readiness rows carry labels longer than any other screen's — `Readiness ·
  // verification-current` overruns the column Stages 1→5 use, and two of the
  // publication rows nearly do — so this page sizes itself to its own rows rather
  // than inheriting one. A label that runs into its sentence is unreadable on the
  // one page where somebody is deciding what to publish.
  const labelWidth = Math.max(...result.checks.map((check) => check.name.length)) + 2;
  for (const check of result.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(labelWidth)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', result.record.runId));
  lines.push(label('Outcome', result.record.outcome));
  lines.push(label('Readiness', result.readiness.readiness));
  lines.push(label('Page', pageText(result.candidate)));
  if (result.publication) {
    lines.push(
      label(
        'Draft',
        `#${String(result.publication.number)} ${result.publication.url} (${result.publication.branch} at ${result.publication.commitSha})`,
      ),
    );
  } else if (result.recordedPublication) {
    lines.push(
      label(
        'Draft',
        `#${String(result.recordedPublication.number)} ${result.recordedPublication.url} ` +
          '(recorded earlier; this command sent nothing)',
      ),
    );
  }
  lines.push('');

  if (input.candidate) {
    lines.push(renderer.heading('The page a reviewer would read'));
    lines.push(...bodyLines(input.candidate));
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
  } else if (
    result.decision?.allowed === true &&
    result.digest &&
    !result.publishRequested &&
    result.recordedPublication === null
  ) {
    // A yes is not a publication. The second, separate act is named here so nobody
    // has to guess that an approval alone was never going to open anything. A draft
    // already on file is not offered a second time.
    lines.push(
      `  to ask GitHub for a draft pull request carrying exactly the page above: mergesutra pr ${result.runId} --publish`,
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
  lines.push(
    `  ${renderer.dim(
      result.publication
        ? 'An approval records a decision; --publish is the act that sends it. This screen reports a ' +
            'draft that GitHub created and claims nothing further: merging is a human act.'
        : result.recordedPublication
          ? 'This run already holds a draft pull request from an earlier invocation. This screen ' +
            'reports that fact; it did not send anything, and merging is a human act in GitHub.'
          : result.publicationFailure
            ? 'This command asked the remote for a draft, and the rows above carry what it answered. ' +
              'This screen offers no further send: what the remote holds now is read in the remote, ' +
              'and merging is a human act.'
            : 'An approval here records a decision about one page. Without --publish no remote is asked, ' +
              'and no read of this screen can be mistaken for an event that did not happen.',
    )}`,
  );
  lines.push('');
  // The last three lines are the whole of what this command did, in the order a
  // reader should absorb them: whether a person said yes, what was sent, and what
  // is known to have changed. They are printed last and in the same place on every
  // path — including the path where a person has just approved, which is the one
  // where an overclaim would be believed — because a boundary that only appears
  // when the news is bad is a boundary readers learn to skip.
  lines.push(
    renderer.heading(
      result.decision?.allowed === true ? 'HUMAN APPROVAL RECORDED' : 'NO HUMAN APPROVAL RECORDED',
    ),
  );
  if (result.publication) {
    lines.push(renderer.heading('DRAFT PULL REQUEST OPENED'));
    lines.push(renderer.heading('NOT MERGED — MERGING IS A HUMAN ACT IN GITHUB.'));
  } else if (result.recordedPublication) {
    lines.push(renderer.heading('DRAFT PULL REQUEST ALREADY RECORDED'));
    lines.push(renderer.heading('NOTHING WAS SENT BY THIS COMMAND; NOTHING HAS BEEN MERGED.'));
  } else if (result.publicationFailure) {
    lines.push(renderer.heading('REMOTE PUBLICATION FAILED'));
    lines.push(
      renderer.heading('THE REMOTE MAY HAVE CHANGED — INSPECT IT BEFORE DECIDING WHAT TO DO.'),
    );
  } else {
    // Both ways of arriving here — no --publish, and --publish without an approval —
    // asked no remote for anything. The capability exists; this invocation did not
    // use it, and the screen says that rather than implying publication is disabled.
    lines.push(renderer.heading('REMOTE PUBLICATION NOT ATTEMPTED'));
    lines.push(renderer.heading('NO REMOTE CHANGE HAS BEEN MADE.'));
  }
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
 *
 * Encoded line by line, in text mode: this is the one place on the page where a line
 * break is the document's own and has to stay a break. The candidate it reads is the
 * candidate the digest was computed over, untouched.
 */
function bodyLines(candidate: PublicationCandidate): string[] {
  return [
    `  ${terminalSafeText(candidate.prTitle)}`,
    '',
    ...candidate.prBody.split('\n').map((line) => `  ${terminalSafeText(line)}`),
  ];
}

function label(name: string, value: string): string {
  return `${name.padEnd(12)}${value}`;
}
