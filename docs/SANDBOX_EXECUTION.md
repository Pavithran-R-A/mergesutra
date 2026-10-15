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
container isolation.

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
  or security against an actively compromised Docker daemon.
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
  an incomplete verification as PASS. `SECURITY_GAP_REGISTER.md` S16-4 records the reading and the
  open design question it leaves for MergeSutra-owned Git reads.
- The digest this repository pins for the sandbox is not a git image. The image pinned by
  `.github/workflows/sandbox-runtime.yml` and `scripts/sandbox-runtime-proof.mjs` is Alpine with
  `NODE_VERSION=26.6.0` and no `git` binary at all, so the container refuses to start MergeSutra's own
  `diff-check` gate: exit 127, `exec: "git": executable file not found in $PATH`, round `FAIL`. The
  hosted proofs stay green because the only programs they run inside the container are `node` ones.
  Sandbox-backed execution is therefore qualified for `node` commands and unqualified for git-native
  ones, and no Node 22 or Node 24 sandbox image has been measured.
- Unit tests may inject a trusted fixture runner to exercise scenario logic;
  that dependency-injection seam is **not** a product-level opt-out switch.
- Repository-controlled commands are distinct from MergeSutra-owned GitHub
  read transports. Any new execution path must be added to the threat-model
  inventory and exercised against the actual sandbox before release.
- First customer release still requires controlled tests across Node 22/24 on
  Ubuntu/Windows/macOS, a representative task benchmark, actual remote draft-PR
  publication and honest failure reporting.

See [sandbox security blocker](https://github.com/Pavithran-R-A/mergesutra/issues/33).
