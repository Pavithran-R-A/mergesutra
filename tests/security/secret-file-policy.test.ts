import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConfinedReader, secretReason } from '../../src/security/reader.js';

/**
 * Which repository files may be sent to a model — S12-18.
 *
 * The property under test is narrow on purpose: a confined reader must refuse a
 * path whose *name* is a well-established container for authentication material,
 * and must keep ordinary source readable even when its name contains a word that
 * sounds sensitive. Both halves are asserted here, because a policy that only
 * ever blocks is untested in the direction that costs this product work.
 *
 * Every fixture byte below is fake. The strings are distinctive so that finding
 * one anywhere — in a refusal, a reason, a search hit — is a failure rather than
 * something a reader has to recognise.
 */

const FAKE_KEY = 'sk-s1218fixture0123456789abcdef';
const FAKE_PAIR = `BHARATCODE_API_KEY=${FAKE_KEY}`;

/** A PEM body that is a private identity: the content rule's positive case. */
const PRIVATE_PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAw-s1218-fake\n-----END OPENSSH PRIVATE KEY-----\n';

/** PEM bodies that are *not*: a certificate, a chain, a public key. */
const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBfake-certificate-s1218-not-a-private-key\n-----END CERTIFICATE-----\n';
const PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\nMFkwFakePublicKeyS1218NotPrivateAtAll\n-----END PUBLIC KEY-----\n';
const SSH_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAFakePublicS1218 nobody@example\n';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-secret-policy-'));
  dirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

/** Each withheld path paired with the class its reason must name (§13, §25). */
const MUST_WITHHOLD: readonly { path: string; class: string }[] = [
  // §3 — the dotenv family, templates included: a developer can put a real
  // credential in `.env.example`, and the model has no need of any of them.
  { path: '.env', class: 'dotenv' },
  { path: '.env.local', class: 'dotenv' },
  { path: '.env.development', class: 'dotenv' },
  { path: '.env.production', class: 'dotenv' },
  { path: '.env.test', class: 'dotenv' },
  { path: '.env.staging', class: 'dotenv' },
  { path: '.env.anything', class: 'dotenv' },
  { path: '.env.example', class: 'dotenv' },
  { path: '.env.sample', class: 'dotenv' },
  { path: '.env.template', class: 'dotenv' },
  { path: '.envrc', class: 'dotenv' },
  { path: 'config/app.env', class: 'dotenv' },
  { path: 'config/local.ENV', class: 'dotenv' },
  // §4 — npm documents `_auth`, `_authToken`, `username` and `_password` in an
  // npmrc, so a project-level one is never repository context.
  { path: '.npmrc', class: 'npm authentication' },
  { path: 'packages/tool/.npmrc', class: 'npm authentication' },
  // §5 — netrc, including the Windows spelling.
  { path: '.netrc', class: 'netrc' },
  { path: '_netrc', class: 'netrc' },
  // §6 — path-qualified AWS, not any file called `credentials`.
  { path: '.aws/credentials', class: 'AWS' },
  { path: '.aws/config', class: 'AWS' },
  { path: 'vendor/.aws/credentials', class: 'AWS' },
  // §7 — private SSH identities, wherever they were committed.
  { path: '.ssh/id_rsa', class: 'SSH private identity' },
  { path: '.ssh/id_dsa', class: 'SSH private identity' },
  { path: '.ssh/id_ecdsa', class: 'SSH private identity' },
  { path: '.ssh/id_ecdsa_sk', class: 'SSH private identity' },
  { path: '.ssh/id_ed25519', class: 'SSH private identity' },
  { path: '.ssh/id_ed25519_sk', class: 'SSH private identity' },
  { path: '.ssh/id_mldsa44_ed25519', class: 'SSH private identity' },
  { path: 'deploy/id_rsa', class: 'SSH private identity' },
  { path: 'secrets/.ssh/id_ed25519', class: 'SSH private identity' },
  // §10 — a Git credential store dropped in a working tree.
  { path: '.git-credentials', class: 'Git credential' },
  // §9 — the PyPI upload credential file.
  { path: '.pypirc', class: 'PyPI' },
  // The credential directories this policy already names, now by component.
  { path: '.gnupg/dirmngr.conf', class: 'credential directory' },
  { path: '.azure/service_principal.json', class: 'credential directory' },
  { path: '.config/gcloud/credentials.db', class: 'credential directory' },
  { path: 'deploy/.gnupg/keyring', class: 'credential directory' },
  // Key stores whose whole format is protected material.
  { path: 'certs/keystore.p12', class: 'key store' },
  { path: 'certs/server.pfx', class: 'key store' },
  { path: 'vault/passwords.kdbx', class: 'key store' },
];

/** §2, §18 — names that only *sound* sensitive, and public key material. */
const MUST_REMAIN_READABLE: readonly string[] = [
  'src/tokenizer.ts',
  'src/keymap.ts',
  'src/authentication.ts',
  'src/credentials-schema.ts',
  'docs/api-key-rotation.md',
  'tests/token-parser.test.ts',
  'packages/secret-santa/index.ts',
  'src/config.ts',
  'config/app.json',
  'docs/credentials.md',
  'network.ts',
  'netrc-parser.test.ts',
  'pyproject.toml',
  'requirements.txt',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  'keys/id_ed25519.pub',
  'keys/id_rsa.pub',
  'keys/id_ecdsa.pub',
  // A font and a TLS certificate are not credentials. These three were refused
  // by extension before this item; they are the readable half of §22.
  'assets/keyboard.ttf',
  'certs/certificate.pem',
  'certs/public-key.pem',
  // The directory prefix match used to block these by accident.
  '.awsm/README.md',
  '.ssh-keys/notes.md',
];

/** The subset of the readable list whose bytes this file's tree really holds. */
const FIXTURE_READABLE: readonly string[] = [
  'src/app.ts',
  'src/tokenizer.ts',
  'src/credentials-schema.ts',
  'docs/api-key-rotation.md',
  'keys/id_ed25519.pub',
  'keys/id_rsa.pub',
  'certs/certificate.pem',
  'certs/public-key.pem',
  'assets/keyboard.ttf',
  '.gitignore',
  '.gitattributes',
  'package.json',
  'netrc-parser.test.ts',
];

describe('the secret-file name policy, rule by rule', () => {
  it('refuses every path whose name is a well-established credential container', () => {
    const leaked: string[] = [];
    for (const entry of MUST_WITHHOLD) {
      const reason = secretReason(entry.path);
      if (reason === null) leaked.push(`${entry.path} (no reason at all)`);
      else if (!reason.includes(entry.class)) {
        leaked.push(`${entry.path} refused as "${reason}", which names no "${entry.class}"`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('keeps ordinary source, docs and public key material readable', () => {
    const refused: string[] = [];
    for (const entry of MUST_REMAIN_READABLE) {
      const reason = secretReason(entry);
      if (reason !== null) refused.push(`${entry} — "${reason}"`);
    }
    expect(refused).toEqual([]);
  });

  it('names a class in every reason, and never the path, the root or a value', () => {
    const problems: string[] = [];
    for (const entry of MUST_WITHHOLD) {
      const reason = secretReason(entry.path) ?? '';
      // A reason is prose about a class, never a title, a path or a value. The
      // class labels themselves keep their casing (`AWS`, `SSH private identity`),
      // so the comparison against the label is case-insensitive while the
      // sentence around it is not title-cased.
      if (!/^(it|this|a|an|the) [a-z]/.test(reason)) {
        problems.push(`${entry.path}: does not read as a sentence — "${reason}"`);
      }
      if (reason.includes('/') || reason.includes('\\'))
        problems.push(`${entry.path}: has a slash`);
      if (reason.includes(entry.path)) problems.push(`${entry.path}: echoes the path`);
      if (reason.includes(FAKE_KEY) || reason.includes(FAKE_PAIR)) {
        problems.push(`${entry.path}: carries a file value`);
      }
      if (!/[a-z]/.test(reason)) problems.push(`${entry.path}: names nothing`);
    }
    expect(problems).toEqual([]);
  });

  it('matches components, so a substring that only sounds sensitive decides nothing', () => {
    // Each of these shares letters with a blocked name and is still source.
    expect(secretReason('src/tokenizer.ts')).toBeNull();
    expect(secretReason('my.envelope.ts')).toBeNull();
    expect(secretReason('src/npmrc-reader.ts')).toBeNull();
    expect(secretReason('keys/networx.cjs')).toBeNull();
    expect(secretReason('pypirc-docs.md')).toBeNull();
    expect(secretReason('docs/git-credentials-how-it-works.md')).toBeNull();
    // And a word inside a longer name is not the exact name the rule needs.
    expect(secretReason('.aws-tooling/credentials.json')).toBeNull();
    expect(secretReason('id_rsa_kept_as_a_test_fixture.pub')).toBeNull();
  });

  it('folds case for the name comparison while both spellings stay separate files', () => {
    for (const entry of MUST_WITHHOLD) {
      const upper = entry.path.toUpperCase();
      expect(secretReason(upper), upper).toBe(secretReason(entry.path));
    }
    expect(secretReason('.NPMRC')).toContain('npm authentication');
    expect(secretReason('Config/.Env.Production')).toContain('dotenv');
    expect(secretReason('.SSH/ID_ED25519')).toContain('SSH private identity');
    expect(secretReason('KEYS/ID_RSA.PUB')).toBeNull();
  });

  it('reads a backslash path as the same path a Windows operator would type', () => {
    expect(secretReason('config\\.env')).toContain('dotenv');
    expect(secretReason('.ssh\\id_ed25519')).toContain('SSH private identity');
    expect(secretReason('src\\tokenizer.ts')).toBeNull();
  });
});

describe('the policy as one real workspace sees it', () => {
  const fixtureTree = (): Record<string, string> => ({
    'src/app.ts': `export const banner = 's1218 ordinary source';\n`,
    'src/tokenizer.ts': 'export const tokenize = (input: string) => input.split(" ");\n',
    'src/credentials-schema.ts': 'export const schema = { kind: "credentials" };\n',
    'docs/api-key-rotation.md': '# Rotating a key\n\nAsk the owner.\n',
    '.env': `${FAKE_PAIR}\n`,
    '.env.production': `PRODUCTION_${FAKE_PAIR}\n`,
    '.npmrc': `//registry.npmjs.org/:_authToken=${FAKE_KEY}\n`,
    '.netrc': `machine example.com login someone password ${FAKE_KEY}\n`,
    _netrc: `machine example.com login someone password ${FAKE_KEY}\n`,
    '.aws/credentials': `[default]\naws_secret_access_key = ${FAKE_KEY}\n`,
    '.aws/config': '[default]\nregion = ap-south-1\n',
    'vendor/.aws/credentials': `[default]\naws_secret_access_key = ${FAKE_KEY}\n`,
    '.ssh/id_ed25519': PRIVATE_PEM,
    '.ssh/id_rsa': '-----BEGIN RSA PRIVATE KEY-----\ns1218-fake\n-----END RSA PRIVATE KEY-----\n',
    'keys/id_ed25519.pub': SSH_PUBLIC,
    'keys/id_rsa.pub': SSH_PUBLIC,
    'certs/certificate.pem': CERT_PEM,
    'certs/public-key.pem': PUBLIC_PEM,
    'certs/keystore.p12': 'fake-pkcs12-bytes\n',
    'deploy/id_rsa': PRIVATE_PEM,
    'notes/private-deployment-key.txt': PRIVATE_PEM,
    '.gitignore': 'node_modules\n',
    'package.json': '{\n  "name": "datekit"\n}\n',
    'netrc-parser.test.ts': 'it("parses a netrc line", () => {});\n',
    '.gitattributes': '*.ts text\n',
    'assets/keyboard.ttf': 'not really a font, and not a credential\n',
  });

  it('refuses the credential paths and serves the ordinary ones, from bytes on disk', async () => {
    const reader = await openConfinedReader(await repo(fixtureTree()));
    const refusals: string[] = [];
    for (const entry of MUST_WITHHOLD) {
      const receipt = await reader.readText(entry.path).then(
        (ok) => ok,
        () => null,
      );
      if (receipt) refusals.push(`${entry.path} was served (${receipt.bytes} bytes)`);
    }
    expect(refusals).toEqual([]);
  });

  it('serves the content of every readable path the tree actually holds', async () => {
    const reader = await openConfinedReader(await repo(fixtureTree()));
    const served: string[] = [];
    for (const entry of FIXTURE_READABLE) {
      const receipt = await reader.readText(entry).catch((error: unknown) => error as Error);
      if (receipt instanceof Error) served.push(`${entry} — ${receipt.message}`);
      else if (receipt.text === '') served.push(`${entry} — nothing came back`);
    }
    expect(served).toEqual([]);
  });

  it('refuses a private identity by name and serves its public twin by content', async () => {
    const reader = await openConfinedReader(await repo(fixtureTree()));
    await expect(reader.readText('.ssh/id_ed25519')).rejects.toThrow(/SSH private identity/);
    const pub = await reader.readText('keys/id_ed25519.pub');
    expect(pub.text).toContain('ssh-ed25519');
    expect(pub.text).not.toContain('PRIVATE KEY');
  });

  it('refuses a private key pasted under an ordinary name, and not the certificate beside it', async () => {
    const reader = await openConfinedReader(await repo(fixtureTree()));
    // §22: the format decides, not the extension.
    await expect(reader.readText('notes/private-deployment-key.txt')).rejects.toThrow(
      /private key/i,
    );
    await expect(reader.readText('deploy/id_rsa')).rejects.toThrow(/SSH private identity/);
    const cert = await reader.readText('certs/certificate.pem');
    expect(cert.text).toContain('BEGIN CERTIFICATE');
    const publicKey = await reader.readText('certs/public-key.pem');
    expect(publicKey.text).toContain('BEGIN PUBLIC KEY');
  });

  it('says the class and the relative name in a refusal, and never the bytes', async () => {
    const root = await repo(fixtureTree());
    const reader = await openConfinedReader(root);
    const messages: string[] = [];
    for (const entry of ['.env', '.npmrc', '_netrc', '.aws/credentials', '.git-credentials']) {
      const error = await reader.readText(entry).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error, entry).not.toBeNull();
      messages.push(`${entry} -> ${error?.message}`);
    }
    const joined = messages.join('\n');
    expect(joined).not.toContain(FAKE_KEY);
    expect(joined).not.toContain('aws_secret_access_key');
    expect(joined).not.toContain('_authToken');
    expect(joined).not.toContain(root);
    expect(joined).toContain('dotenv');
    expect(joined).toContain('npm authentication');
    expect(joined).toContain('netrc');
    expect(joined).toContain('AWS');
    expect(joined).toContain('Git credential');
  });

  it('fails confinement before a secret name is ever classified', async () => {
    const reader = await openConfinedReader(await repo(fixtureTree()));
    // `..` is refused by the path layer, so the ordering is visible in the reason.
    await expect(reader.readText('config/../.env')).rejects.toThrow(/parent traversal segment/);
    await expect(reader.readText('../.aws/credentials')).rejects.toThrow(
      /parent traversal segment/,
    );
    // An absolute path to a real home-directory credential is refused as a path,
    // not by reaching outside the workspace to look: this policy grants no such read.
    await expect(
      reader.readText(`${process.env['HOME'] ?? 'C:'}/.aws/credentials`),
    ).rejects.toThrow(/relative to the authorized root/);
  });

  it('stays repository-confined while matching, walking and listing', async () => {
    const root = await repo(fixtureTree());
    const reader = await openConfinedReader(root);
    const walked = await reader.walk('.', 6, 500);
    // Nothing walked leaves the root, and no credential path is walked at all.
    for (const relative of walked) {
      expect(relative.startsWith('..')).toBe(false);
      expect(secretReason(relative)).toBeNull();
    }
    expect(walked).toContain('src/app.ts');
    expect(walked).not.toContain('.env');
    // Listing shows a name the reader will not open — visibility is not access.
    const names = (await reader.list('.')).map((entry) => entry.name);
    expect(names).toContain('.env');
    await expect(reader.readText('.env')).rejects.toThrow(/dotenv/);
  });
});
