import { Command, CommanderError } from 'commander';
import { doctorAction, type DoctorDeps } from './doctor.js';
import { issueAction, type IssueCommandOptions } from './issue.js';
import { inspectAction, type InspectCommandOptions } from './inspect.js';
import { contractAction, type ContractCommandOptions } from './contract.js';
import type { IntakeDeps } from '../intake/intake.js';
import type { InspectDeps } from '../discovery/inspect.js';
import type { ContractDeps } from './contract.js';
import { createRenderer, resolveColor } from './render.js';
import { EXIT } from './exit-codes.js';
import { PRODUCT_NAME, TAGLINE, VERSION } from '../version.js';
import { isAppError } from '../core/errors.js';
import { defaultRedactor } from '../security/redaction.js';

/**
 * MergeSutra command surface.
 *
 * The one-command hero workflow is `mergesutra issue <url>`. The phase commands
 * (`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`, `pr`)
 * exist for transparency, debugging and recovery. Through Stage 3, `doctor`,
 * the intake half of `issue`, `inspect` and `contract` are wired up; every
 * unfinished command says so truthfully rather than pretending to work.
 */

export interface ProgramDeps {
  doctor?: Partial<DoctorDeps>;
  issue?: Partial<IntakeDeps>;
  inspect?: Partial<InspectDeps>;
  contract?: Partial<ContractDeps>;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  setExitCode?: (code: number) => void;
}

const PLANNED = [
  { name: 'plan', summary: 'BharatCode implementation plan.' },
  { name: 'run', summary: 'Implement in an isolated worktree (BharatCode).' },
  { name: 'verify', summary: 'Run deterministic verification gates.' },
  { name: 'review', summary: 'Independent BharatCode diff review.' },
  { name: 'report', summary: 'Render the evidence report.' },
  { name: 'pr', summary: 'Draft the pull request (requires human approval).' },
  { name: 'status', summary: 'Show the current run state.' },
  { name: 'resume', summary: 'Resume an interrupted run.' },
];

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
    .action(async (runId: string | undefined) => {
      const globals = program.opts();
      const options: ContractCommandOptions = {
        json: globals.json === true,
        noColor: globals.color === false,
        env,
      };
      setExitCode(await contractAction(runId, options, deps.contract, write));
    });

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
              'Currently working commands: doctor, issue (intake only), inspect, contract, --help, --version.',
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
