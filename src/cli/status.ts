import { PRODUCT_NAME } from '../version.js';
import { runStatusStage, type StatusStageDeps } from '../lifecycle/status.js';
import type { StatusSnapshot } from '../lifecycle/snapshot.js';
import { EXIT } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';

/**
 * `mergesutra status [run-id]` — Stage 11.
 *
 * This is the screen a person reads after a machine has been working, in a directory
 * somebody else may have edited, to decide whether to spend another model call. It
 * gets exactly one job: describe. It runs no gate, calls no model, starts no command
 * from the repository, and writes no file — including not writing its own report, so
 * that opening this page cannot be the thing that changed what the page describes.
 *
 * Two rules shape the layout.
 *
 * **Recorded and observed stay in separate blocks, in that order.** A run whose
 * gates passed and whose files then moved has to be shown as `VERIFICATION_PASS`
 * *and* `STALE`, side by side, because either half alone is a different lie. The
 * graph rows are the arbiter of the second half, and they are printed verbatim from
 * the same document `--json` emits, so a reader can check any word on this screen
 * against the machine-readable one.
 *
 * **Nothing on this page may read like a verdict.** So there is no "healthy", no
 * "no defects", no "PR ready" and no "published". A review with no findings is
 * reported as `0 findings recorded`, which is a fact about a document and not a
 * claim about code; an approved page is reported as an approval and a remote as
 * `DISABLED`, in two different rows, because collapsing them is exactly how a
 * tool talks a person into believing a pull request exists.
 *
 * The exit code is the deliberate departure from the other stage commands, and it
 * is argued in docs/DECISIONS.md: this command returns 0 whenever it succeeded in
 * describing, *including when what it describes is blocked, stale or failed*, so
 * that a script can tell "STATUS COMMAND FAILED" (1, nothing was reported) from
 * "STATUS REPORTED A FAILED RUN" (0, and the snapshot says which).
 */

export interface StatusCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
}

export async function statusAction(
  runId: string | undefined,
  options: StatusCommandOptions,
  deps: Partial<StatusStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const env = options.env ?? process.env;
  const renderer = createRenderer({ color: resolveColor(options.noColor === true, env) });
  const result = await runStatusStage(
    {
      ...(runId ? { runId } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
    },
    deps,
  );

  if (options.json) {
    write(JSON.stringify(result.snapshot, null, 2));
    return EXIT.OK;
  }

  write(renderer.heading(`${PRODUCT_NAME} — where this run stands`));
  write('');
  write(formatStatus(result.snapshot, renderer));
  return EXIT.OK;
}

/** The words a lifecycle state gets when it is printed, in the state's own voice. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  CURRENT: 'CURRENT',
  STALE: 'STALE',
  UNMEASURABLE: 'CANNOT BE MEASURED',
  ABSENT: 'NOT RECORDED',
};

export function formatStatus(snapshot: StatusSnapshot, renderer: Renderer): string {
  const lines: string[] = [];
  // Sized to the longest truthful label on this page (`Escalated to a human`), because
  // a label that runs into its value is unreadable on the one screen whose entire job
  // is to be read correctly.
  const width = 22;

  lines.push(renderer.heading('What the stages recorded'));
  lines.push(row('Stage', snapshot.recorded.stage, width));
  lines.push(row('Outcome', snapshot.recorded.outcome, width));
  lines.push(row('Recorded at', snapshot.recorded.createdAt, width));
  lines.push(row('Version', snapshot.recorded.mergeSutraVersion, width));
  lines.push(row('Next stage', snapshot.recorded.nextStage, width));
  lines.push('');

  lines.push(renderer.heading('What is here now, read without changing it'));
  // First row of the section, because this screen is what a person reads before typing
  // `resume`, and the question they are asking it is whether another process is already
  // working on this run. It is read, never claimed: seeing a lock here takes nothing.
  lines.push(row('Run lock', snapshot.lock.state, width));
  lines.push(`  ${renderer.dim(snapshot.lock.detail)}`);
  lines.push(row('Workspace', snapshot.workspace.state, width));
  lines.push(`  ${renderer.dim(snapshot.workspace.detail)}`);
  lines.push(
    row(
      'Base',
      `${short(snapshot.workspace.recordedBaseSha)} recorded / ${short(snapshot.workspace.observedHead)} at HEAD`,
      width,
    ),
  );
  lines.push(
    row(
      'Patch',
      `${short(snapshot.patch.recorded)} recorded / ${short(snapshot.patch.current)} here now`,
      width,
    ),
  );
  lines.push(row('Patch status', state(snapshot.patch.status), width));
  lines.push(
    row(
      'Evidence pack',
      snapshot.report.packOnDisk === null
        ? 'not on disk'
        : `${short(snapshot.report.packOnDisk)} on disk`,
      width,
    ),
  );
  lines.push(
    `  ${renderer.dim('The pack is rendered from the record, so losing it costs a command, not work.')}`,
  );
  lines.push('');

  // The graph, printed as the machine reads it. Every row is the same object
  // `--json` exposes, because a second opinion about currency on the way out is how
  // a screen ends up disagreeing with the document underneath it.
  lines.push(renderer.heading('Whether each recorded thing still describes these bytes'));
  const labelWidth = Math.max(...snapshot.lifecycle.rows.map((r) => r.artifact.length)) + 2;
  for (const each of snapshot.lifecycle.rows) {
    lines.push(
      `  ${each.artifact.padEnd(labelWidth)}${pad(state(each.state), 20)}${renderer.dim(each.reason)}`,
    );
  }
  lines.push('');

  pushStageDetail(lines, snapshot, renderer, width);

  if (snapshot.blockers.length > 0) {
    lines.push(renderer.heading('Blocked, and what a command here will not do about it'));
    for (const blocker of snapshot.blockers) {
      lines.push(`  - ${blocker}`);
    }
    lines.push('');
  }

  lines.push(renderer.heading('Safe next actions'));
  if (snapshot.safeNextActions.length === 0) {
    lines.push(
      `  ${renderer.dim(
        'None. This screen only offers commands whose preconditions hold right now, and none do — which is not the same as saying the run is finished.',
      )}`,
    );
  }
  for (const action of snapshot.safeNextActions) {
    lines.push(`  mergesutra ${action.command} ${snapshot.runId}`);
    lines.push(`  ${renderer.dim(action.reason)}`);
    lines.push(`  ${renderer.dim(`costs: ${action.requires.join(', ')}`)}`);
  }
  lines.push('');

  lines.push(label('Run', snapshot.runId, width));
  lines.push(label('Observed at', snapshot.observedAt, width));
  lines.push('');
  lines.push(
    `  ${renderer.dim(
      'Everything above is read from the run record, Git and the files in this directory. An old receipt stays an old receipt however neatly it is printed here.',
    )}`,
  );
  // The boundary line, last and on every path, including the paths where the news is
  // good: a description of a run is not an act upon one, and this command has no act
  // in it to leave to the reader's imagination.
  lines.push('');
  lines.push(renderer.heading('No files were changed.'));
  return lines.join('\n');
}

/**
 * The filed stages, in lifecycle order, with only the numbers they hold.
 *
 * Each block is skipped rather than emptied when its stage never filed anything: an
 * absent review is not a review that found nothing, and printing a zero for a stage
 * that never ran is how a two-hour-old run starts looking like a finished one.
 */
function pushStageDetail(
  lines: string[],
  snapshot: StatusSnapshot,
  renderer: Renderer,
  width: number,
): void {
  const { contract, plan, implementation, verification, evidence, review, repair, publication } =
    snapshot;

  if (contract) {
    lines.push(renderer.heading('Contract'));
    lines.push(
      row(
        'Criteria',
        `${contract.criteria} derived, ${contract.limitations} limitations, schema v${contract.version}`,
        width,
      ),
    );
    lines.push(
      row(
        'Untrusted',
        contract.untrusted
          ? 'yes — derived from issue text, which this build treats as data and never as an instruction'
          : 'no',
        width,
      ),
    );
    lines.push('');
  }

  if (plan) {
    lines.push(renderer.heading('Plan'));
    lines.push(
      row(
        'Shape',
        `${plan.changes} proposed changes, ${plan.criteriaCovered} criteria covered, ${plan.criteriaUnaddressed} unaddressed, ${plan.attempts} attempts`,
        width,
      ),
    );
    lines.push(row('Model', `${plan.model} (${plan.source})`, width));
    lines.push(
      `  ${renderer.dim('A plan is a proposal a model made. Nothing here confirms it ran.')}`,
    );
    lines.push('');
  }

  if (implementation) {
    lines.push(renderer.heading('Implementation loop'));
    lines.push(row('Status', implementation.status, width));
    lines.push(row('Termination', implementation.termination, width));
    lines.push(
      row(
        'Used',
        `${implementation.steps} steps, ${implementation.writes} writes, ${implementation.commands} commands, ${implementation.refused} refused`,
        width,
      ),
    );
    lines.push(
      row(
        'Left',
        `${implementation.budget.stepsLeft} steps, ${implementation.budget.writesLeft} writes, ${implementation.budget.commandsLeft} commands`,
        width,
      ),
    );
    lines.push('');
  }

  if (verification) {
    lines.push(renderer.heading('Verification'));
    lines.push(
      row(
        'Gates',
        `${verification.result} — ${verification.gates.total} gates (${gateSummary(verification)}) for patch ${short(verification.patchIdentity)}, ${state(verification.state)} for these bytes`,
        width,
      ),
    );
    lines.push(row('Plan', `revision ${verification.planRevision}`, width));
    if (verification.consent) {
      lines.push(
        row(
          'Consent',
          `${verification.consent.gateIds} gate ids, granted ${verification.consent.grantedAt} — ${state(verification.consent.state)}`,
          width,
        ),
      );
    } else {
      lines.push(row('Consent', 'none on record', width));
    }
    lines.push('');
  }

  if (evidence) {
    lines.push(renderer.heading('Criterion evidence'));
    lines.push(
      row(
        'Mapped',
        `${evidence.verified} verified, ${evidence.partial} partial, ${evidence.unverified} unverified, ${evidence.failed} failed, ${evidence.blocked} blocked, ${evidence.needsAHuman} for a human`,
        width,
      ),
    );
    lines.push(row('Contribution ready', 'never — no field in this build can set it', width));
    lines.push('');
  }

  if (review) {
    lines.push(renderer.heading('Review'));
    lines.push(
      row(
        'Findings',
        `${review.findings.total} findings recorded${severitySummary(review)}, ${state(review.state)} for these bytes`,
        width,
      ),
    );
    lines.push(
      row(
        'Disposition',
        review.routedToRepair
          ? 'a finding was weighed as something a repair cycle may act on'
          : 'nothing was routed to repair',
        width,
      ),
    );
    lines.push(row('Escalated to a human', review.escalatedToHuman ? 'yes' : 'no', width));
    lines.push(row('Attempts', `${review.attempts} by ${review.model}`, width));
    lines.push(
      row(
        'Read',
        `${short(review.reviewedPatchIdentity)} reviewed against ${short(review.currentPatchIdentity)} now on the page`,
        width,
      ),
    );
    lines.push('');
  }

  if (repair) {
    lines.push(renderer.heading('Repair'));
    lines.push(
      row(
        'Plan',
        repair.plan
          ? `cycle ${repair.plan.repairCycle} over ${repair.plan.findings} findings, ${repair.plan.expectedFiles} files, ${repair.plan.expectedChecks} checks — ${state(repair.planState)}`
          : 'none recorded',
        width,
      ),
    );
    lines.push(row('Approval', state(repair.approvalState), width));
    lines.push(
      row(
        'Executions',
        repair.executions.length === 0
          ? 'none'
          : repair.executions
              .map((e) => `#${String(e.repairCycle)} ${e.scope} (${short(e.patchAfterIdentity)})`)
              .join(', '),
        width,
      ),
    );
    lines.push('');
  }

  if (publication) {
    lines.push(renderer.heading('The page, the approval, and the remote — three separate facts'));
    lines.push(row('Candidates', `${publication.candidates} assembled`, width));
    if (publication.latest) {
      lines.push(row('Title', publication.latest.prTitle, width));
      lines.push(
        row(
          'Branches',
          `${publication.latest.proposedBranch} -> ${publication.latest.targetBranch}`,
          width,
        ),
      );
      lines.push(
        row(
          'Page digest',
          `${publication.latest.digest} for patch ${short(publication.latest.patchIdentity)}`,
          width,
        ),
      );
    } else {
      lines.push(row('Page', 'none assembled — nothing has been proposed', width));
    }
    // A human's yes and a publication are never the same line, and never the same
    // tense: one is a record of a decision about bytes, the other is an event that
    // has not happened in this build and cannot be inferred from the first.
    lines.push(
      row(
        'Human approval',
        publication.approval
          ? `${state(publication.approvalState)} — digest ${publication.approval.digest} at ${publication.approval.approvedAt}`
          : `${state(publication.approvalState)} — nobody has named a page`,
        width,
      ),
    );
    lines.push(row('Remote publication', 'DISABLED — this build has no remote to act on', width));
    lines.push('');
  }
}

function gateSummary(verification: NonNullable<StatusSnapshot['verification']>): string {
  const parts = Object.entries(verification.gates.byResult).map(([k, v]) => `${String(v)} ${k}`);
  return parts.join(', ') || 'no receipts';
}

function severitySummary(review: NonNullable<StatusSnapshot['review']>): string {
  const entries = Object.entries(review.findings.bySeverity).filter(([, count]) => count > 0);
  if (entries.length === 0) return '';
  return ` (${entries.map(([k, v]) => `${String(v)} ${k}`).join(', ')})`;
}

function state(value: string): string {
  return STATE_WORDS[value] ?? value;
}

function label(name: string, value: string, width: number): string {
  // Always at least two spaces of gutter, so a label that outgrows the column cannot
  // print `Remote publicationDISABLED` — a collision that would read as a state word.
  return `${name.padEnd(Math.max(name.length + 2, width))}${value}`;
}

function row(name: string, value: string, width: number): string {
  return `  ${label(name, value, width)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

function short(digest: string | null): string {
  if (!digest) return 'none';
  return digest.slice(0, 12);
}
