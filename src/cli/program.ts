import { Command, CommanderError } from 'commander';
import { doctorAction, type DoctorDeps } from './doctor.js';
import { createRenderer, resolveColor } from './render.js';
import { PRODUCT_NAME, TAGLINE, VERSION } from '../version.js';
import { isAppError } from '../core/errors.js';
import { defaultRedactor } from '../security/redaction.js';

/**
 * MergeSutra command surface.
 *
 * The one-command hero workflow is `mergesutra issue <url>`. The phase commands
 * (`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`, `pr`)
 * exist for transparency, debugging and recovery — but at Stage 0 only `doctor`
 * and metadata are wired up. Every unfinished command says so truthfully rather
 * than pretending to work.
 */

export interface ProgramDeps {
  doctor?: Partial<DoctorDeps>;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  setExitCode?: (code: number) => void;
}

const PLANNED = [
  { name: 'issue <github-url>', summary: 'Full hero workflow: issue → evidence-backed PR draft.' },
  { name: 'inspect', summary: 'Repository + policy discovery.' },
  { name: 'contract', summary: 'Build / show the Acceptance Contract.' },
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
            renderer.dim('Currently working commands: doctor, --help, --version.'),
            renderer.dim('Progress: see docs/ROADMAP.md'),
          ].join('\n'),
        );
        // Non-zero exit: a planned command must not masquerade as a successful run.
        setExitCode(2);
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
      return error.kind === 'config' ? 78 : 1;
    }
    writeErr(
      `error: ${defaultRedactor.text(error instanceof Error ? error.message : String(error))}`,
    );
    return 1;
  }
}
