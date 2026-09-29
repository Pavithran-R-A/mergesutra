import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  terminalSafeDocument,
  terminalSafeJson,
  terminalSafeSingleLine,
  terminalSafeText,
} from '../../src/security/terminal-safety.js';
import { statusAction } from '../../src/cli/status.js';
import { resumeAction } from '../../src/cli/resume.js';
import { formatIntake } from '../../src/cli/issue.js';
import { run as runProgram } from '../../src/cli/program.js';
import { doctorAction } from '../../src/cli/doctor.js';
import { createRenderer, resolveColor } from '../../src/cli/render.js';
import { AppError } from '../../src/core/errors.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { IntakeResult } from '../../src/intake/intake.js';
import type { Runner, RunResult } from '../../src/core/runner.js';
import type { Status } from '../../src/cli/render.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import { LOCK_OWNER_FILE_NAME, runLockDirectory } from '../../src/lifecycle/lock.js';
import { recordAt } from '../helpers/report.js';
import { cleanUp, NOW } from '../helpers/plan.js';

/**
 * S12-11 — the terminal is an output device, and untrusted text is holding the bytes.
 *
 * S12-17 settled a different question at these same sinks: *may this secret be visible?*
 * This file asks *may this byte change how the terminal displays everything printed
 * after it?* A masked credential and a cursor-movement sequence are unrelated
 * properties, and a screen that answers one has said nothing about the other.
 *
 * The measured surface, from the §1 walk of the current source:
 * - `src/cli/render.ts:41` is the only place that emits `\x1b[<code>m`, and it wraps
 *   whatever it is handed; every command passes it a value read out of a file.
 * - Twelve screens interpolate persisted text into rows that begin at the left margin
 *   (`label()`/`row()`), so a literal LF in one of those values writes a row there —
 *   which is exactly where `PASS`, `HUMAN APPROVAL RECORDED` and the headings live.
 * - `lock-state.ts:145` refuses to print a lock host that would type into a terminal,
 *   but `lock.ts:468` builds a *claim refusal* sentence out of the same unfiltered
 *   `owner.host`, and `formatResume` prints that sentence. One guard, two exits.
 * - `doctor.ts:53` prints the first line of a child process's stdout verbatim, and
 *   `doctor.ts:119` prints whatever a network health check chose to say in `note`.
 * - Eleven `--json` sinks write `JSON.stringify(...)`; stringify escapes C0 and stops
 *   there, so C1 (U+0080–U+009F, which holds CSI and OSC in their 8-bit forms), DEL,
 *   U+2028/9 and every bidi formatting control travel raw.
 * - The one control filter in `src/` is `sanitizeInline` (`github/schemas.ts:145`); it
 *   covers C0 plus DEL, and it is applied to GitHub issue titles and nothing else.
 *   `review/schema.ts:71` bounds a finding's length and trims it, so a genuine Stage 9
 *   document may hold an escape sequence, a CR and a bidi override.
 *
 * So the claim under test is narrow and mechanical: after MergeSutra has rendered a
 * value it did not write, no byte that could move a cursor, restyle a line, retitle the
 * window, open a hyperlink or reorder the text is present in what reached the sink —
 * while MergeSutra's own colour, the words the value carried, and the machine-readable
 * data behind it all survive. Vocabulary is not censored here; a fake `PASS` may still
 * be readable as data. What it may not do is become a status row.
 *
 * The cases labelled GUARD pass on the current source and are kept as regressions, not
 * counted as findings (§25: a test that never failed is not a witnessed finding). Every
 * hostile value below is a real code point in a real persisted document or a real child
 * process's output, not a picture of one.
 */

/**
 * The vocabulary these tests assert with — code points, escape-count invariants and
 * left-margin rows — lives in `tests/helpers/terminal.ts`, because the hostile-run hero
 * in `terminal-hero.test.ts` has to make the same claims about the same sinks.
 */
import {
  ALM,
  BEL,
  BS,
  CR,
  CSI8,
  DEL,
  ESC,
  FSI,
  LRE,
  LRI,
  LRM,
  LRO,
  LS,
  NUL,
  OSC8,
  PDF,
  PS,
  RLE,
  RLM,
  RLI,
  RLO,
  ST8,
  TAB,
  LF,
  PDI,
  shown,
  inertSpellingDecodes,
  activeControl,
  expectInert,
  onlyRendererOwnColour,
  forgedRows,
  counterfeitedRows,
  capture,
} from '../helpers/terminal.js';

const tempDirs: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('the central primitive: what a control character becomes', () => {
  it('replaces every C0 code point with its visible escape, one at a time', () => {
    for (let code = 0x00; code <= 0x1f; code += 1) {
      const char = String.fromCharCode(code);
      expect(terminalSafeSingleLine(`a${char}b`), `U+${code.toString(16)}`).toBe(
        `a${shown(code)}b`,
      );
    }
  });

  it('keeps the C0 matrix inert as a whole, in both modes', () => {
    const all = Array.from({ length: 0x20 }, (_, code) => `x${String.fromCharCode(code)}`).join('');

    expect(activeControl(terminalSafeSingleLine(all)), 'single-line mode').toBeNull();
    // Text mode exists for block material: a line break inside a block is structure the
    // screen itself asked for and re-indents. Nothing else in the value survives.
    expect(activeControl(terminalSafeText(all), LF + TAB), 'text mode').toBeNull();
    expect(terminalSafeText(`a${LF}b${TAB}c`)).toBe(`a${LF}b${TAB}c`);
  });

  it('escapes DEL and the whole C1 range, because an 8-bit ESC is still an ESC', () => {
    let all = DEL;
    for (let code = 0x80; code <= 0x9f; code += 1) all += String.fromCharCode(code);

    const out = terminalSafeText(all);
    expect(activeControl(out, LF + TAB), 'the C1 range').toBeNull();
    expect(out).toContain(shown(0x7f));
    expect(out).toContain(shown(0x9b));
    expect(out).toContain(shown(0x9d));
    expect(out).toContain(shown(0x9c));
  });

  it('escapes each bidirectional formatting control and no RTL letter', () => {
    const controls = [ALM, LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI];
    const out = controls.map((char) => terminalSafeText(`q${char}q`)).join(' ');

    expect(activeControl(out, LF + TAB), 'the Bidi_Control set').toBeNull();
    for (const char of controls) {
      expect(out, `U+${(char.codePointAt(0) ?? 0).toString(16)}`).toContain(
        shown(char.codePointAt(0) ?? 0),
      );
    }
  });

  it('escapes the line and paragraph separators JSON leaves raw', () => {
    expect(activeControl(terminalSafeText(`a${LS}b${PS}c`), LF + TAB), 'U+2028/U+2029').toBeNull();
    expect(terminalSafeText(`a${LS}b`)).toBe(`a${shown(0x2028)}b`);
    expect(terminalSafeText(`a${PS}b`)).toBe(`a${shown(0x2029)}b`);
  });

  it('GUARD: leaves the ordinary text a real repository is made of exactly as it was', () => {
    // The restraint that stops this becoming "strip anything unusual". A build that
    // mangles Devanagari, Arabic, Hebrew, emoji or box drawing is not safer — the
    // reader simply trusts it less. Passes on the current source; kept as a regression.
    for (const sample of [
      'दिनांक प्रारूपण — datekit',
      'تاريخ صالح غير مقبول',
      'תאריך לא חוקי',
      'Urdu: قابلِ قبول نہیں',
      'empty input → TypeError 🙏',
      '┌───┬───┐\n│ a │ b │\n└───┴───┘',
      'a\\b/c “smart quotes’ — en, em',
      'C:\\Users\\name\\Documents\\repo.tsx',
    ]) {
      expect(terminalSafeText(sample), sample).toBe(sample);
    }
  });

  it('is deterministic, pure and idempotent', () => {
    const hostile = `${ESC}[2JPR CREATED${BEL}${RLO}PASS${PDF}`;
    const once = terminalSafeText(hostile);

    expect(terminalSafeText(hostile)).toBe(once);
    expect(terminalSafeText(once)).toBe(once);
    expect(terminalSafeSingleLine(`a${LF}b${TAB}c`)).toBe(`a${shown(0x0a)}b${shown(0x09)}c`);
    expect(terminalSafeSingleLine(terminalSafeSingleLine(`a${LF}b`))).toBe(
      terminalSafeSingleLine(`a${LF}b`),
    );
  });

  it('neutralises CSI, OSC title, OSC 8 and the 8-bit forms without hiding them', () => {
    // `readable` is a run of printable text each payload actually carries, so the
    // assertion proves the words survive rather than assuming every fixture uses the
    // same three of them.
    const fixtures: readonly [string, string, string][] = [
      ['clear the screen', `${ESC}[2J${ESC}[H`, '2J'],
      ['recolor the row', `${ESC}[31m${ESC}[0m`, '31m'],
      ['cursor up and back', `${ESC}[1A${ESC}[999D`, '999D'],
      ['switch the buffer', `${ESC}[?1049h${ESC}[?1049l`, '?1049h'],
      ['retitle the window (BEL-terminated)', `${ESC}]0;MERGESUTRA APPROVED${BEL}`, 'MERGESUTRA'],
      ['retitle the window (ST-terminated)', `${ESC}]2;MERGESUTRA APPROVED${ESC}\\`, 'MERGESUTRA'],
      [
        'an active hyperlink',
        `${ESC}]8;;https://evil.example${ESC}\\click-me${ESC}]8;;${ESC}\\`,
        'https://evil.example',
      ],
      ['the 8-bit equivalents', `${OSC8}8;;https://evil.example${ST8}x${CSI8}2J`, 'evil.example'],
    ];

    for (const [what, value, readable] of fixtures) {
      const out = terminalSafeText(value);
      expect(activeControl(out, LF + TAB), what).toBeNull();
      // Every fixture opens with the control it is named for, including the 8-bit ones,
      // which carry no ASCII ESC at all — so the spelling to look for is theirs.
      expect(out, what).toContain(shown(value.codePointAt(0) ?? 0));
      // The words survive as data: this is an encoding, not a denial of evidence.
      expect(out, what).toContain(readable);
      // And nothing at all was dropped — decoding the spellings gives the payload back.
      expect(inertSpellingDecodes(out), `${what} lost bytes`).toBe(value);
    }
  });

  it('GUARD: never touches the bytes it was handed', () => {
    const hostile = `${ESC}[2JPASS`;
    const copy = hostile;
    terminalSafeText(hostile);
    terminalSafeSingleLine(hostile);
    expect(hostile).toBe(copy);
  });

  it('GUARD: §21 — leaves a screen that bounds a value no half sequence to act on', () => {
    // Screens cut rows short, and a cut has to fall somewhere. Because the escaping
    // happens before any bound, the characters a bound can split are the six of a
    // spelling — so no prefix of a bounded value is a live sequence. This is the reason
    // no existing truncation was widened for this item.
    const escaped = terminalSafeSingleLine(`${ESC}]0;MERGESUTRA APPROVED${BEL}${ESC}[2J`);

    for (let bound = 1; bound < escaped.length; bound += 1) {
      const piece = escaped.slice(0, bound);
      expect(activeControl(piece, ''), `bounded at ${bound}`).toBeNull();
      expect(piece).not.toContain(ESC);
    }
    // And the bound itself is what a reader sees: the payload's words stay in the row.
    expect(escaped.startsWith(`${shown(0x1b)}]0;MERGESUTRA`)).toBe(true);
  });
});

describe('the display copy of a document', () => {
  it('escapes every string leaf and leaves the rest of the record intact', () => {
    const source = {
      runId: 'run-1',
      steps: 4,
      ok: true,
      absent: null,
      rows: [{ label: `${ESC}[2JPR CREATED`, count: 2 }],
      nested: { detail: `host ${RLO}example${PDF}` },
    };
    const before = JSON.stringify(source);

    const view = terminalSafeDocument(source);

    expect(JSON.stringify(source), 'the copy mutated the document it was handed').toBe(before);
    expect(view.rows[0]?.label).toContain(shown(0x1b));
    expect(view.nested.detail).toContain(shown(0x202e));
    expect(view.steps).toBe(4);
    expect(view.ok).toBe(true);
    expect(view.absent).toBeNull();
    expect(activeControl(JSON.stringify(view), LF + TAB), 'the view').toBeNull();
  });

  it('keeps a key named __proto__ a key, and makes its value inert', () => {
    // A JSON *escape*, not a raw byte: a parser refuses a raw control inside a string
    // literal, so the hostile payload has to arrive the way a real one does.
    const hostile = JSON.parse(`{"__proto__":"${shown(0x1b)}[2J","ok":1}`) as Record<
      string,
      unknown
    >;
    expect(hostile['__proto__'], 'the fixture itself').toBe(`${ESC}[2J`);

    const view = terminalSafeDocument(hostile);

    expect(Object.prototype.hasOwnProperty.call(view, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(view), 'the copy acquired a hostile prototype').toBe(
      Object.prototype,
    );
    expect(String(view['__proto__'])).toContain(shown(0x1b));
  });

  it('names an inert host key the way the screen that reads it needs', () => {
    const view = terminalSafeDocument({ files: [`src/foo${LF}HUMAN APPROVAL RECORDED.txt`] });
    expect(activeControl(view.files[0] ?? ''), 'a filename').toBeNull();
    expect(view.files[0]).toContain('HUMAN APPROVAL RECORDED.txt');
  });
});

describe('the --json sinks: same data, inert bytes', () => {
  it('round-trips exactly, and carries no active control', () => {
    const document = {
      runId: 'run-1',
      nextStage: `PLAN${RLO}PASS`,
      lock: { host: `elsewhere${OSC8}0;FAKE${ST8}`, pid: 4_321 },
      rows: [{ reason: `${CSI8}2J`, count: 0, gone: null }],
      unicode: 'दिनांक 🙏 تاريخ',
      separators: `a${LS}b${PS}c`,
    };
    const encoded = terminalSafeJson(document);

    expect(activeControl(encoded, LF + TAB), 'terminalSafeJson output').toBeNull();
    expect(JSON.parse(encoded)).toEqual(document);
    // The data is still the data: parsing restores the code point, so a consumer reads
    // what the record holds rather than what the terminal was shown.
    expect((JSON.parse(encoded) as typeof document).nextStage).toContain(RLO);
    expect(encoded).toContain(shown(0x202e));
    expect(encoded).toContain('दिनांक');
  });

  it('GUARD: leaves the C0 escapes JSON.stringify already wrote alone', () => {
    const value = { text: `a${BEL}${LF}${TAB}"\\${ESC}[31m${NUL}` };
    const encoded = terminalSafeJson(value);

    expect(activeControl(encoded, LF + TAB), 'C0 in serialized JSON').toBeNull();
    expect(JSON.parse(encoded)).toEqual(value);
    expect(encoded).toContain('\\u0007');
    expect(encoded).toContain('\\n');
  });
});

describe('the status screen, the page a person acts on', () => {
  const RUN_ID = 'run-20260924T000000Z-aaaaaa';

  interface Screen {
    runsRoot: string;
    store: ReturnType<typeof createFileRunStore>;
    cwd: string;
    human: (noColor?: boolean) => Promise<string>;
    json: () => Promise<string>;
  }

  /**
   * One hostile record, read the way the command reads it: from a real file store in a
   * real directory, with a real lock owner file next to it. `nextStage` is the row a
   * person copies a command from, so it carries all three forgeries at once — a clear
   * the screen, an overwrite of its own row, and a fresh row claiming a pass.
   */
  const NEXT_STAGE =
    `PLAN: clear the page and claim a pass — ${ESC}[2J${ESC}[HPR CREATED${BEL}` +
    `, last gate failed${CR}VERIFICATION PASS` +
    `${LF}PASS — every criterion verified` +
    `, and the half you should distrust: ${RLO}CONTRIBUTION_READY${PDF}` +
    `, plus ${CSI8}2J${OSC8}0;EIGHT-BIT-TITLE${ST8}`;

  async function screen(): Promise<Screen> {
    const cwd = await scratch('mergesutra-terminal-status-');
    const runsRoot = path.join(cwd, '.mergesutra', 'runs');
    const store = createFileRunStore(runsRoot);
    await mkdir(runsRoot, { recursive: true });
    await store.save(
      recordAt({
        runId: RUN_ID,
        createdAt: '2026-09-24T00:00:00.000Z',
        nextStage: NEXT_STAGE,
      }),
    );
    const lockDir = runLockDirectory(runsRoot, RUN_ID);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, LOCK_OWNER_FILE_NAME),
      JSON.stringify({
        runId: RUN_ID,
        operation: 'resume',
        pid: 4_321,
        // A lock file is a file any process on this machine could have written, and its
        // host name is printed as the holder's identity.
        host: `attacker${ESC}]0;MERGESUTRA APPROVED${BEL}.example`,
        createdAt: '2026-09-26T00:00:00.000Z',
        token: 'ab'.repeat(16),
      }),
      'utf8',
    );

    const drive = async (options: Parameters<typeof statusAction>[1]): Promise<string> => {
      const out = capture();
      const code = await statusAction(
        RUN_ID,
        { env: { NO_COLOR: '1' }, ...options },
        {
          store,
          cwd,
          runsRoot,
          now: () => NOW,
          lock: { pid: 9_000, host: 'this-machine', isProcessAlive: () => false },
        },
        out.write,
      );
      expect(code).toBe(0);
      return out.text();
    };

    return {
      runsRoot,
      store,
      cwd,
      human: (noColor) => drive(noColor === false ? { env: {} } : {}),
      json: () => drive({ json: true }),
    };
  }

  it('cannot be made to move the cursor, retitle itself, or ring the bell', async () => {
    const page = await (await screen()).human();

    expectInert(page, 'the status screen');
    // The screen is still the screen: its own heading and rows are where they were.
    expect(page).toContain('MergeSutra — where this run stands');
    expect(page).toContain('Next stage');
    expect(page).toContain('No files were changed.');
    // And the attacker's words are still readable as data, not deleted.
    expect(page).toContain('PR CREATED');
    expect(page).toContain('VERIFICATION PASS');
    expect(page).toContain('CONTRIBUTION_READY');
    expect(page).toContain('clear the page and claim a pass');
  });

  it('cannot be made to write a row at the left margin', async () => {
    const page = await (await screen()).human();

    // Only MergeSutra's own badges may open a line here. A `PASS` from the record has to
    // sit inside its row, or inside the visible escape that neutralised the byte in front
    // of it — never as a line of its own, which is what a raw LF or CR buys.
    expect(forgedRows(page), `rows the record forged: ${JSON.stringify(forgedRows(page))}`).toEqual(
      [],
    );
    expect(page).not.toContain(CR);
    expect(page.split(LF).filter((line) => line.startsWith('PASS'))).toEqual([]);
  });

  it('holds its ground with colour on, and with NO_COLOR set', async () => {
    const colourless = await screen();
    const plain = await colourless.human();
    expectInert(plain, 'the status screen (NO_COLOR)');
    expect(plain).not.toContain(ESC);

    const coloured = await screen();
    const out = capture();
    await statusAction(
      RUN_ID,
      { env: {} },
      {
        store: coloured.store,
        cwd: coloured.cwd,
        runsRoot: coloured.runsRoot,
        now: () => NOW,
        lock: { pid: 9_000, host: 'this-machine', isProcessAlive: () => false },
      },
      out.write,
    );
    const page = out.text();

    // Safety may not be bought by giving up the renderer: its own colour is still there.
    expect(page).toContain(`${ESC}[1m`);
    expect(page).toContain(`${ESC}[90m`);
    // …and it is the *only* thing on the page that can still talk to the terminal.
    onlyRendererOwnColour(page, 'the status screen (colour on)');
    expect(page).toContain(shown(0x1b));
    expect(page).toContain('PR CREATED');
  });

  it('GUARD: refuses to print a lock host that would type into a terminal', async () => {
    // `lock-state.ts:145` already answers this one, by refusing the whole value. Kept
    // because the refusal is the only thing standing between this field and an OSC 0,
    // and a later "just print the raw host for debuggability" change must fail here.
    const page = await (await screen()).human();

    expect(page).toContain('a name this build will not print');
    expect(page).not.toContain('MERGESUTRA APPROVED');
  });

  it('emits JSON whose bytes are inert and whose data is the record', async () => {
    const text = await (await screen()).json();

    expectInert(text, 'status --json');
    const snapshot = JSON.parse(text) as {
      recorded: { nextStage: string };
      lock: { holder: { host: string | null } };
    };
    // The escape is a display decision and nothing more: the code point is still the
    // value a consumer reads, exactly as the record holds it.
    expect(snapshot.recorded.nextStage).toBe(NEXT_STAGE);
    expect(snapshot.recorded.nextStage).toContain(ESC);
    expect(snapshot.lock.holder.host).toBeNull();
  });

  it('GUARD: renders from a record it leaves byte for byte on the disk', async () => {
    const target = await screen();
    const file = path.join(target.runsRoot, `${RUN_ID}.json`);
    const before = await readFile(file, 'utf8');

    await target.human();
    await target.json();

    expect(await readFile(file, 'utf8')).toBe(before);
    expect(before).toContain('PR CREATED');
  });
});

describe('the resume preview, which describes an action without taking it', () => {
  const RUN_ID = 'run-20260924T000000Z-aaaaaa';
  const HOSTILE_HOST = `elsewhere${ESC}]8;;https://evil.example${ESC}\\${BEL}.example`;

  it('cannot be made to print EXECUTED, PASS or an approval it did not earn', async () => {
    const cwd = await scratch('mergesutra-terminal-resume-');
    const runsRoot = path.join(cwd, '.mergesutra', 'runs');
    const store = createFileRunStore(runsRoot);
    await mkdir(runsRoot, { recursive: true });
    await store.save(
      recordAt({
        runId: RUN_ID,
        createdAt: '2026-09-24T00:00:00.000Z',
        nextStage: `Decide after the cursor goes up: ${ESC}[1AEXECUTED${BEL}`,
      }),
    );
    const lockDir = runLockDirectory(runsRoot, RUN_ID);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, LOCK_OWNER_FILE_NAME),
      JSON.stringify({
        runId: RUN_ID,
        operation: 'resume',
        pid: 5_678,
        // The status screen refuses this string; the claim refusal is built out of the
        // same bytes by `lock.ts:468` and printed by `formatResume`.
        host: HOSTILE_HOST,
        createdAt: '2026-09-26T00:00:00.000Z',
        token: 'cd'.repeat(16),
      }),
      'utf8',
    );

    let stagesRun = 0;
    const deps = {
      resume: {
        store,
        cwd,
        runsRoot,
        now: () => NOW,
        pid: 9_000,
        host: 'this-host',
        isProcessAlive: () => false,
        executeStage: async () => {
          stagesRun += 1;
          throw new Error('the preview must never reach a stage');
        },
      },
    };

    const human = capture();
    await resumeAction(RUN_ID, { env: { NO_COLOR: '1' }, execute: true }, deps, human.write);
    const page = human.text();

    expectInert(page, 'the resume screen');
    expect(page).toContain('Blocked');
    // The host name is still on the page as data — the reader needs to know which
    // machine is being blamed for holding the lock.
    expect(page).toContain('elsewhere');
    expect(page).toContain('https://evil.example');
    expect(forgedRows(page)).toEqual([]);
    expect(page.split(LF).filter((line) => /^EXECUTED\b/.test(line))).toEqual([]);

    const machine = capture();
    await resumeAction(
      RUN_ID,
      { env: { NO_COLOR: '1' }, execute: true, json: true },
      deps,
      machine.write,
    );
    expectInert(machine.text(), 'resume --json');
    const parsed = JSON.parse(machine.text()) as { kind: string; message: string };
    expect(parsed.kind).toBe('BLOCKED');
    expect(parsed.message).toContain(HOSTILE_HOST);
    expect(() => JSON.parse(machine.text())).not.toThrow();

    // §5's constraint on this file, measured: the blocked action never reached the
    // dispatcher, so no stage and no model ran, and the record did not move.
    expect(stagesRun).toBe(0);
  });
});

describe('the error path, which prints text a failure left behind', () => {
  const hostileMessage = `Cannot read the record: ${ESC}[2JPASS${BEL}`;
  const hostileRemediation = `Re-save it without the backspace${BS}${BS}${BS}overwrite`;

  function failingStore(thrown: unknown) {
    return {
      load: async () => {
        throw thrown;
      },
      save: async () => '',
      list: async () => {
        throw new Error('not reached');
      },
    };
  }

  it('neutralises an AppError after redaction and before stderr, and does not edit the error', async () => {
    const thrown = new AppError({
      kind: 'validation',
      message: hostileMessage,
      remediation: hostileRemediation,
    });
    const err = capture();
    const code = await runProgram(['node', 'mergesutra', 'status', 'run-1'], {
      status: {
        store: failingStore(thrown),
        cwd: 'C:\\',
        runsRoot: 'C:\\',
      },
      write: () => undefined,
      writeErr: (line) => err.lines.push(line),
      env: { NO_COLOR: '1' },
    });

    expect(code).not.toBe(0);
    expectInert(err.text(), 'the terminal error line');
    expect(err.text()).toContain('PASS');
    // Display-only, in both directions: the object a caller can still catch is the
    // object that was thrown, byte for byte.
    expect(thrown.message).toBe(hostileMessage);
    expect(thrown.remediation).toBe(hostileRemediation);
  });

  it('neutralises an unexpected Error too', async () => {
    const err = capture();
    await runProgram(['node', 'mergesutra', 'status', 'run-1'], {
      status: {
        store: failingStore(new Error(`${ESC}]0;TITLE${BEL} and ${OSC8}2J`)),
        cwd: 'C:\\',
        runsRoot: 'C:\\',
      },
      write: () => undefined,
      writeErr: (line) => err.lines.push(line),
      env: { NO_COLOR: '1' },
    });

    expectInert(err.text(), 'the unexpected-error line');
    expect(err.text()).toContain('TITLE');
  });
});

describe('the doctor screen, which prints a child process and a remote answer', () => {
  it('cannot be cleared or retitled by the program it just ran', async () => {
    const leaked: RunResult = {
      code: 0,
      stdout: `git version 2.45${ESC}[2JPR CREATED${BEL}${LF}second line nobody asked for`,
      stderr: `${ESC}]0;MERGESUTRA APPROVED${BEL}`,
      timedOut: false,
      truncated: false,
    };
    const client = {
      healthCheck: async () => ({
        reachable: false,
        configured: true,
        note: `TLS terminated at ${ESC}]8;;https://evil.example${ESC}\\evil${BEL}`,
      }),
    } as unknown as BharatCodeClient;
    const out = capture();
    await doctorAction(
      { noColor: true, connect: true },
      {
        env: { BHARATCODE_API_KEY: 'sk-doctor-TERMINALFIXTURE-000' },
        nodeVersion: '24.18.0',
        run: (async () => leaked) satisfies Runner,
        makeClient: () => client,
      },
      out.write,
    );

    expectInert(out.text(), 'the doctor screen');
    expect(out.text()).toContain('git version 2.45');
    expect(out.text()).toContain('MergeSutra doctor');
    expect(out.text()).toContain('evil.example');
    expect(out.text()).not.toContain('sk-doctor-TERMINALFIXTURE-000');
    expect(counterfeitedRows(out.text(), ['PR CREATED', 'MERGESUTRA APPROVED'])).toEqual([]);
  });
});

describe('the intake screen, whose filenames and caveats are somebody else’s text', () => {
  it('prints a filename with an embedded newline as one filename, not two rows', () => {
    const checks: readonly { name: string; status: Status; detail: string }[] = [
      {
        name: 'Repository',
        status: 'PASS',
        detail: `src/${LF}HUMAN APPROVAL RECORDED.txt — one file, on purpose`,
      },
    ];
    const result = {
      record: recordAt({
        runId: 'run-20260924T000000Z-aaaaaa',
        limitations: [
          `A caveat that rewrites its own row: failure${CR}PASS${BEL}`,
          `Reordered so the reader trusts the wrong half: ${RLO}VERIFICATION PASS${PDF}`,
        ],
      }),
      recordFile: null,
      saveError: null,
      checks,
    } as unknown as IntakeResult;
    const renderer = createRenderer({ color: resolveColor(true, {}) });

    const page = formatIntake(result, renderer);

    expectInert(page, 'the intake screen');
    const lines = page.split(LF);
    expect(lines.filter((line) => line.includes('HUMAN APPROVAL RECORDED'))).toHaveLength(1);
    expect(counterfeitedRows(page, ['HUMAN APPROVAL', 'VERIFICATION PASS'])).toEqual([]);
    expect(page).toContain('one file, on purpose');
    expect(page).toContain('VERIFICATION PASS');
  });
});

describe('the renderer keeps its own colour and refuses anybody else’s', () => {
  it('still styles a trusted row while neutralising the value inside it', () => {
    const renderer = createRenderer({ color: true });

    const badge = renderer.status('PASS');
    expect(badge).toContain(`${ESC}[32m`);
    expect(badge).toContain(`${ESC}[0m`);

    // The payload is deliberately built out of the renderer's own sequences: a fix that
    // stripped every ESC would pass a weaker test while failing this one, where the row's
    // colour has to be exactly what a harmless detail would have produced.
    const hostile = `${ESC}[31mI am red now${ESC}[0m`;
    const row = renderer.row('FAIL', 'Gate', hostile);
    const benign = renderer.row('FAIL', 'Gate', 'benign');
    expect(row.split(ESC).length - 1, 'the detail added escape sequences of its own').toBe(
      benign.split(ESC).length - 1,
    );
    expect(row).toContain(shown(0x1b));
    expect(row).toContain('I am red now');
    expect(row.startsWith(`${ESC}[31mFAIL`), row).toBe(true);
  });

  it('escapes in colour mode and in no-colour mode alike', () => {
    const hostile = `${ESC}[2JPASS${RLO}${BS}`;
    for (const color of [true, false]) {
      const renderer = createRenderer({ color });
      const where = `color=${String(color)}`;
      const styled = renderer.dim(hostile);
      // The only escape sequences on the line are the open and reset this renderer wrote
      // for its own colour — and in no-colour mode there are none of those either.
      expect(styled.split(ESC).length - 1, where).toBe(color ? 2 : 0);
      expect(styled, where).toContain(shown(0x1b));
      expect(styled, where).toContain(shown(0x202e));
      expect(styled, where).toContain(shown(0x08));
      expect(styled, where).toContain('PASS');
      expect(renderer.heading(`${ESC}]0;x${BEL}${LRI}`).split(ESC).length - 1, where).toBe(
        color ? 2 : 0,
      );
    }
  });
});

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});
