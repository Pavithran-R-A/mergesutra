import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'container-boundary.mjs');
const runChild = promisify(execFile);

// One `docker inspect` record for a container this product started, transcribed
// field-for-field from a real measurement (see docs/SECURITY_GAP_REGISTER.md
// S16-11) with only the bind source replaced by a Linux-shaped workspace path.
// Every key name here is the name the daemon actually reports: `NanoCpus` is
// spelled that way, the mount appears in both `Mounts[].Destination` and
// `HostConfig.Mounts[].Target`, and the requested reference lives in
// `Config.Image`. `Image` is the container's image ID, and the two stores
// measured here spell that identity differently: this Windows host's
// containerd-store daemon records the pulled digest (`sha256:363e1587…`, see
// /c/tmp/s16/s1611-proof-*.log), while GitHub's classic-store runner records the
// pinned index's `linux/amd64` manifest config digest (`sha256:0b1b606a…` for
// `sha256:a4fb1414…`, hosted run 39048507268).
const HONEST = {
  Id: 'c92eb6d1dc7ff5829f5f5950c86c35fb460c001e4bb5fbfebf5604ea43a7fa2e',
  Path: 'node',
  Args: ['probe.cjs'],
  State: { Status: 'running', Running: true, Pid: 71727, ExitCode: 0, OOMKilled: false },
  Image: 'sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
  Platform: 'linux',
  HostConfig: {
    NetworkMode: 'none',
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Privileged: false,
    ReadonlyRootfs: true,
    Memory: 536870912,
    NanoCpus: 1000000000,
    PidsLimit: 64,
    Tmpfs: { '/tmp': 'rw,nosuid,noexec,size=64m' },
    Binds: null,
    Devices: [],
    GroupAdd: null,
    Ulimits: null,
    PortBindings: {},
    Links: null,
    AutoRemove: true,
    Mounts: [
      {
        Type: 'bind',
        Source: '/run/mergesutra/workspace',
        Target: '/workspace',
      },
    ],
  },
  Mounts: [
    {
      Type: 'bind',
      Source: '/run/mergesutra/workspace',
      Destination: '/workspace',
      Mode: '',
      RW: true,
      Propagation: 'rprivate',
    },
  ],
  Config: {
    User: '1000:1000',
    Entrypoint: ['node'],
    Cmd: ['probe.cjs'],
    WorkingDir: '/workspace',
    Image: 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
    Env: [
      'HOME=/tmp',
      'XDG_CONFIG_HOME=/tmp',
      'npm_config_cache=/tmp/npm-cache',
      'CI=1',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'NODE_VERSION=22.23.3',
      'YARN_VERSION=1.22.22',
    ],
    Labels: {},
  },
  NetworkSettings: { Ports: {}, Networks: { none: { IPAddress: '' } } },
};

const EXPECTATION = {
  image: 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
  // The identities the host's own `docker image inspect` reports for that
  // reference. On this containerd-store daemon the image ID *is* the pulled
  // digest, so the list has one entry; a classic-store daemon adds the config
  // digest too, which is the case `honest-classic-store-image-id` below plants.
  imageIdentities: ['sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7'],
  workspace: '/run/mergesutra/workspace',
  sandboxRoot: '/workspace',
  file: 'node',
  args: ['probe.cjs'],
  memoryBytes: 536870912,
  pidsLimit: 64,
  nanoCpus: 1000000000,
  canaryValues: ['CANARY-GH-TOKEN-VALUE', 'CANARY-NPM-TOKEN-VALUE'],
};

interface Case {
  name: string;
  expectation?: Record<string, unknown>;
  record?: unknown;
  set?: readonly (readonly [string, unknown])[];
}

// Each row is one way the execution boundary can be narrower in the docs than in
// the daemon's own record. The code is what the checker must name; a row whose
// verdict is empty means a real defect would have been certified as a pass.
const CASES: readonly Case[] = [
  { name: 'honest', set: [] },
  {
    name: 'honest-windows-short-name',
    expectation: {
      ...EXPECTATION,
      workspace: 'C:\\Users\\Example User\\AppData\\Local\\Temp\\run\\workspace',
    },
    set: [
      [
        'HostConfig.Mounts',
        [
          {
            Type: 'bind',
            Source: 'C:\\Users\\EXAMPL~1\\AppData\\Local\\Temp\\run\\workspace',
            Target: '/workspace',
          },
        ],
      ],
      [
        'Mounts',
        [
          {
            Type: 'bind',
            Source: 'C:\\Users\\EXAMPL~1\\AppData\\Local\\Temp\\run\\workspace',
            Destination: '/workspace',
            Mode: '',
            RW: true,
            Propagation: 'rprivate',
          },
        ],
      ],
    ],
  },
  {
    name: 'honest-other-image-env',
    set: [
      [
        'Config.Env',
        [
          'HOME=/tmp',
          'XDG_CONFIG_HOME=/tmp',
          'npm_config_cache=/tmp/npm-cache',
          'CI=1',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ],
      ],
    ],
  },
  {
    name: 'home-mounted',
    set: [
      ['HostConfig.Mounts', [{ Type: 'bind', Source: '/home/runner', Target: '/workspace' }]],
      [
        'Mounts',
        [
          {
            Type: 'bind',
            Source: '/home/runner',
            Destination: '/workspace',
            Mode: '',
            RW: true,
            Propagation: 'rprivate',
          },
        ],
      ],
    ],
  },
  {
    name: 'sibling-workspace-mounted',
    set: [
      [
        'HostConfig.Mounts',
        [{ Type: 'bind', Source: '/run/mergesutra/other-run', Target: '/workspace' }],
      ],
      [
        'Mounts',
        [
          {
            Type: 'bind',
            Source: '/run/mergesutra/other-run',
            Destination: '/workspace',
            Mode: '',
            RW: true,
            Propagation: 'rprivate',
          },
        ],
      ],
    ],
  },
  {
    name: 'docker-socket-added',
    set: [
      [
        'Mounts',
        [
          ...HONEST.Mounts,
          {
            Type: 'bind',
            Source: '/var/run/docker.sock',
            Destination: '/var/run/docker.sock',
            Mode: '',
            RW: true,
            Propagation: 'rprivate',
          },
        ],
      ],
      [
        'HostConfig.Mounts',
        [
          ...HONEST.HostConfig.Mounts,
          { Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' },
        ],
      ],
    ],
  },
  {
    name: 'workspace-mounted-read-only',
    set: [
      [
        'Mounts',
        [
          {
            Type: 'bind',
            Source: '/run/mergesutra/workspace',
            Destination: '/workspace',
            Mode: 'ro',
            RW: false,
            Propagation: 'rprivate',
          },
        ],
      ],
    ],
  },
  {
    name: 'git-dir-mounted',
    set: [
      [
        'HostConfig.Mounts',
        [{ Type: 'bind', Source: '/run/mergesutra/workspace/.git', Target: '/workspace' }],
      ],
      [
        'Mounts',
        [
          {
            Type: 'bind',
            Source: '/run/mergesutra/workspace/.git',
            Destination: '/workspace',
            Mode: '',
            RW: true,
            Propagation: 'rprivate',
          },
        ],
      ],
    ],
  },
  {
    name: 'binds-list-added',
    set: [['HostConfig.Binds', ['/home/runner/.ssh:/home/runner/.ssh:ro']]],
  },
  {
    name: 'tmpfs-extra',
    set: [['HostConfig.Tmpfs', { '/tmp': 'rw,nosuid,noexec,size=64m', '/dev/shm2': 'rw,exec' }]],
  },
  { name: 'tmpfs-exec', set: [['HostConfig.Tmpfs', { '/tmp': 'rw,exec,size=64m' }]] },
  {
    name: 'device-added',
    set: [
      [
        'HostConfig.Devices',
        [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }],
      ],
    ],
  },
  { name: 'group-add', set: [['HostConfig.GroupAdd', ['docker']]] },
  { name: 'network-bridge', set: [['HostConfig.NetworkMode', 'bridge']] },
  { name: 'network-host', set: [['HostConfig.NetworkMode', 'host']] },
  { name: 'root-user', set: [['Config.User', '0:0']] },
  { name: 'no-user', set: [['Config.User', '']] },
  { name: 'rootfs-writable', set: [['HostConfig.ReadonlyRootfs', false]] },
  { name: 'caps-not-dropped', set: [['HostConfig.CapDrop', []]] },
  { name: 'no-new-privileges-missing', set: [['HostConfig.SecurityOpt', []]] },
  { name: 'privileged', set: [['HostConfig.Privileged', true]] },
  { name: 'unlimited-memory', set: [['HostConfig.Memory', 0]] },
  { name: 'unlimited-pids', set: [['HostConfig.PidsLimit', 0]] },
  { name: 'unlimited-cpu', set: [['HostConfig.NanoCpus', 0]] },
  { name: 'no-autoremove', set: [['HostConfig.AutoRemove', false]] },
  { name: 'mutable-tag-image', set: [['Config.Image', 'node:22']] },
  {
    name: 'different-digest',
    set: [['Image', 'sha256:1111111111111111111111111111111111111111111111111111111111111111']],
  },
  {
    // The hosted reading that broke the first certified run: a classic-store
    // daemon records the pinned index's amd64 config digest as the image ID, not
    // the pulled digest. Both values come from the registry for the repository's
    // own Alpine pin (index sha256:a4fb1414… → config sha256:0b1b606a…).
    name: 'honest-classic-store-image-id',
    expectation: {
      image: 'node@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8',
      imageIdentities: [
        'sha256:0b1b606ab95a0ef4f8d683de41bc2af43f8399d7d7984ca81a17cb1cb58c85b6',
        'sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8',
      ],
    },
    set: [
      ['Image', 'sha256:0b1b606ab95a0ef4f8d683de41bc2af43f8399d7d7984ca81a17cb1cb58c85b6'],
      [
        'Config.Image',
        'node@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8',
      ],
    ],
  },
  {
    name: 'image-identities-unreadable',
    expectation: { imageIdentities: [] },
  },
  {
    // A second, also-digest-pinned reference that is not the one under proof: the
    // identity list accepts it, so only the comparison against the pinned image
    // can refuse it.
    name: 'different-pinned-reference',
    expectation: {
      imageIdentities: ['sha256:2222222222222222222222222222222222222222222222222222222222222222'],
    },
    set: [
      ['Image', 'sha256:2222222222222222222222222222222222222222222222222222222222222222'],
      [
        'Config.Image',
        'node@sha256:2222222222222222222222222222222222222222222222222222222222222222',
      ],
    ],
  },
  {
    name: 'image-identities-not-digest-shaped',
    expectation: {
      imageIdentities: ['docker.io/library/node:22', 'sha256:short'],
    },
  },
  {
    name: 'entrypoint-reinterpretation',
    set: [
      ['Path', 'sh'],
      ['Args', ['-c', 'node probe.cjs']],
      ['Config.Entrypoint', ['sh', '-c']],
      ['Config.Cmd', ['-c', 'node probe.cjs']],
    ],
  },
  {
    name: 'args-not-forwarded',
    set: [
      ['Config.Cmd', []],
      ['Args', []],
    ],
  },
  { name: 'workdir-outside', set: [['Config.WorkingDir', '/']] },
  {
    name: 'not-running',
    set: [['State', { Status: 'exited', Running: false, Pid: 0, ExitCode: 0, OOMKilled: false }]],
  },
  {
    name: 'privileged-env-name',
    set: [['Config.Env', [...HONEST.Config.Env, 'GH_TOKEN=CANARY-GH-TOKEN-VALUE']]],
  },
  {
    name: 'lowercase-privileged-env-name',
    set: [['Config.Env', [...HONEST.Config.Env, 'npm_token=x']]],
  },
  {
    name: 'canary-in-benign-name',
    set: [['Config.Env', [...HONEST.Config.Env, 'BUILD_METADATA=CANARY-NPM-TOKEN-VALUE']]],
  },
  { name: 'record-missing' },
  { name: 'record-not-an-object', set: [] },
];

interface LandingCase {
  name: string;
  hostPathWrite: boolean;
  inside: string[];
  outside: string[];
}

// Where the container's escape bytes actually landed, decided by walking the host
// filesystem rather than by the guest's word. `inside` are the files whose exact
// content is the escape canary and that sit under the directory the container was
// handed; `outside` are the rest. A Windows host belongs in the first group: there
// the guest resolves the host path as a *name* inside its own mount, so the write
// succeeds and the bytes stay confined — which is only provable from this side.
const LANDING_CASES: readonly LandingCase[] = [
  { name: 'refused-linux', hostPathWrite: false, inside: [], outside: [] },
  {
    name: 'confined-windows-artifact',
    hostPathWrite: true,
    inside: ['workspace/C:UsersEXAMPL~1AppDataLocalTempsiblingescape.txt'],
    outside: [],
  },
  {
    name: 'bytes-in-host-sibling',
    hostPathWrite: true,
    inside: ['workspace/allowed.txt'],
    outside: ['sibling/escape.txt'],
  },
  {
    name: 'guest-denies-bytes-on-host',
    hostPathWrite: false,
    inside: [],
    outside: ['sibling/escape.txt'],
  },
  { name: 'claimed-write-unaccounted', hostPathWrite: true, inside: [], outside: [] },
  {
    name: 'unclaimed-write-in-mount',
    hostPathWrite: false,
    inside: ['workspace/odd.txt'],
    outside: [],
  },
  {
    name: 'escape-and-unaccounted',
    hostPathWrite: true,
    inside: [],
    outside: ['sibling/a.txt', 'host-only/b.txt'],
  },
];

// The tree the host-side walk is measured against, planted for real in a scratch
// directory by the child process. `workspace` is the only directory the container
// is handed, so a hit under it is confined and a hit anywhere else is an escape.
// `workspaceish` is here to catch a walk that decides containment by string prefix,
// `alias` and `loop` to catch one that reads through, or around, a link the
// container planted, and the two `contains-`/`same-length-` files to catch a
// match on substring or on size alone rather than on the whole bytes: the
// longer one is only refused because the content is compared, the same-length
// one only because it is compared and not measured.
const WALK_CANARY = 'MERGESUTRA-ESCAPE-WALK-CANARY';
const WALK = {
  canary: WALK_CANARY,
  mount: 'workspace',
  files: [
    { path: 'workspace/allowed.txt', content: 'sandbox-writable' },
    { path: 'workspace/CUsersEXAMPL~1siblingescape.txt', content: WALK_CANARY },
    { path: 'workspace/nested/deep.txt', content: WALK_CANARY },
    { path: 'workspace/contains-but-longer.txt', content: `${WALK_CANARY} and more` },
    { path: 'workspace/same-length-other-bytes.txt', content: `${WALK_CANARY.slice(0, -1)}X` },
    { path: 'workspaceish/x.txt', content: WALK_CANARY },
    { path: 'sibling/escape.txt', content: WALK_CANARY },
    { path: 'host-only/secret.txt', content: 'HOST-PRIVATE-SENTINEL' },
  ],
  links: [
    { path: 'workspace/alias', target: 'sibling' },
    { path: 'workspace/loop', target: '.' },
  ],
};

// One `docker image inspect` record per image store, using the field names the
// daemon reports. These are what the runtime proof reads on the host to say
// *which identities the pinned reference has here*, instead of predicting that
// the container record’s `Image` must equal the digest inside the reference.
const IMAGE_CASES = [
  {
    name: 'classic-store',
    record: {
      Id: 'sha256:0b1b606ab95a0ef4f8d683de41bc2af43f8399d7d7984ca81a17cb1cb58c85b6',
      RepoDigests: [
        'docker.io/library/node@sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8',
      ],
    },
  },
  {
    name: 'containerd-store',
    record: {
      Id: 'sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
      RepoDigests: [
        'docker.io/library/node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
      ],
    },
  },
  {
    name: 'no-digest-identity',
    record: { Id: 'node:22', RepoDigests: ['docker.io/library/node:22'] },
  },
];

interface HarnessOutput {
  verdicts: Record<string, string[]>;
  raw: Record<string, string[]>;
  envNames: Record<string, string[]>;
  identities: Record<string, string[] | undefined>;
  landing: Record<string, string[] | undefined>;
  walk: { hits: string[]; insideMount: string[]; outsideMount: string[] } | undefined;
}

// The rules live under scripts/, which vitest must not bundle — its loader cannot
// resolve an absolute path containing spaces. A real Node process is also the
// honest reading: the shipped module answers the matrix, not a re-implementation
// of it inside the test.
const HARNESS = `
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));

const apply = (target, dotted, value) => {
  const keys = dotted.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === undefined || node[key] === null) node[key] = {};
    node = node[key];
  }
  if (value === undefined || value === null) {
    delete node[keys[keys.length - 1]];
    return;
  }
  node[keys[keys.length - 1]] = value;
};

const verdicts = {};
const raw = {};
const envNames = {};
const identities = {};
const landing = {};
const codes = (failures) => failures.map((line) => line.split(':')[0]);
for (const entry of input.images) {
  if (typeof lib.imageIdentitiesFrom !== 'function') {
    identities[entry.name] = undefined;
    continue;
  }
  identities[entry.name] = lib.imageIdentitiesFrom(entry.record);
}
for (const entry of input.landing) {
  if (typeof lib.escapeLandingViolations !== 'function') {
    landing[entry.name] = undefined;
    continue;
  }
  landing[entry.name] = codes(
    lib.escapeLandingViolations({
      hostPathWrite: entry.hostPathWrite,
      insideMount: entry.inside,
      outsideMount: entry.outside,
    }),
  );
  raw['landing:' + entry.name] = lib.escapeLandingViolations({
    hostPathWrite: entry.hostPathWrite,
    insideMount: entry.inside,
    outsideMount: entry.outside,
  });
}
let walk;
if (typeof lib.escapeCanaryHits === 'function' && typeof lib.splitLanding === 'function') {
  const tree = await mkdtemp(path.join(tmpdir(), 'mergesutra-landing-walk-'));
  const planted = [];
  for (const file of input.walk.files) {
    const full = path.join(tree, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }
  for (const link of input.walk.links) {
    const full = path.join(tree, link.path);
    await mkdir(path.dirname(full), { recursive: true });
    await symlink(
      path.join(tree, link.target),
      full,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    planted.push(full);
  }
  const hits = await lib.escapeCanaryHits(tree, input.walk.canary);
  const split = lib.splitLanding(hits, {
    root: tree,
    mount: path.join(tree, input.walk.mount),
  });
  const label = (file) => path.relative(tree, file).split(path.sep).join('/');
  walk = {
    hits: hits.map(label).sort(),
    insideMount: split.insideMount,
    outsideMount: split.outsideMount,
  };
  // A link is removed before its tree so the recursive delete never follows it.
  for (const full of planted) await rm(full, { force: true });
  await rm(tree, { recursive: true, force: true });
}
for (const testCase of input.cases) {
  raw[testCase.name] = [];
  if (testCase.name === 'record-missing') {
    verdicts[testCase.name] = codes(lib.containerBoundaryViolations(undefined, testCase.expectation));
    envNames[testCase.name] = [];
    continue;
  }
  if (testCase.name === 'record-not-an-object') {
    verdicts[testCase.name] = codes(lib.containerBoundaryViolations('not a record', testCase.expectation));
    envNames[testCase.name] = [];
    continue;
  }
  const record = clone(input.honest);
  for (const [dotted, value] of testCase.set ?? []) apply(record, dotted, clone(value));
  const failures = lib.containerBoundaryViolations(record, testCase.expectation ?? input.expectation);
  verdicts[testCase.name] = codes(failures);
  raw[testCase.name] = failures;
  const env = (record.Config && record.Config.Env) || [];
  envNames[testCase.name] = env.map((assignment) => assignment.split('=')[0]);
}
process.stdout.write(JSON.stringify({ verdicts, raw, envNames, identities, landing, walk }));
`;

let harness: HarnessOutput;
let scratch: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-container-boundary-'));
  const payload = path.join(scratch, 'cases.json');
  await writeFile(
    payload,
    JSON.stringify({
      honest: HONEST,
      expectation: EXPECTATION,
      images: IMAGE_CASES,
      landing: LANDING_CASES,
      walk: WALK,
      cases: CASES.map((testCase) => ({
        ...testCase,
        expectation: testCase.expectation ? { ...EXPECTATION, ...testCase.expectation } : undefined,
      })),
    }),
    'utf8',
  );
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 32 * 1024 * 1024 },
  );
  harness = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
});

const verdict = (name: string): string[] => {
  const recorded = harness.verdicts[name];
  if (!recorded) throw new Error(`the harness recorded no verdict for ${name}`);
  return recorded;
};

const rawLines = (name: string): string[] => {
  const recorded = harness.raw[name];
  if (!recorded) throw new Error(`the harness recorded no raw output for ${name}`);
  return recorded;
};

const identitiesOf = (name: string): string[] => {
  const recorded = harness.identities[name];
  if (!recorded) throw new Error(`the harness read no image identities for ${name}`);
  return recorded;
};

describe('the checker that reads the daemon record, not the container’s own word', () => {
  it('certifies the boundary the daemon actually reported for a real run', () => {
    expect(verdict('honest')).toEqual([]);
  });

  it('accepts the bind source in the short-name form a Windows Docker host reports', () => {
    expect(verdict('honest-windows-short-name')).toEqual([]);
    expect(verdict('honest-other-image-env')).toEqual([]);
  });

  it('names a mount whose host source is not the run workspace', () => {
    expect(verdict('home-mounted')).toEqual(['MOUNT_SOURCE']);
    expect(verdict('sibling-workspace-mounted')).toEqual(['MOUNT_SOURCE']);
    expect(verdict('git-dir-mounted')).toEqual(['MOUNT_SOURCE']);
  });

  it('names any second host path the container was given, including the Docker socket', () => {
    expect(verdict('docker-socket-added')).toContain('MOUNT_COUNT');
    expect(verdict('binds-list-added')).toContain('EXTRA_BINDS');
  });

  it('names a workspace mount the daemon reports as read-only', () => {
    expect(verdict('workspace-mounted-read-only')).toEqual(['MOUNT_WRITABLE']);
  });

  it('names extra writable filesystems the argv never asked for', () => {
    expect(verdict('tmpfs-extra')).toEqual(['TMPFS_SET']);
    expect(verdict('tmpfs-exec')).toEqual(['TMPFS_OPTIONS']);
    expect(verdict('device-added')).toEqual(['HOST_DEVICES']);
  });

  it('names a container told to join a network', () => {
    expect(verdict('network-bridge')).toEqual(['NETWORK_MODE']);
    expect(verdict('network-host')).toEqual(['NETWORK_MODE']);
  });

  it('names a container the daemon recorded as running as root', () => {
    expect(verdict('root-user')).toEqual(['USER_UNPRIVILEGED']);
    expect(verdict('no-user')).toEqual(['USER_UNPRIVILEGED']);
  });

  it('names a container that kept a writable root filesystem, caps, or privilege', () => {
    expect(verdict('rootfs-writable')).toEqual(['READONLY_ROOTFS']);
    expect(verdict('caps-not-dropped')).toEqual(['CAP_DROP_ALL']);
    expect(verdict('no-new-privileges-missing')).toEqual(['NO_NEW_PRIVILEGES']);
    expect(verdict('privileged')).toEqual(['NOT_PRIVILEGED']);
    expect(verdict('group-add')).toEqual(['GROUP_ADD']);
  });

  it('names a container whose resource ceilings the argv claimed but the daemon did not apply', () => {
    expect(verdict('unlimited-memory')).toEqual(['MEMORY_LIMIT']);
    expect(verdict('unlimited-pids')).toEqual(['PIDS_LIMIT']);
    expect(verdict('unlimited-cpu')).toEqual(['CPU_LIMIT']);
    expect(verdict('no-autoremove')).toEqual(['AUTO_REMOVE']);
  });

  it('names an image the daemon did not start from the pinned digest', () => {
    expect(verdict('mutable-tag-image')).toEqual(['IMAGE_PINNED']);
    expect(verdict('different-digest')).toEqual(['IMAGE_MATCH']);
  });

  it('accepts the image ID each image store records for the pinned digest', () => {
    expect(verdict('honest')).toEqual([]);
    expect(verdict('honest-classic-store-image-id')).toEqual([]);
  });

  it('refuses to certify an identity the host could not read back for the pin', () => {
    expect(verdict('image-identities-unreadable')).toEqual(['IMAGE_MATCH']);
    expect(verdict('image-identities-not-digest-shaped')).toEqual(['IMAGE_MATCH']);
    // The reader must be told the host read failed, not that the daemon started
    // some other image — the two need different fixes.
    expect(rawLines('image-identities-unreadable').join('\n')).toContain('no digest identity');
    expect(rawLines('image-identities-not-digest-shaped').join('\n')).toContain(
      'no digest identity',
    );
  });

  it('names a digest-pinned reference that is not the image under proof', () => {
    expect(verdict('different-pinned-reference')).toEqual(['IMAGE_MATCH']);
    expect(rawLines('different-pinned-reference').join('\n')).toContain('is not the pinned image');
  });

  it('reads the pinned image identities from the host record for either store', () => {
    expect(identitiesOf('classic-store')).toEqual([
      'sha256:0b1b606ab95a0ef4f8d683de41bc2af43f8399d7d7984ca81a17cb1cb58c85b6',
      'sha256:a4fb14143ee24c038c851864fe85fd90f9121abc8fdca3092798bcc02e06b1d8',
    ]);
    expect(identitiesOf('containerd-store')).toEqual([
      'sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7',
    ]);
    expect(identitiesOf('no-digest-identity')).toEqual([]);
  });

  it('names a container whose program is not the one the gate asked to run', () => {
    expect(verdict('entrypoint-reinterpretation')).toEqual(['PROGRAM_PINNED']);
    expect(verdict('args-not-forwarded')).toEqual(['PROGRAM_ARGS']);
    expect(verdict('workdir-outside')).toEqual(['WORKDIR']);
  });

  it('refuses to certify a record that is not a live container', () => {
    expect(verdict('not-running')).toEqual(['CONTAINER_RUNNING']);
    expect(verdict('record-missing')).toEqual(['RECORD_UNREADABLE']);
    expect(verdict('record-not-an-object')).toEqual(['RECORD_UNREADABLE']);
  });

  it('names a privileged environment variable the host carried into the container', () => {
    expect(verdict('privileged-env-name')).toEqual(['ENV_PRIVILEGED_NAME']);
    expect(verdict('lowercase-privileged-env-name')).toEqual(['ENV_PRIVILEGED_NAME']);
    expect(harness.envNames['privileged-env-name']).toContain('GH_TOKEN');
  });

  it('names a planted credential value that arrived under a harmless-looking name', () => {
    expect(verdict('canary-in-benign-name')).toEqual(['ENV_CANARY_LEAK']);
  });

  it('names the variable that carried a credential without repeating the credential itself', () => {
    const lines = [...rawLines('privileged-env-name'), ...rawLines('canary-in-benign-name')].join(
      '\n',
    );
    expect(lines).toContain('GH_TOKEN');
    expect(lines).toContain('BUILD_METADATA');
    expect(lines).not.toContain('CANARY-GH-TOKEN-VALUE');
    expect(lines).not.toContain('CANARY-NPM-TOKEN-VALUE');
  });
});

describe('the host-side accounting of where the escape bytes landed', () => {
  const landing = (name: string): string[] => {
    const recorded = harness.landing[name];
    if (!recorded) throw new Error(`the harness recorded no landing verdict for ${name}`);
    return recorded;
  };

  it('accepts the two honest readings: a refused write, and one confined to the mount', () => {
    expect(landing('refused-linux')).toEqual([]);
    expect(landing('confined-windows-artifact')).toEqual([]);
  });

  it('names any host directory outside the container’s own mount that received the bytes', () => {
    expect(landing('bytes-in-host-sibling')).toEqual(['LANDING_OUTSIDE_MOUNT']);
    expect(rawLines('landing:bytes-in-host-sibling').join('\n')).toContain('sibling/escape.txt');
  });

  it('believes the filesystem over a guest that denies the write', () => {
    expect(landing('guest-denies-bytes-on-host')).toEqual(['LANDING_OUTSIDE_MOUNT']);
  });

  it('refuses a guest-reported write the host cannot find anywhere', () => {
    expect(landing('claimed-write-unaccounted')).toEqual(['LANDING_UNACCOUNTED']);
  });

  it('refuses bytes in the mount that the guest never reported writing', () => {
    expect(landing('unclaimed-write-in-mount')).toEqual(['LANDING_UNSOLICITED']);
  });

  it('reports an escape and an unaccounted claim together', () => {
    expect(landing('escape-and-unaccounted')).toEqual([
      'LANDING_OUTSIDE_MOUNT',
      'LANDING_UNACCOUNTED',
    ]);
  });
});

// The tree below is planted on the real filesystem by the same child process,
// because these two functions are what turn a host directory into the `inside`
// and `outside` lists the verdict above consumes. A walk that followed a planted
// link would report an escape as confined, which is the failure this measurement
// exists to catch.
describe('the host-side walk that finds the canary', () => {
  const walked = () => {
    if (!harness.walk) throw new Error('the harness ran no landing walk');
    return harness.walk;
  };

  it('finds every file whose whole content is the canary, at any depth', () => {
    expect(walked().hits).toEqual([
      'sibling/escape.txt',
      'workspace/CUsersEXAMPL~1siblingescape.txt',
      'workspace/nested/deep.txt',
      'workspaceish/x.txt',
    ]);
  });

  it('refuses a file that merely contains the canary, and one that never held it', () => {
    const joined = walked().hits.join('\n');
    expect(joined).not.toContain('contains-but-longer.txt');
    expect(joined).not.toContain('allowed.txt');
    expect(joined).not.toContain('host-only/secret.txt');
  });

  it('refuses a file the same length as the canary whose bytes are different', () => {
    const planted = WALK.files.find(
      (file) => file.path === 'workspace/same-length-other-bytes.txt',
    );
    if (!planted) throw new Error('the same-length control file is not planted');
    expect(Buffer.byteLength(planted.content)).toBe(Buffer.byteLength(WALK.canary));
    expect(walked().hits.join('\n')).not.toContain('same-length-other-bytes.txt');
  });

  it('reads nothing through a link the container planted inside the mount', () => {
    expect(walked().hits.join('\n')).not.toContain('alias');
  });

  it('terminates, without duplicating, when the mount links back to the walked root', () => {
    const { hits } = walked();
    expect(new Set(hits).size).toBe(hits.length);
  });

  it('keeps a directory whose name merely starts like the mount outside it', () => {
    expect(walked().outsideMount).toContain('workspaceish/x.txt');
  });

  it('splits the planted tree the way the boundary actually is', () => {
    expect(walked()).toEqual({
      hits: [
        'sibling/escape.txt',
        'workspace/CUsersEXAMPL~1siblingescape.txt',
        'workspace/nested/deep.txt',
        'workspaceish/x.txt',
      ],
      insideMount: ['workspace/CUsersEXAMPL~1siblingescape.txt', 'workspace/nested/deep.txt'],
      outsideMount: ['sibling/escape.txt', 'workspaceish/x.txt'],
    });
  });
});
