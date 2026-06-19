# Helper Invocation

The **okf-vault** TypeScript helper provides deterministic validation, manifest lifecycle, graph checks, dossiers, proposals, and Git transactions. The workflow invokes it as a child process — never via shell-interpolated command strings.

## Output channels

| Channel    | Content                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| **stdout** | Single JSON object per invocation (`CliResult`)                         |
| **stderr** | Human-readable diagnostics only — never parse stderr as structured data |

### Success shape

```json
{ "status": "ok", "command": "inspect", "data": {} }
```

### Error shape

```json
{ "status": "error", "command": "validate-staged", "code": "VALIDATION_FAILED", "message": "..." }
```

## Exit classes

| Exit code | Class       | Meaning                                            |
| --------- | ----------- | -------------------------------------------------- |
| 0         | Success     | Command completed; parse JSON from stdout          |
| 1         | Unexpected  | Internal or I/O failure                            |
| 2         | Usage       | Missing arguments or unknown command               |
| 3         | Validation  | Note, envelope, or schema validation failed        |
| 4         | Conflict    | Manifest hash conflict or dirty managed paths      |
| 5         | Transaction | Install/commit failure; journal may need `recover` |

## Curator actions during ingestion

| Exit | Typical cause             | Curator action                                                                           |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------- |
| 0    | Success                   | Continue to next phase                                                                   |
| 1    | Unexpected helper failure | **Stop** — inspect stderr; retry once after fixing environment; **abort** if persistent  |
| 2    | Usage                     | **Stop** — fix invocation arguments; **retry**                                           |
| 3    | Validation failure        | **Stop** — fix conversion output; **retry** from convert; **skip** source; **abort** run |
| 4    | Conflict (changed source) | **Stop** — curator resolves conflict; **retry** or **skip**; **abort**                   |
| 5    | Transaction failure       | **Stop** — run **`recover`**; **retry** commit; **abort**                                |

Never auto-retry validation (3), conflict (4), or transaction (5) failures without curator confirmation.

## Commands by workflow phase

Invoke with an **argument array**. Example shape (paths are illustrative):

### initialize

```
okf-vault init <vault-root>
```

Creates vault layout, manifest, indexes, log, and initial Git commit.

### inspect (manifest)

```
okf-vault inspect <vault-root> <kind> <origin-locator> <content-sha256>
```

Returns `new`, `already_processed`, or `changed_conflict` in stdout JSON.

### validate-staged

```
okf-vault validate-staged <vault-root> <staging-dir> <envelope-json-path>
```

Validates staged notes against note contract and envelope anchors before commit.

### commit

```
okf-vault commit <vault-root> <staging-dir> <envelope-json-path> <run-id>
```

Atomic per-source install and Git commit (ADR-009). On success, stdout includes commit identifier for `source_committed` events.

### validate-graph

```
okf-vault validate-graph <vault-root>
```

Zero-orphan and two-hop root-index reachability checks.

### recover

```
okf-vault recover <vault-root>
```

Restores managed paths after interrupted transactions; run when preflight detects a pending journal or exit 5 occurs.

### Reserved (later tasks)

- `dossier` — bounded note dossiers (task 11)
- `validate-proposals` — curation proposal validation (task 11)

## Invocation rules

1. Use `invoke_process` capability — spawn with `argv` array, no shell string concatenation.
2. Treat non-zero exit codes as failure even if stdout contains JSON.
3. Map exit class to curator choices before continuing the ingestion loop.
4. Record `commit_id` from successful `commit` stdout in progress events.
5. Keep staging under `.okf-vault/tmp/<run-id>/`; never stage unrelated vault paths.

## Transaction boundary (task 06)

Commit runs only after:

- Preflight passed
- Envelope normalization pre-check passed
- `validate-staged` exit 0
- Clean managed Git paths
- Vault lock acquired by helper

If commit fails, helper rolls back managed files and returns exit **5**. Workflow emits `run_failed` or `validation_failed` and stops for curator decision.
