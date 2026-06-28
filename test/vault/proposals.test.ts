import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import { initializeVault, saveManifest, type SourceRecord } from "../../dist/vault/manifest.js";
import {
  AUTO_APPLICATION_PROHIBITED_CODE,
  INVALID_AFFECTED_PATH_CODE,
  MISSING_CLAIM_IDS_CODE,
  validateSingleProposal,
  validateProposalBatch,
  type CurationProposal,
} from "../../dist/vault/proposals.js";

const VALID_SHA = "a".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function committedRecord(notePath: string): SourceRecord {
  return {
    source_key: `local:/tmp/${notePath}`,
    kind: "local",
    origin: `/tmp/${notePath}`,
    content_sha256: VALID_SHA,
    contract_version: NOTE_CONTRACT_VERSION,
    note_path: notePath,
    status: "committed",
    commit: "abc1234",
    processed_at: VALID_TS,
  };
}

function writeMinimalVault(vaultRoot: string, notes: Record<string, string>): void {
  initializeVault(vaultRoot);
  for (const [relativePath, content] of Object.entries(notes)) {
    const absolutePath = join(vaultRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }

  saveManifest(vaultRoot, {
    schema_version: "okf-vault-manifest/1.0.0",
    note_contract_version: NOTE_CONTRACT_VERSION,
    sources: Object.keys(notes).map((notePath) => committedRecord(notePath)),
  });
}

const NOTE_A = `---
type: Article Note
title: Note A
description: Proposal validation fixture A.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/a.md
  kind: local
  origin: /tmp/a.md
  content_sha256: ${VALID_SHA}
  acquired_at: ${VALID_TS}
claims:
  - id: claim-001
    text: Claim A
    anchors:
      - anchor-001
---

# Summary

A

# Key Claims

- Claim A (claim-001).

# Citations

- A

# Evidence

> Evidence.
`;

const NOTE_B = NOTE_A.replace(/Note A/g, "Note B").replace(/Claim A/g, "Claim B");

function baseProposal(overrides: Partial<CurationProposal>): CurationProposal {
  return {
    schema_version: "okf-vault-proposal/1.0.0",
    proposal_id: "prop-base",
    type: "link",
    affected_paths: ["notes/a.md", "notes/b.md"],
    rationale: "Related notes.",
    confidence: "medium",
    disposition: "pending",
    ...overrides,
  };
}

describe("proposal schema and path validation", () => {
  it("accepts a valid link proposal referencing existing managed note paths", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-proposals-valid-"));
    writeMinimalVault(vaultRoot, {
      "notes/a.md": NOTE_A,
      "notes/b.md": NOTE_B,
    });

    const issues = validateSingleProposal(
      vaultRoot,
      baseProposal({ proposal_id: "prop-link-valid", type: "link" }),
    );
    assert.deepEqual(issues, []);
  });

  it("rejects proposals targeting traversal or missing paths", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-proposals-path-"));
    writeMinimalVault(vaultRoot, { "notes/a.md": NOTE_A });

    const traversalIssues = validateSingleProposal(
      vaultRoot,
      baseProposal({
        proposal_id: "prop-outside",
        affected_paths: ["../outside.md"],
      }),
    );
    assert.ok(traversalIssues.some((entry) => entry.code === INVALID_AFFECTED_PATH_CODE));

    const missingIssues = validateSingleProposal(
      vaultRoot,
      baseProposal({
        proposal_id: "prop-missing",
        affected_paths: ["notes/missing.md"],
      }),
    );
    assert.ok(missingIssues.some((entry) => entry.code === INVALID_AFFECTED_PATH_CODE));
  });
});

describe("duplicate and contradiction policy", () => {
  it("fails duplicate proposals without claim ids using a stable error code", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-proposals-claims-"));
    writeMinimalVault(vaultRoot, {
      "notes/a.md": NOTE_A,
      "notes/b.md": NOTE_B,
    });

    const issues = validateSingleProposal(
      vaultRoot,
      baseProposal({
        proposal_id: "prop-dup-no-claims",
        type: "duplicate",
        affected_paths: ["notes/a.md", "notes/b.md"],
      }),
    );

    assert.ok(issues.some((entry) => entry.code === MISSING_CLAIM_IDS_CODE));
  });

  it("rejects contradiction proposals with silent auto-merge language", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-proposals-auto-"));
    writeMinimalVault(vaultRoot, {
      "notes/a.md": NOTE_A,
      "notes/b.md": NOTE_B,
    });

    const issues = validateSingleProposal(
      vaultRoot,
      baseProposal({
        proposal_id: "prop-auto-merge",
        type: "contradiction",
        affected_paths: ["notes/a.md", "notes/b.md"],
        claim_ids: ["claim-001", "claim-002"],
        suggested_changes: "Perform a silent merge of claim-001 into claim-002 without review.",
      }),
    );

    assert.ok(issues.some((entry) => entry.code === AUTO_APPLICATION_PROHIBITED_CODE));
  });
});

describe("proposal batch validation", () => {
  it("partitions valid and invalid proposal ids in mixed batches", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-proposals-batch-"));
    writeMinimalVault(vaultRoot, {
      "notes/a.md": NOTE_A,
      "notes/b.md": NOTE_B,
    });

    const result = validateProposalBatch(vaultRoot, [
      baseProposal({ proposal_id: "prop-valid", type: "link" }),
      baseProposal({
        proposal_id: "prop-invalid",
        type: "duplicate",
        affected_paths: ["notes/a.md", "notes/b.md"],
      }),
    ]);

    assert.equal(result.report.status, "fail");
    assert.deepEqual(result.valid_proposal_ids, ["prop-valid"]);
    assert.deepEqual(result.invalid_proposal_ids, ["prop-invalid"]);
  });
});
