# Organize / Curate Workflow

Organize mode produces **proposal JSON only** — topic maps, link suggestions, duplicate candidates, and contradiction candidates. The agent runtime analyzes bounded dossiers from the helper; it **never** auto-applies changes to notes, indexes, or topic maps. Curator approval is mandatory before any proposal modifies vault files (ADR-001, ADR-007).

Two organize modes exist:

| Mode          | When used                                                                    | Dossier scope                                                    |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `initial`     | After the **full corpus ingest** completes (ADR-002)                         | Complete bounded dossier set from helper `dossier`               |
| `incremental` | After a **manual incremental ingest** adds one or more new sources (ADR-004) | New dossiers + overlap-selected existing notes + Maps-of-Content |

## Proposal-only agent boundary

1. Call helper `dossier <vault-root>` to obtain the bounded dossier set (task 11).
2. Generate curation proposals in memory or staged JSON under `.okf-vault/tmp/<run-id>/proposals.json`.
3. Call helper `validate-proposals <vault-root> <proposals-json-path>` **before** curator presentation.
4. Emit `organize_proposals_ready` only after validation passes for the batch being presented.
5. **Do not** write proposal outcomes into note bodies, `topics/index.md`, topic maps, or manifest records during organize.

Forbidden during organize:

- Auto-applying link, topic, duplicate, or contradiction suggestions.
- Renaming or moving stable source-note paths under `notes/`.
- Silent duplicate merges or consolidation without explicit curator disposition.
- Re-ingesting or mutating existing committed notes.
- Full-vault re-cluster during incremental runs.

## Initial organize mode

Per ADR-002, initial organize starts **only after** the full corpus ingest completes.

### Preconditions

| Check                 | Requirement                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Ingest batch complete | **Zero pending sources** in the ingest run — every listed source is `committed` or `skipped` in the manifest |
| Transaction state     | No unresolved `.okf-vault/journal.json` from a failed commit (task 06) — run `recover` first                 |
| Vault state           | Initialized vault with clean managed paths                                                                   |
| Dossier input         | Helper `dossier` returns the complete bounded set for all committed source notes                             |

If manifest inspect or ingest left uncommitted failures recorded in the transaction journal, **reject organize start** until recovery completes.

### Initial workflow

1. **Preflight** — Verify vault initialization, helper `dossier` / `validate-proposals` readiness, clean managed paths, zero pending ingest sources, and no unresolved journal.
2. **Dossier handoff** — Run helper `dossier <vault-root>`. Consume the full `dossiers` array; do not truncate or re-order for analysis.
3. **Proposal generation** — Agent analyzes the complete dossier set and emits JSON proposals (`topic`, `link`, `duplicate`, `contradiction`).
4. **Validation gate** — Run helper `validate-proposals` on the batch. **Stop** and fix structural issues before curator review if validation fails (exit 3).
5. **Curator presentation** — Emit `organize_proposals_ready` with a summary of valid proposal IDs. Present proposals with disposition template (see below).
6. **Application** — Only after curator accepts proposals, apply changes through documented manual or helper-assisted steps (see [Approved change application](#approved-change-application)).

Initial organize MUST NOT begin while any source in the current ingest batch lacks a terminal manifest status.

## Incremental organize mode

Per ADR-004, incremental organize runs after the curator manually ingests new sources into an existing vault. It scopes analysis to new material plus related structure — **not** a full vault re-cluster.

### Preconditions

| Check                       | Requirement                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Incremental ingest complete | New source(s) committed through the standard ingest loop ([ingestion-loop.md](ingestion-loop.md)) |
| Transaction state           | No unresolved transaction journal                                                                 |
| Stable paths                | Existing committed note paths remain unchanged during organize                                    |

### Incremental scoping algorithm

Deterministic normalized-term overlap selects the incremental dossier scope:

1. **New note dossiers** — Include every dossier whose `source.source_key` appears in the incremental ingest run and is `committed` in the manifest.
2. **Maps-of-Content** — Always include all existing Topic Map notes under `topics/` (files with `type: Topic Map`), regardless of overlap.
3. **Overlap-selected existing notes** — For each remaining committed note dossier, compute normalized terms from:
   - `topic_hints`
   - title tokens (length ≥ 3)
   - claim text tokens (length ≥ 3)

   Terms are lowercased, punctuation-stripped, and whitespace-collapsed. Include an existing note when it shares **at least one** normalized term with any new dossier.

4. **Excluded regions** — Do not include unrelated vault regions: notes outside the scope set, envelope staging paths, manifest internals, or notes with zero term overlap.

Implementation reference: `selectIncrementalOrganizeScope` in `src/vault/organize.ts`.

Incremental organize:

- MUST NOT mutate or re-ingest existing committed notes.
- MUST NOT suggest moving stable note paths under `notes/`.
- MUST produce **zero proposals** targeting notes outside the scoped dossier set.

## Curator review and disposition

Every proposal batch presented to the curator MUST include a disposition field per proposal. Duplicate and contradiction types require explicit curator action — never auto-applied.

### Disposition template

| Field             | Required values                                    | Notes                        |
| ----------------- | -------------------------------------------------- | ---------------------------- |
| `disposition`     | `accepted`, `rejected`, or `resolved`              | `pending` only before review |
| `curator_comment` | Required for `resolved` on duplicate/contradiction | Explain resolution           |

| Proposal type   | Allowed dispositions                       | Auto-apply |
| --------------- | ------------------------------------------ | ---------- |
| `topic`         | accept / reject                            | No         |
| `link`          | accept / reject                            | No         |
| `duplicate`     | accept / reject / **resolve-with-comment** | **Never**  |
| `contradiction` | accept / reject / **resolve-with-comment** | **Never**  |

Record curator dispositions in the proposal JSON (or a companion review file under `.okf-vault/reviews/`) before applying accepted changes.

### Rejected proposal categories

Reject (do not present to curator) proposals that:

- Target paths outside managed `notes/` or `topics/`.
- Reference missing notes or unresolvable link targets (helper validation exit 3).
- Imply **path moves** or renames under `notes/` (e.g., "move note", "rename file", `notes/a.md -> notes/b.md`).
- Suggest **silent duplicate merges** (e.g., "merge into", "delete duplicate note", "consolidate notes") without curator review.

Helper `validate-proposals` enforces schema, path existence, claim IDs, and auto-application language. Organize documentation adds path-move and silent-merge rejection rules for agent-generated batches.

## Approved change application

Apply **only accepted** proposals through explicit curator or helper-assisted steps:

1. **Link proposals** — Add wikilinks or markdown links to the **body** of affected notes. Do **not** rename note files.
2. **Topic proposals** — Update Topic Map notes under `topics/` and the managed `topics/index.md` listing. Link to stable `notes/<file>.md` paths.
3. **Duplicate / contradiction resolutions** — Record curator disposition and comments. Do not silently merge note bodies or delete notes unless the curator explicitly directs a separate manual edit.

Stable source-note paths under `notes/` MUST remain unchanged — curation adds links and topic structure around them, not file renames.

### Index and topic map updates

After applying accepted link and topic proposals:

1. Update `topics/index.md` to list active Topic Map notes.
2. Update individual topic map files with links to relevant stable note paths.
3. Optionally update `notes/index.md` when new notes need index listing (without renaming note files).
4. Run helper `validate-graph <vault-root>` (task 05) to confirm zero orphans and two-hop navigation.
5. Commit index and topic map changes separately from source notes when possible; never amend committed source-note paths as part of organize application.

## Graph validation and progress events

| Step                                         | Event / helper                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Proposal batch ready for review              | Emit `organize_proposals_ready` (phase `organize`, status `ok`)                    |
| Proposal validation failure                  | Emit `validation_failed` with helper error; do not emit `organize_proposals_ready` |
| After applied link/index updates             | Run `validate-graph`; emit `validation_failed` on graph issues                     |
| Organize mode complete (proposals presented) | Emit `run_completed` when curator finishes review session                          |

See [progress-events.md](progress-events.md) for `organize_proposals_ready` field requirements.

## Helper commands

| Command                                            | Purpose                                                |
| -------------------------------------------------- | ------------------------------------------------------ |
| `dossier <vault-root>`                             | Bounded dossier set for organize analysis              |
| `validate-proposals <vault-root> <proposals.json>` | Structural validation gate before curator presentation |
| `validate-graph <vault-root>`                      | Post-application navigation validation                 |
| `recover <vault-root>`                             | Clear blocked state from failed ingest before organize |

## Related ADRs

- [ADR-002](../../../../.compozy/tasks/_archived/1782502158123-411d90b3-okf-knowledge-vault/adrs/adr-002.md) — Full corpus before initial organize
- [ADR-004](../../../../.compozy/tasks/_archived/1782502158123-411d90b3-okf-knowledge-vault/adrs/adr-004.md) — Incremental manual updates
- [ADR-007](../../../../.compozy/tasks/_archived/1782502158123-411d90b3-okf-knowledge-vault/adrs/adr-007.md) — Dossier-driven proposals
