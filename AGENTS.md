# Agent onboarding — OKF Knowledge Vault

This repository combines a **provider-neutral workflow skill** with a **deterministic TypeScript helper CLI** for AI-assisted OKF vault ingestion. Any agent runtime (Cursor, Claude Code, etc.) should treat this file as the entry point.

## Choose the right command

Use this one-screen decision tree before reading the full skill. Map MCP and filesystem access via [capabilities preflight](.agents/skills/okf-vault/references/capabilities.md) — never assume runtime-specific tool names.

| Your goal | Command | Notes |
| --------- | ------- | ----- |
| **Add new content** (recommended starting point) | **`/vault-ingest`** | Interactive ingest wizard — MCP artifact or explicit local file |
| Set up a new vault at `./knowledge/` | `/vault-init` or `/vault-bootstrap` | `/vault-init` creates layout; `/vault-bootstrap` runs init then validate (Phase 1b) |
| Organize notes after ingestion | `/vault-organize` | Dossiers and curation proposals (Phase 1b) |
| Check vault health / contracts | `/vault-validate` | Contract, manifest, graph checks (Phase 1b) |
| Inspect the knowledge graph | `/vault-visualize` | OKF visualizer (Phase 1b) |
| Ingest then validate in one session | `/vault-ingest-check` | Composed pipeline (Phase 1b) |

Full command list with availability labels: [commands/registry.md](.agents/skills/okf-vault/commands/registry.md).

## Canonical skill

Read and follow [`.agents/skills/okf-vault/SKILL.md`](.agents/skills/okf-vault/SKILL.md) for all vault workflows:

| Mode         | Purpose                                                              |
| ------------ | -------------------------------------------------------------------- |
| `initialize` | Create vault layout, manifest, indexes, log, and Git repository    |
| `ingest`     | Sequentially acquire, convert, validate, and commit supplied sources |
| `organize`   | Generate bounded dossiers and curation proposals after conversion    |
| `validate`   | Run contract, manifest, graph, and recovery checks                   |
| `visualize`  | Invoke the configured OKF visualizer for manual graph review         |

The skill orchestrates acquisition, semantic conversion, and curation proposals. The helper owns validation, manifest mutation, graph analysis, dossiers, and Git transactions.

## Helper CLI

First-time setup in this repository: `pnpm run setup` (see [README.md](README.md#quick-start)).

One-time global CLI for other repositories: `pnpm run setup:link` in the okf-vault clone, then `okf-vault init` from a new repo root (creates `./knowledge/` and installs skill adapters). `setup:link` requires the pnpm global bin directory on `PATH` — run `pnpm setup` and restart your shell, or add `export PATH="$(pnpm bin -g):$PATH"` to your shell profile.

Build before invoking locally:

```bash
pnpm install
pnpm run build
```

Invoke as a child process with an **argument array** — never shell-interpolate curator paths:

```bash
node dist/main.js <command> [args...]
```

The binary name is `okf-vault` when installed via `pnpm run setup:link`; during development use `node dist/main.js` directly.

### Init from a new repository

```bash
# once, in okf-vault clone (pnpm bin -g must be on PATH; run `pnpm setup` if needed)
pnpm run setup:link

# in your new repo root
okf-vault init
```

No-arg `init` creates `./knowledge/` and installs `.cursor`/`.claude` skill adapters, including per-command slash entries for both runtimes (Cursor `.cursor/skills/<cmd>/SKILL.md`, Claude `.claude/commands/<cmd>.md`) so every `/vault-*` is individually discoverable. Explicit `okf-vault init <vault-root>` initializes the vault only (backward compatible).

## Key contracts

All durable contracts live under [`.agents/skills/okf-vault/references/`](.agents/skills/okf-vault/references/):

| Contract          | File                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| Note contract     | [note-contract.md](.agents/skills/okf-vault/references/note-contract.md) |
| Source envelope   | [source-envelope.md](.agents/skills/okf-vault/references/source-envelope.md) |
| Vault layout      | [vault-layout.md](.agents/skills/okf-vault/references/vault-layout.md) |
| Capabilities      | [capabilities.md](.agents/skills/okf-vault/references/capabilities.md) |
| Helper invocation | [helper-invocation.md](.agents/skills/okf-vault/references/helper-invocation.md) |
| Ingest wizard      | [ingest-wizard.md](.agents/skills/okf-vault/references/ingest-wizard.md) |

Do not duplicate reference content elsewhere in the repo.

## Repo boundaries

| Layer              | Location              | Responsibility                                              |
| ------------------ | --------------------- | ----------------------------------------------------------- |
| Workflow skill     | `.agents/skills/okf-vault/` | Orchestration, acquisition, conversion, curator interaction |
| Deterministic gate | `src/vault/`          | Validation, manifest, graph, dossiers, Git transactions     |
| CLI entry          | `src/cli.ts`, `src/main.ts` | Argument parsing, dispatch, JSON stdout/stderr         |
| Tests              | `test/fixtures/`, `test/workflows/` | Contract and workflow fixtures                        |

## Curator rules (non-negotiable)

- **Explicit sources only** — never watch Drive, Granola, or filesystem paths automatically.
- **One source at a time** — complete acquire → validate → commit before starting the next source.
- **Failure stop (ADR-009)** — after a source failure, stop and offer retry, skip with reason, or abort. Do not silently continue.
- **Deterministic gate** — do not commit notes that failed helper validation.
- **Helper-only Git transactions** — agents must not manually mutate managed vault paths outside the helper's `commit` / `recover` flow.

## What not to do

- Do not add automatic file watchers or batch silent conversion.
- Do not vendor or require compozy / cy-* workflow skills in this repo.
- Do not embed runtime-specific MCP tool names in durable instructions — map capabilities at preflight time.
- Do not create a root `references/` directory; the skill references folder is the single source of truth.

## Development

```bash
pnpm test              # build + run all tests
pnpm run lint          # ESLint
pnpm run format:check  # Prettier
```

Requires Node >= 24 (recommended: see `.nvmrc`).
