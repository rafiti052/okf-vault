---
name: okv-init
disable-model-invocation: true
---

# /okv-init

Create an OKV vault layout, manifest, indexes, and Git repository at `./knowledge/`.

## Where to go

- **Skill initialize mode** — [`SKILL.md`](../SKILL.md#initialize) (vault setup orchestration)
- **Helper CLI** — agents invoke `okv init --json` with argument arrays when helper output is needed
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
