---
type: Article Note
title: Unresolved Claim
description: References claim-007 without frontmatter entry.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/sources/sample-article.md
  kind: local
  origin: /tmp/sources/sample-article.md
  content_sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  acquired_at: 2026-06-19T12:00:00.000Z
claims:
  - id: claim-001
    text: Revenue grew 12% year over year.
    anchors:
      - anchor-001
  - id: claim-007
    text: Unsupported claim without anchor.
    anchors:
      - anchor-missing
---

# Summary

Summary.

# Key Claims

- Valid claim (claim-001).
- Missing anchor claim (claim-007).

# Citations

- Source.

# Evidence

> Evidence for claim-001.
