# OKF Knowledge Vault — Managed Vault Layout

**Contract version:** `okf-vault-layout/1.0.0`

Defines the managed paths, reserved files, and index requirements for an OKF Knowledge Vault repository.

## Root layout

```text
<vault>/
├── index.md                 # populated root index (required)
├── log.md                   # OKF reserved change log (required)
├── notes/
│   ├── index.md             # populated notes index (required)
│   └── <stable-slug>.md     # source-derived concept notes
├── topics/
│   ├── index.md             # populated topics index (required)
│   └── <topic-slug>.md      # topic map notes (type: Topic Map)
├── references/
│   └── sources/
│       └── <source-slug>/
│           └── span-XXX.md  # helper-managed source evidence
└── .okf-vault/
    ├── manifest.json        # ingestion ledger (schema-versioned)
    ├── reviews/
    │   └── <run-id>.json    # validation / curation review artifacts
    └── tmp/                 # transaction staging (Git-ignored)
```

## Path rules

- All managed note paths are vault-relative (e.g. `notes/example.md`).
- Absolute paths and parent traversal (`..`) are rejected.
- Note slugs use lowercase alphanumeric segments separated by hyphens.
- Source notes live under `notes/`; taxonomy uses linked topic maps under `topics/`, not path moves during curation.
- Durable source evidence lives under `references/sources/<source-slug>/span-XXX.md`; it is helper-managed provenance, not a semantic note or topic map.
- The helper includes `references/sources/` in managed clean-path checks. Curators MUST NOT edit source-span documents directly; re-ingest the explicit source instead.

## Managed source-span references

Each committed source span is an OKF-readable Markdown reference document with `type: Source Span` and contract version `okf-source-spans/1.0.0`. The manifest indexes the current span paths, hashes, source profile, anchor coverage, and immediate sibling links; full span text stays in the reference documents rather than the manifest.

Profile rules define the evidence unit and metadata:

- articles use ordered anchor-backed text spans with optional heading and parent-label context;
- videos use timestamp segments in envelope order;
- panels use ordered speaker turns, timestamp segments, or combined timestamp-speaker turns without inventing missing attribution;
- decks use ordered slide and speaker-note spans with slide number and anchor kind.

Source spans are post-selection evidence only. `okv retrieve` ranks topic maps, hydrates committed linked notes, and then resolves each selected note's claim anchors through its manifest index. Each `source_spans` item contains one `exact` span and at most one `previous` and one `next` sibling, so one anchor hydration returns no more than three spans. Span text is never a first-hop retrieval candidate.

Purge and supersede operations remove or replace current-tree span references and manifest entries. Previously committed source text may remain in Git history unless the repository owner rewrites history outside the helper.

## Reserved files

| Path              | OKF role         | Additional requirements                                  |
| ----------------- | ---------------- | -------------------------------------------------------- |
| `index.md`        | Root navigation  | MUST be populated with links to notes and topics indexes |
| `log.md`          | Change history   | Append-only human-readable run history                   |
| `notes/index.md`  | Notes MoC entry  | MUST list every note under `notes/`                      |
| `topics/index.md` | Topics MoC entry | MUST list every topic map under `topics/`                |

## `.okf-vault/` metadata

### `manifest.json`

- Authoritative ingestion ledger per ADR-006.
- Records only `committed` and `skipped` source outcomes.
- Failed or in-progress transactions MUST NOT appear as committed manifest records; they remain in transaction journals and progress events.

### `reviews/`

- Machine-readable validation and curation review artifacts keyed by run ID.

### `tmp/`

- Staging area for atomic transactions (ADR-009).
- MUST be listed in `.gitignore`.
- MUST NOT be indexed by Obsidian as durable notes.
- MUST live under the vault root as `<vault-root>/.okf-vault/tmp/`; sibling `.okf-vault/` or `tmp/` working directories outside the vault root are invalid.
- Successful helper commits remove the run-specific staging directory (`<vault-root>/.okf-vault/tmp/<run-id>/`).

## Index population (ADR-001 reconciliation)

Every folder that contains managed concept notes MUST have a populated `index.md`:

- Vault root → `index.md`
- `notes/` → `notes/index.md`
- `topics/` → `topics/index.md`

Empty or missing indexes fail the quality gate.

## Git ignore requirements

At minimum:

```gitignore
.okf-vault/tmp/
```

## Credential prohibition

No managed path may store credentials, tokens, or API keys. Authentication remains runtime-owned (ADR-005).

## Initialization checklist

An initialized vault MUST contain:

1. Git repository with clean managed paths.
2. Populated `index.md`, `notes/index.md`, `topics/index.md`, and `log.md`.
3. Empty or zero-entry `manifest.json` with schema version fields.
4. `.okf-vault/reviews/` directory.
5. `.okf-vault/tmp/` directory (ignored).
