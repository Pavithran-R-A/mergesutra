# Mandatory repository command sandbox

**Status: fail-closed production routing introduced; broad consumer qualification OPEN.**

MergeSutra's model-proposed Stage 6 `RUN_CHECK` and the Stage 7 repository
verification command runner use the pinned Docker backend by default.
Neither a Git worktree nor removing environment variables is an OS sandbox.

Before running commands that belong to a repository, an operator must configure:

```text
MERGESUTRA_SANDBOX_IMAGE=node@sha256:<exact approved digest>
MERGESUTRA_DOCKER_EXECUTABLE=<absolute verified path to docker executable>
```

The Docker image must already be available in the local daemon. Tag-only
images are rejected; the command runner never pulls a replacement.
`MERGESUTRA_DOCKER_EXECUTABLE` cannot be a relative executable looked up
inside the repository. Docker host/context/proxy credentials are excluded from
the Docker client environment; one fresh isolated Docker config is used
per launch.

Missing or invalid configuration produces `SANDBOX_UNAVAILABLE`, **not host
execution**. A refused Stage 6 `RUN_CHECK` cannot be treated as a successful
check. Stage 7 records a command it could not execute as inconclusive, rather
than a PASS. Operator verification consent remains required and separate from
container isolation. The one thing Stage 7 reads outside the sandbox is
MergeSutra's own check of the workspace's patch, and it is not a command that
failed to be isolated: it is a measurement of Git metadata a run could not have
written, which the sandbox is never given. A repository's command — including
one that runs `git` — has no path to the host.

The isolated container uses a digest-pinned image, no host network, no elevated
capabilities, an unprivileged user, a read-only container filesystem and a
single worktree bind mount; the latter is writable so legitimate test output
can be produced and contamination can still be detected. The container runs
exactly the program the caller named: `--entrypoint <program>` is set, because
an image's own entrypoint may otherwise substitute an interpreter for a command
it does not recognise (measured on the pinned digest, a gate that asked for
`git --version` executed `node git --version`).

## Limitations requiring dedicated acceptance before consumer launch

- The controlled real Docker adversarial fixture proves a specific Linux
  host-only secret, sibling-write, token-environment and loopback-network
  boundary. It does not prove every possible escape, other operating systems,
  or security against an actively compromised Docker daemon. Whether the bytes used for an escape
  attempt reached the host is decided by a host-side walk of the directories the run owns, not by the
  container's own report: on a Windows host running Linux containers the planted path is not an
  absolute path inside the guest at all, so the write succeeds and lands as a *file named* after that
  path inside the one directory the container was handed. Confinement permits that, and both proofs
  now say so (`SECURITY_GAP_REGISTER.md` S16-11) instead of exiting non-zero on a word the guest
  controls. An escape is only what the walk finds outside the bound directory, or a landing the host
  cannot account for against what the guest reported.
  The same rule covers which image the container started: the proof reads the identities this host holds for
  the pinned reference out of its own `docker image inspect` record and requires the container's image ID to
  be one of them, instead of expecting the container to report the digest written inside the reference. The
  two are not the same number. A classic-store daemon (GitHub's `ubuntu-latest` runners) records the config
  digest of the `linux/amd64` manifest behind the index; a containerd-store daemon (Docker Desktop with the
  containerd image store) records the index digest it was given. `IMAGE_MATCH` therefore now means "this
  daemon started something the host does not identify under your pin" — or "the host could not read an
  identity back", which the message says in so many words — and never means "your digest is spelled in
  another store's form".
- Worktrees store Git metadata outside the single-mounted directory, and that is now measured rather
  than assumed. A linked worktree's `.git` is a pointer to an absolute host path; inside a container
  that path is not mounted, so Git resolves it against the container root. Driven through the
  production Stage 7 path (real repository runner, real patch identity, no stubs) against a real
  linked worktree, with the flag set the product builds (`--network=none`, `--cap-drop=ALL`,
  `--read-only`, `--user`, one bind mount at `/workspace`): `git --version` returned
  `git version 2.39.5` (rc 0), while `git status --porcelain`, `git diff --check` and
  `git rev-parse HEAD` each returned rc 128 with
  `fatal: not a git repository: /workspace/C:/…/.git/worktrees/ws`, and the legitimate repository
  command in the same container — `node src/f.js` — ran and exited 0. The round came back `FAIL`,
  never `PASS`. So a git-native gate fails closed inside the sandbox; it does not silently pass, and
  it does not block ordinary repository code. Do not bypass this with a raw host runner or mark such
  an incomplete verification as PASS.
  What that rule protects is a *command under review*, and it still applies to every one a repository
  wrote down: a `git` step in a CI file is code this round is judging, so it stays in the container and
  keeps its fail-closed reading there. MergeSutra's own check of a workspace's patch is a different
  kind of thing — a measurement, like the patch identity beside it — and S16-4 moved it out of the
  sandbox: it runs on the host, through the Git directory `resolveTrustedGitDir` proves the run could
  not have authored, and `isWorkspaceCheck` authorises it by comparing the gate's argv with a source
  constant plus its built-in provenance and requirement level, so no plan document, repository file or
  model answer can name a command that takes that path. That is not permission for a raw host runner.
  It is one named command, decided structurally, refusing any workspace whose metadata it cannot trust;
  a repository-controlled command that reached the host would be this section's failure, and
  `SECURITY_GAP_REGISTER.md` S16-4 carries the before reading, the after reading and the residual.
- The digest this repository pins for the sandbox is not a git image. The image pinned by
  `.github/workflows/sandbox-runtime.yml` and `scripts/sandbox-runtime-proof.mjs` is Alpine with
  `NODE_VERSION=26.6.0` and no `git` binary at all, so a gate that asks the container for `git` gets
  exit 127, `exec: "git": executable file not found in $PATH`. That is why MergeSutra's own `diff-check`
  used to fail every customer round: it asked for a program the image does not contain, and a non-zero
  exit of a program that started is a `FAIL`. It no longer asks the container (S16-4), so a clean
  worktree round measures and passes, while a repository that writes its own `git` step still gets 127
  and still fails closed. The hosted proofs stay green because the only programs they run inside the
  container are `node` ones. Sandbox-backed execution is therefore qualified for `node` commands and
  unqualified for git-native ones. Three digest-pinned images are qualified now — the repository's own
  Alpine pin plus the current `node:22` and `node:24` Debian digests — each against both hostile fixtures
  on a Linux Docker host (`S16-10` in `SECURITY_GAP_REGISTER.md`), and the same three against both on a
  Windows Docker Desktop host (`S16-11`); no image has been qualified against a macOS Docker host. The
  Windows leg's two Debian digests are the ones that daemon holds, not today's `node:22` / `node:24`
  manifest digests, so that leg says nothing about whether the hosted pair behaves the same way. Those
  Windows legs also ran a lib a few edits behind the one shipping now. Two of those edits were inert: one
  added `import { Buffer } from 'node:buffer';` line in `scripts/lib/container-boundary.mjs`, whose use
  already read the same global, and four non-executable hunks in `scripts/sandbox-stage-proof.mjs` (an unused
  import, one reworded comment, two prettier re-wraps). The third is not inert, and says so here: the Windows
  legs passed an `IMAGE_MATCH` rule that compared the container's image ID to the digest inside the pinned
  reference, and that rule is the one replaced above. On a containerd-store host like the one those logs came
  from the two spellings coincide, so their outcome for the image is the same under either rule — but no
  Windows leg has been re-run on the shipping bytes, because that host's Docker daemon is stopped and its
  volume is at 99 % full. The run that starts from the pushed tree is therefore the hosted one, so treat the
  hosted matrix as the qualification and the Windows logs as corroboration
  (`S16-11` in `SECURITY_GAP_REGISTER.md` records the diffs, the hosted failure that found this rule, and the
  open local re-run). And one limit that is pure timing, so it is stated rather than left to be inferred:
  the repaired rule has not run against any daemon at all yet. The only real daemons this field has been
  read from are GitHub's classic-store runners on the tree whose equality rule failed all three legs, and
  this host's containerd store on the bytes before the repair. Neither of those is evidence about the
  replacement, so until a hosted run returns green on a tree carrying it, the sentence above about three
  qualified images rests on legs that did not contain this check.
- The Docker proof starts only on a file its `paths:` filter names, and
  `tests/security/sandbox-proof-trigger-policy.test.ts` derives that filter from the import statements
  in `scripts/sandbox-runtime-proof.mjs` and `scripts/sandbox-stage-proof.mjs`. So if a proof gains a
  direct import — a new shared security helper, a new test helper — the pull request that adds it must
  also add it to both `paths:` lists, or that test fails locally and the proof never gets to run.
  The rule is one hop deep on purpose; a change that reaches a proof only through a second import is
  the ordinary CI matrix's job.
- Unit tests may inject a trusted fixture runner to exercise scenario logic;
  that dependency-injection seam is **not** a product-level opt-out switch.
- Repository-controlled commands are distinct from MergeSutra-owned GitHub
  read transports. Any new execution path must be added to the threat-model
  inventory and exercised against the actual sandbox before release.
- First customer release still requires controlled tests across Node 22/24 on
  a macOS Docker host (the Ubuntu-host legs now run a three-image digest matrix, and both proofs have
  run on the three images this Windows daemon holds), a
  representative task benchmark, actual remote draft-PR
  publication and honest failure reporting.

See [sandbox security blocker](https://github.com/Pavithran-R-A/mergesutra/issues/33).
