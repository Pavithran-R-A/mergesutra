import { Command, CommanderError } from 'commander';
import { doctorAction, type DoctorDeps } from './doctor.js';
import { issueAction, type IssueCommandOptions } from './issue.js';
import { inspectAction, type InspectCommandOptions } from './inspect.js';
import { contractAction, type ContractCommandOptions } from './contract.js';
import { planAction, type PlanCommandOptions } from './plan.js';
import { implementAction, type ImplementCommandOptions } from './implement.js';
import { verifyAction, type VerifyCommandOptions } from './verify.js';
import { reviewAction, type ReviewCommandOptions } from './review.js';
import { repairAction, type RepairCommandOptions } from './repair.js';
import { prAction, type PrCommandOptions } from './pr.js';
import { reportAction, type ReportCommandOptions, type ReportDeps } from './report.js';
import { statusAction, type StatusCommandOptions } from './status.js';
import { resumeAction, type ResumeCommandOptions } from './resume.js';
import type { ResumeStageDeps } from '../lifecycle/resume.js';
import type { StatusStageDeps } from '../lifecycle/status.js';
import type { IntakeDeps } from '../intake/intake.js';
import type { InspectDeps } from '../discovery/inspect.js';
import type { ContractDeps } from './contract.js';
import type { PlanDeps } from '../plan/plan.js';
import type { ImplementStageDeps } from '../implement/implement.js';
import type { VerifyStageDeps } from '../verify/stage.js';
import type { ReviewStageDeps } from '../review/stage.js';
import type { RepairStageDeps } from '../repair/stage.js';
import type { PrStageDeps } from '../pr/stage.js';
import { createRenderer, resolveColor } from './render.js';
import { EXIT } from './exit-codes.js';
import { LIMIT_CAPS } from '../implement/limits.js';
import { MAX_REPAIR_CYCLES_CEILING, MAX_REVIEW_CYCLES_CEILING } from '../repair/bounds.js';
import { PRODUCT_NAME, TAGLINE, VERSION } from '../version.js';
import { isAppError } from '../core/errors.js';
import { defaultRedactor } from '../security/redaction.js';

/**
 * MergeSutra command surface.
 *
 * The one-command hero workflow is `mergesutra issue <url>`. The phase commands
 * (`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `repair`, `report`,
 * `status`, `resume`, `pr`) exist for transparency, debugging and recovery. Through
 * Stage 11, `doctor`, the intake half of `issue`, `inspect`, `contract`, `plan`,
 * `implement`, `verify`, `review`, `repair`, `report`, `status`, `resume` and `pr`
 * are wired up; every unfinished command says so truthfully rather than pretending
 * to work. `run` — the unattended
 * end-to-end pipeline — is deliberately still planned: a pipeline that skipped
 * the human consent that `verify` requires would be unsafe, not convenient, so
 * the stages after it must land before an unattended mode can honestly exist.
 * `status` is the read-only half of recovery: it describes a run and its workspace
 * and has no act in it, which is why it exits 0 for a blocked run and 1 only when
 * there was nothing to describe. `resume` is the acting half, and it acts on one
 * stage at a time: it prints what it would do and what that costs, and only
 * `--execute` runs it — under the same gates the direct command has, so it brings no
 * consent, approval, credential or remote of its own. `pr` is wired but does not
 * publish: it prepares and approves a page locally, and this build has no remote to
 * open one against.
 */

export interface ProgramDeps {
  doctor?: Partial<DoctorDeps>;
  issue?: Partial<IntakeDeps>;
  inspect?: Partial<InspectDeps>;
  contract?: Partial<ContractDeps>;
  plan?: Partial<PlanDeps>;
  implement?: Partial<ImplementStageDeps>;
  verify?: Partial<VerifyStageDeps>;
  review?: Partial<ReviewStageDeps>;
  repair?: Partial<RepairStageDeps>;
  pr?: Partial<PrStageDeps>;
  report?: Partial<ReportDeps>;
  status?: Partial<StatusStageDeps>;
  resume?: Partial<ResumeStageDeps>;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  setExitCode?: (code: number) => void;
}

const PLANNED = [{ name: 'run', summary: 'Unattended end-to-end pipeline across all stages.' }];

export function buildProgram(deps: ProgramDeps = {}): Command {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((l: string) => process.stdout.write(l + '\n'));
  const writeErr = deps.writeErr ?? ((l: string) => process.stderr.write(l + '\n'));
  const setExitCode = deps.setExitCode ?? ((code: number) => (process.exitCode = code));

  const program = new Command();
  program
    .name('mergesutra')
    .description(`${PRODUCT_NAME} — ${TAGLINE}`)
    .version(VERSION, '-v, --version', 'Print MergeSutra version')
    .option('--no-color', 'Disable coloured output')
    .option('--json', 'Emit machine-readable JSON where supported')
    .exitOverride()
    .showHelpAfterError('(run `mergesutra --help` for usage)');

  program
    .command('doctor')
    .description('Diagnose the local environment without leaking secrets')
    .option('--connect', 'Also test reachability to the BharatCode endpoint')
    .action(async (opts: { connect?: boolean }) => {
      const noColorFlag = program.opts().color === false;
      const code = await doctorAction(
        { connect: opts.connect, noColor: noColorFlag },
        deps.doctor,
        write,
      );
      setExitCode(code);
    });

  program
    .command('issue [github-url]')
    .description('Intake: read an issue and establish the exact repository + base commit')
    .option('--repo <path>', 'use an existing local clone at <path> as well')
    .action(async (url: string | undefined, opts: { repo?: string }) => {
      const globals = program.opts();
      const options: IssueCommandOptions = {
        repo: opts.repo,
        json: globals.json === true,
        noColor: globals.color === false,
        env,
      };
      setExitCode(await issueAction(url, options, deps.issue, write));
    });

  program
    .command('inspect [repo-path]')
    .description('Read a repository and compile its contract: toolchain, gates, protected areas')
    .action(async (repoPath: string | undefined) => {
      const globals = program.opts();
      const options: InspectCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
      };
      setExitCode(await inspectAction(repoPath, options, deps.inspect, write));
    });

  program
    .command('contract [run-id]')
    .description('Turn what a run knows into the criteria it must prove')
    .option(
      '--criterion <text>',
      'add a requirement no file states; repeatable, and it must be attributed with --by',
      collect,
      [],
    )
    .option('--by <name>', 'who supplied the --criterion requirements (required with it)')
    .option(
      '--check <command>',
      'the command that proves the --criterion in the same position; repeatable, no shell syntax',
      collect,
      [],
    )
    .action(async (runId: string | undefined, opts: ContractCommandOptions) => {
      const globals = program.opts();
      const options: ContractCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
        criterion: opts.criterion,
        check: opts.check,
        by: opts.by,
      };
      setExitCode(await contractAction(runId, options, deps.contract, write));
    });

  program
    .command('plan [run-id]')
    .description("Ask BharatCode for an implementation plan against a run's criteria")
    .action(async (runId: string | undefined) => {
      const globals = program.opts();
      const options: PlanCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
      };
      setExitCode(await planAction(runId, options, deps.plan, write));
    });

  program
    .command('implement [run-id]')
    .description(
      'Run the bounded loop: BharatCode proposes actions, MergeSutra executes the allowed ones',
    )
    .option('--repo <path>', 'repository whose workspace this run owns (default: its recorded one)')
    .option('--model <id>', 'ask for this model instead of the configured one')
    .option('--max-steps <n>', `turn budget (1-${LIMIT_CAPS.maxSteps})`)
    .option('--max-writes <n>', `write budget (1-${LIMIT_CAPS.maxWrites})`)
    .option('--max-commands <n>', `command budget (1-${LIMIT_CAPS.maxCommands})`)
    .action(async (runId: string | undefined, opts: Record<string, string | undefined>) => {
      const globals = program.opts();
      // One Ctrl-C stops the loop between actions and aborts the request in
      // flight; the record is still written, because a cancelled run is a fact.
      const controller = new AbortController();
      const onInterrupt = (): void => controller.abort();
      process.on('SIGINT', onInterrupt);
      try {
        const options: ImplementCommandOptions = {
          json: globals.json === true,
          noColor: globals.color === false,
          env,
          repo: opts.repo,
          model: opts.model,
          maxSteps: opts['max-steps'] ?? opts.maxSteps,
          maxWrites: opts['max-writes'] ?? opts.maxWrites,
          maxCommands: opts['max-commands'] ?? opts.maxCommands,
          signal: controller.signal,
        };
        setExitCode(await implementAction(runId, options, deps.implement, write));
      } finally {
        process.removeListener('SIGINT', onInterrupt);
      }
    });

  program
    .command('verify [run-id]')
    .description(
      "Run the repository's own gates against the run's patch; exit codes decide, receipts record",
    )
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .option(
      '--allow <gate-id>',
      "consent to running this gate's repository command (repeat per gate; no wildcard exists)",
      collect,
      [] as string[],
    )
    .action(async (runId: string | undefined, opts: { repo?: string; allow?: string[] }) => {
      const globals = program.opts();
      const controller = new AbortController();
      const onInterrupt = (): void => controller.abort();
      process.on('SIGINT', onInterrupt);
      try {
        const options: VerifyCommandOptions = {
          json: globals.json === true,
          noColor: globals.color === false,
          env,
          repo: opts.repo,
          allow: opts.allow ?? [],
          signal: controller.signal,
        };
        setExitCode(await verifyAction(runId, options, deps.verify, write));
      } finally {
        process.removeListener('SIGINT', onInterrupt);
      }
    });

  program
    .command('review [run-id]')
    .description(
      'Second pair of eyes on the exact patch: a review files findings and edits nothing — it is the repair that would need consent',
    )
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .option(
      `--max-review-cycles <n>`,
      `review-cycle budget before a human takes over (1-${String(MAX_REVIEW_CYCLES_CEILING)}; lowering only)`,
    )
    .option(
      `--max-repair-cycles <n>`,
      `repair-cycle budget for the frozen plan (1-${String(MAX_REPAIR_CYCLES_CEILING)}; lowering only)`,
    )
    .action(
      async (
        runId: string | undefined,
        opts: { repo?: string; maxReviewCycles?: string; maxRepairCycles?: string },
      ) => {
        const globals = program.opts();
        const controller = new AbortController();
        const onInterrupt = (): void => controller.abort();
        process.on('SIGINT', onInterrupt);
        try {
          const options: ReviewCommandOptions = {
            json: globals.json === true,
            noColor: globals.color === false,
            env,
            repo: opts.repo,
            maxReviewCycles: opts.maxReviewCycles,
            maxRepairCycles: opts.maxRepairCycles,
            signal: controller.signal,
          };
          setExitCode(await reviewAction(runId, options, deps.review, write));
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
    );

  program
    .command('repair [run-id]')
    .description(
      'Execute the frozen repair plan — the only command that edits, and only against the plan digest approved here',
    )
    .option(
      '--approve-plan <digest>',
      'the frozen plan’s 64-hex digest, typed after reading it (the only way to authorise an edit)',
    )
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .option(
      '--max-review-cycles <n>',
      `review-cycle budget before a human takes over (1-${String(MAX_REVIEW_CYCLES_CEILING)}; lowering only)`,
    )
    .option(
      '--max-repair-cycles <n>',
      `repair-cycle budget for the frozen plan (1-${String(MAX_REPAIR_CYCLES_CEILING)}; lowering only)`,
    )
    .action(
      async (
        runId: string | undefined,
        opts: {
          approvePlan?: string;
          repo?: string;
          maxReviewCycles?: string;
          maxRepairCycles?: string;
        },
      ) => {
        const globals = program.opts();
        const controller = new AbortController();
        const onInterrupt = (): void => controller.abort();
        process.on('SIGINT', onInterrupt);
        try {
          const options: RepairCommandOptions = {
            json: globals.json === true,
            noColor: globals.color === false,
            env,
            approvePlan: opts.approvePlan,
            repo: opts.repo,
            maxReviewCycles: opts.maxReviewCycles,
            maxRepairCycles: opts.maxRepairCycles,
            signal: controller.signal,
          };
          setExitCode(await repairAction(runId, options, deps.repair, write));
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
    );

  program
    .command('report [run-id]')
    .description(
      'Render the evidence pack for a run; it reports what was decided, deciding nothing',
    )
    .action(async (runId: string | undefined) => {
      const globals = program.opts();
      const options: ReportCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
      };
      setExitCode(await reportAction(runId, options, deps.report, write));
    });

  program
    .command('pr <run-id>')
    .description(
      'Assemble the pull request page and record a human approval; nothing is pushed and no request is opened',
    )
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .option(
      '--approve <digest>',
      "the page's 64-hex publication digest, typed after reading it (the only way to say yes)",
    )
    .action(async (runId: string, opts: { repo?: string; approve?: string }) => {
      const globals = program.opts();
      const options: PrCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
        repo: opts.repo,
        approve: opts.approve,
      };
      setExitCode(await prAction(runId, options, deps.pr, write));
    });

  program
    .command('status [run-id]')
    .description(
      'Describe where a run stands against the bytes here now; reads only, and changes nothing',
    )
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .action(async (runId: string | undefined, opts: { repo?: string }) => {
      const globals = program.opts();
      const options: StatusCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
        repo: opts.repo,
      };
      setExitCode(await statusAction(runId, options, deps.status, write));
    });

  program
    .command('resume [run-id]')
    .description(
      'Continue a run from its last recoverable boundary; it shows the plan and changes nothing until --execute',
    )
    .option('--execute', 'run the one stage the printed plan names (nothing runs without it)')
    .option(
      '--repo <path>',
      'primary checkout whose workspace this run owns (default: its recorded one)',
    )
    .option(
      '--allow <gate-id>',
      "consent to running this gate's repository command (repeat per gate; no wildcard exists)",
      collect,
      [] as string[],
    )
    .action(
      async (
        runId: string | undefined,
        opts: { execute?: boolean; repo?: string; allow?: string[] },
      ) => {
        const globals = program.opts();
        // A resumed loop or gate round is as interruptible as the command it stands in
        // for, and for the same reason: a stop in the middle is a fact worth recording.
        const controller = new AbortController();
        const onInterrupt = (): void => controller.abort();
        process.on('SIGINT', onInterrupt);
        try {
          const options: ResumeCommandOptions = {
            json: globals.json === true,
            noColor: globals.color === false,
            env,
            repo: opts.repo,
            execute: opts.execute === true,
            allow: opts.allow ?? [],
            signal: controller.signal,
          };
          setExitCode(await resumeAction(runId, options, deps, write));
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
    );

  for (const planned of PLANNED) {
    const [name] = planned.name.split(' ');
    program
      .command(planned.name)
      .description(`${planned.summary} (planned)`)
      .action(() => {
        const renderer = createRenderer({
          color: resolveColor(program.opts().color === false, env),
        });
        write(
          [
            renderer.heading(`${PRODUCT_NAME} — '${name}' is planned, not yet implemented.`),
            renderer.row('INFO', planned.summary),
            '',
            renderer.dim(
              'Currently working commands: doctor, issue (intake), inspect, contract, plan, implement, verify, review, repair, report, status, resume, pr, --help, --version.',
            ),
            renderer.dim(
              'Of those, `pr` prepares and approves a page; no command in this build opens one. `resume` acts on one stage at a time, and only when told to.',
            ),
            renderer.dim('Progress: see docs/ROADMAP.md'),
          ].join('\n'),
        );
        // Non-zero exit: a planned command must not masquerade as a successful run.
        setExitCode(EXIT.PLANNED);
      });
  }

  program.configureOutput({
    writeOut: (str) => write(str.replace(/\n$/, '')),
    writeErr: (str) => writeErr(str.replace(/\n$/, '')),
  });

  return program;
}

/** Commander accumulator for a repeatable `--flag <value>` option. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parse argv and run the program, mapping failures to controlled exits. */
export async function run(
  argv: readonly string[] = process.argv,
  deps: ProgramDeps = {},
): Promise<number> {
  let exitCode = 0;
  const program = buildProgram({ ...deps, setExitCode: (code) => (exitCode = code) });
  const writeErr = deps.writeErr ?? ((l: string) => process.stderr.write(l + '\n'));
  try {
    await program.parseAsync([...argv]);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help / version / usage exits — commander already handled output.
      return error.exitCode ?? exitCode;
    }
    if (isAppError(error)) {
      writeErr(`error: ${defaultRedactor.text(error.message)}`);
      if (error.remediation) writeErr(`  ${defaultRedactor.text(error.remediation)}`);
      return error.kind === 'config' ? EXIT.CONFIG : EXIT.ERROR;
    }
    writeErr(
      `error: ${defaultRedactor.text(error instanceof Error ? error.message : String(error))}`,
    );
    return 1;
  }
}
