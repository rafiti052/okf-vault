---
type: Article Note
title: Invented Claim Counterexample
description: Rejected gold fixture — claim references anchor absent from envelope.
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
  - id: claim-002
    text: Invented statistic not present in the source envelope.
    anchors:
      - anchor-invented
---

# Summary

Summary with a valid and an invented claim.

# Key Claims

- Revenue increased 12% year over year (claim-001).
- An unsupported statistic appears here (claim-002).

# Citations

- Sample Article source file.

# Evidence

> Revenue grew 12% year over year. [anchor-001]
