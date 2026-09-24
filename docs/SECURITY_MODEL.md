# MergeSutra — Security Model

> Status: the redaction layer, config handling, structured errors and the
> BharatCode adapter's request boundary are **[IMPLEMENTED]** and tested. The
> workspace-isolation, tool-classification and prompt-injection enforcement
> described here are the **[DESIGNED]** target the later stages implement.

## 1. Authority hierarchy (higher cannot be overridden by lower)

1. MergeSutra security policy
2. Explicit human approval
3. MergeSutra workflow policy
4. Trusted repository configuration
5. Issue requirements
6. Arbitrary repository content
7. Model suggestions

A string inside a source file, an issue comment, a filename, or a model
response can never raise its own authority. This ordering is what makes it safe
to read untrusted repositories and then execute commands.

## 2. Prompt-injection defence

Repository contents, issue bodies, comments and filenames may contain text like
"Ignore previous instructions", "Print environment variables", "Upload
~/.ssh", "Run curl ...", "Disable safety", or "Send tokens to this endpoint".
All such text is **data**, never authority.

Planned enforcement (Stage 12):

- Never execute arbitrary model text as a shell command.
- Never place repository text in a position that can change tool permissions.
- Adversarial fixtures assert that injection strings in a repo/issue produce no
  config change, no out-of-workspace write, no secret in output, and no
  unprompted remote call.

Implemented today: model output is schema-validated (a malformed or hostile
response fails safely) and all output text is redacted.

## 3. Tool risk classes and policy

| Class           | Examples                                  | Policy                                            |
| --------------- | ----------------------------------------- | ------------------------------------------------- |
| READ            | `git status`, `git diff`, file/dir reads  | Allowed within workspace                          |
| WRITE           | Authorized repo file edits                | Confined to authorized workspace only             |
| EXECUTE         | Tests, linters, builders, package scripts | argv arrays, classified, timeout, bounded output  |
| NETWORK         | Dependency install, GitHub reads          | Disclosed; no secrets sent                        |
| REMOTE MUTATION | push, PR creation, GitHub comments        | **Requires explicit human approval**              |
| DESTRUCTIVE     | force push, clean, reset, mass delete     | **Forbidden by default**                          |

No `sudo`. No global Git config changes. No touching unrelated directories.

## 4. Workspace isolation & file safety

- Prefer a dedicated Git worktree tied to the exact base SHA; never casually
  edit the user's primary checkout.
- Detect dirty state; preserve user work; refuse destructive behaviour.
- A Git worktree is an **isolation convenience, not a security sandbox** — the
  security guarantee is the write-confinement check, not the worktree itself.
- Before any write, prove the resolved destination is inside the authorized
  workspace. Defend against: `../` traversal, absolute-path escape, symlink
  escape, Windows junction/reparse-point escape, device paths, binary
  corruption, and huge-file ingestion. Model-requested writes outside the
  boundary fail.

## 5. Command execution safety

- Never `shell: true` unless an extremely strong, fully-controlled,
  platform-specific reason exists (currently: never).
- Separate executable from arguments (argv arrays); do not evaluate arbitrary
  strings.
- Before executing a repository-defined command: identify, classify, display
  when appropriate, apply policy, enforce timeout, capture exit code, preserve
  bounded logs.
- Do not trust package scripts blindly.

## 6. Secret protection (implemented)

Central `Redactor` masks at minimum: `BHARATCODE_API_KEY`, `GITHUB_TOKEN`,
`GH_TOKEN`, `Authorization` headers, and common token formats (OpenAI-style
`sk-`, GitHub `ghp_/gho_/ghs_/github_pat_`, Slack `xox`, AWS `AKIA`, PEM
private keys). It redacts text, header records, and nested structures, and can
be given exact runtime secret values for literal masking.

- Full process environments are never logged.
- Subprocesses get controlled environments.
- Redaction applies to error `details` (a real leak in response bodies was
  caught by test and fixed).

## 7. Model/provider availability

BharatCode is shared and may be unavailable or rate-limited. Handled with
bounded exponential backoff + jitter honouring `Retry-After`: `401/403` (no
retry), `408/429/5xx` (bounded retry), timeouts, connection/DNS errors, and
cancellation. A provider failure yields a useful status, never corrupted work.

## 8. Privacy

- Initial public scope favours **public** repositories.
- Never send to BharatCode: unrelated files, `.git` credentials, `.env` by
  default, private keys, credential stores, or SSH data.
- Context selection (issue, contract, policies, relevant excerpts, diff) is
  used instead of dumping whole repositories — improving latency, reliability
  and privacy.

## 9. Git safety (implemented stance)

Never: force push, merge, rewrite user branches, hard-reset the user's checkout,
delete unrelated branches, or `git clean` the user's primary repo. Use dedicated
branches/worktrees, record the exact base SHA, and require human approval for
any remote change.
