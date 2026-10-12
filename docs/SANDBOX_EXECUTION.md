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
can be produced and contamination can still be detected.

## Limitations requiring dedicated acceptance before consumer launch

- The controlled real Docker adversarial fixture proves a specific Linux
  host-only secret, sibling-write, token-environment and loopback-network
  boundary. It does not prove every possible escape, other operating systems,
  or security against an actively compromised Docker daemon.
- Worktrees store Git metadata outside the single-mounted directory. Git-native
  verification checks may therefore refuse or fail inside the sandbox until
  safely isolated Git metadata is provided. Do not bypass this with a raw host
  runner or mark such an incomplete verification as PASS.
- Unit tests may inject a trusted fixture runner to exercise scenario logic;
  that dependency-injection seam is **not** a product-level opt-out switch.
- Repository-controlled commands are distinct from MergeSutra-owned GitHub
  read transports. Any new execution path must be added to the threat-model
  inventory and exercised against the actual sandbox before release.
- First customer release still requires controlled tests across Node 22/24 on
  Ubuntu/Windows/macOS, a representative task benchmark, actual remote draft-PR
  publication and honest failure reporting.

See [sandbox security blocker](https://github.com/Pavithran-R-A/mergesutra/issues/33).
