import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORGANIZE_BLOCKED_PENDING_SOURCES_CODE,
  ORGANIZE_BLOCKED_UNRESOLVED_JOURNAL_CODE,
  ORGANIZE_MODE_INITIAL,
  ORGANIZE_MODE_INCREMENTAL,
  checkOrganizePreflight,
  countTermOverlap,
  extractOrganizeTerms,
  filterProposalsToScope,
  listTopicMapPaths,
  normalizeOrganizeTerm,
  proposalImpliesPathMove,
  proposalImpliesSilentDuplicateMerge,
  proposalsTargetPathsOutsideScope,
  selectIncrementalOrganizeScope,
} from "../../dist/vault/organize.js";
import { type NoteDossier } from "../../dist/vault/dossier.js";
import { generateVaultDossiers } from "../../dist/vault/dossier.js";
import {
  INVALID_AFFECTED_PATH_CODE,
  type CurationProposal,
  validateProposalBatch,
} from "../../dist/vault/proposals.js";
import { TRANSACTION_JOURNAL_VERSION, writeFailureJournal } from "../../dist/vault/transaction.js";

const FIXTURE_ROOT = join(process.cwd(), "test", "fixtures", "vaults", "organize");

function sampleDossier(overrides: Partial<NoteDossier> = {}): NoteDossier {
  return {
    schema_version: "okf-vault-dossier/1.0.0",
    path: "notes/sample.md",
    title: "Sample Note",
    summary: "Sample summary.",
    claims: [{ id: "claim-001", text: "Sample claim text." }],
    claim_ids: ["claim-001"],
    claims_truncated: false,
    source: { source_key: "local:/fixtures/sample", kind: "local" },
    existing_links: [],
    topic_hints: ["strategy"],
    ...overrides,
  };
}

describe("organize term normalization", () => {
  it("normalizes punctuation and casing for overlap selection", () => {
    assert.equal(normalizeOrganizeTerm("  Strategy!  "), "strategy");
    assert.ok(extractOrganizeTerms(sampleDossier()).includes("strategy"));
  });

  it("selects incremental scope from new dossiers, overlap notes, and topic maps", () => {
    const newDossier = sampleDossier({
      path: "notes/customer-retention.md",
      title: "Customer Retention Strategy",
      topic_hints: ["strategy", "retention"],
      claims: [{ id: "claim-004", text: "Retention strategy reduces churn." }],
      claim_ids: ["claim-004"],
      source: { source_key: "local:/fixtures/customer-retention", kind: "local" },
    });
    const overlapDossier = sampleDossier({
      path: "notes/market-strategy.md",
      title: "Market Strategy Overview",
      topic_hints: ["strategy", "planning"],
      claims: [{ id: "claim-002", text: "Strategy planning aligns roadmap with revenue." }],
      claim_ids: ["claim-002"],
      source: { source_key: "local:/fixtures/market-strategy", kind: "local" },
    });
    const unrelatedDossier = sampleDossier({
      path: "notes/unrelated-astronomy.md",
      title: "Unrelated Astronomy Facts",
      topic_hints: ["astronomy", "nebula"],
      claims: [{ id: "claim-003", text: "Nebula observations reveal stellar formation." }],
      claim_ids: ["claim-003"],
      source: { source_key: "local:/fixtures/unrelated-astronomy", kind: "local" },
    });

    const scope = selectIncrementalOrganizeScope({
      dossiers: [newDossier, overlapDossier, unrelatedDossier],
      newSourceKeys: ["local:/fixtures/customer-retention"],
      topicMapPaths: ["topics/strategy.md"],
    });

    assert.deepEqual(scope.new_source_keys, ["local:/fixtures/customer-retention"]);
    assert.deepEqual(scope.overlap_selected_paths, ["notes/market-strategy.md"]);
    assert.ok(scope.selected_dossier_paths.includes("notes/customer-retention.md"));
    assert.ok(scope.selected_dossier_paths.includes("notes/market-strategy.md"));
    assert.ok(scope.selected_dossier_paths.includes("topics/strategy.md"));
    assert.equal(scope.selected_dossier_paths.includes("notes/unrelated-astronomy.md"), false);
    assert.ok(countTermOverlap(newDossier, overlapDossier) >= 1);
  });
});

describe("organize preflight", () => {
  it("blocks initial organize when ingest batch sources are pending", () => {
    const vaultRoot = join(FIXTURE_ROOT, "initial");
    const result = checkOrganizePreflight({
      vaultRoot,
      mode: ORGANIZE_MODE_INITIAL,
      ingestBatchSourceKeys: [
        "local:/fixtures/revenue-growth",
        "local:/fixtures/market-strategy",
        "local:/fixtures/pending-source",
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, ORGANIZE_BLOCKED_PENDING_SOURCES_CODE);
  });

  it("blocks organize when an unresolved transaction journal exists", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-organize-journal-"));
    mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
    mkdirSync(join(vaultRoot, "notes"), { recursive: true });
    mkdirSync(join(vaultRoot, "topics"), { recursive: true });
    writeFileSync(
      join(vaultRoot, ".okf-vault", "manifest.json"),
      readFileSync(join(FIXTURE_ROOT, "initial", ".okf-vault", "manifest.json")),
    );
    writeFileSync(
      join(vaultRoot, "index.md"),
      readFileSync(join(FIXTURE_ROOT, "initial", "index.md")),
    );
    writeFileSync(join(vaultRoot, "log.md"), readFileSync(join(FIXTURE_ROOT, "initial", "log.md")));
    writeFileSync(
      join(vaultRoot, "notes", "index.md"),
      readFileSync(join(FIXTURE_ROOT, "initial", "notes", "index.md")),
    );
    writeFileSync(
      join(vaultRoot, "topics", "index.md"),
      readFileSync(join(FIXTURE_ROOT, "initial", "topics", "index.md")),
    );

    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-failed-ingest",
      source_key: "local:/fixtures/revenue-growth",
      phase: "commit",
      failed_at: "2026-06-19T12:00:00.000Z",
      error_code: "COMMIT_FAILED",
      error_message: "Simulated failed ingest commit.",
      snapshot: { manifest: "{}", log: "", notes: {} },
      installed_paths: [],
    });

    const result = checkOrganizePreflight({
      vaultRoot,
      mode: ORGANIZE_MODE_INCREMENTAL,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, ORGANIZE_BLOCKED_UNRESOLVED_JOURNAL_CODE);
  });

  it("allows initial organize when ingest batch sources are committed", () => {
    const vaultRoot = join(FIXTURE_ROOT, "initial");
    const result = checkOrganizePreflight({
      vaultRoot,
      mode: ORGANIZE_MODE_INITIAL,
      ingestBatchSourceKeys: [
        "local:/fixtures/revenue-growth",
        "local:/fixtures/market-strategy",
        "local:/fixtures/unrelated-astronomy",
      ],
    });

    assert.equal(result.ok, true);
  });
});

describe("proposal policy helpers", () => {
  it("rejects proposals that imply path moves or silent duplicate merges", () => {
    const pathMove: CurationProposal = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-move",
      type: "link",
      affected_paths: ["notes/revenue-growth.md"],
      rationale: "Move note path notes/revenue-growth.md -> notes/archive/revenue.md",
      confidence: "low",
      disposition: "pending",
    };
    const silentMerge: CurationProposal = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-merge",
      type: "duplicate",
      affected_paths: ["notes/revenue-growth.md", "notes/market-strategy.md"],
      claim_ids: ["claim-001"],
      rationale: "Merge into market strategy note and delete duplicate note.",
      confidence: "low",
      disposition: "pending",
    };

    assert.equal(proposalImpliesPathMove(pathMove), true);
    assert.equal(proposalImpliesSilentDuplicateMerge(silentMerge), true);
  });

  it("filters incremental proposals to scoped paths only", () => {
    const scope = ["notes/customer-retention.md", "notes/market-strategy.md", "topics/strategy.md"];
    const inScope: CurationProposal = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-in-scope",
      type: "link",
      affected_paths: ["notes/customer-retention.md", "notes/market-strategy.md"],
      rationale: "Scoped link.",
      confidence: "high",
      disposition: "pending",
    };
    const outOfScope: CurationProposal = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-out-scope",
      type: "link",
      affected_paths: ["notes/unrelated-astronomy.md"],
      rationale: "Outside incremental scope.",
      confidence: "low",
      disposition: "pending",
    };

    const filtered = filterProposalsToScope([inScope, outOfScope], scope);
    assert.deepEqual(
      filtered.map((entry) => entry.proposal_id),
      ["prop-in-scope"],
    );
    assert.deepEqual(proposalsTargetPathsOutsideScope([outOfScope], scope), [
      "notes/unrelated-astronomy.md",
    ]);
  });
});

describe("organize fixture dossiers", () => {
  it("lists topic map paths from incremental fixture vault", () => {
    const vaultRoot = join(FIXTURE_ROOT, "incremental");
    assert.deepEqual(listTopicMapPaths(vaultRoot), ["topics/strategy.md"]);
    const dossiers = generateVaultDossiers(vaultRoot);
    assert.equal(dossiers.count, 4);
  });
});

describe("invalid proposal batch gate", () => {
  it("fails task-11 validation for missing path references before curator presentation", () => {
    const vaultRoot = join(FIXTURE_ROOT, "initial");
    const raw = JSON.parse(
      readFileSync(join(vaultRoot, "proposals", "invalid-path-batch.json"), "utf8"),
    ) as { proposals: CurationProposal[] };
    const result = validateProposalBatch(vaultRoot, raw.proposals);

    assert.equal(result.report.status, "fail");
    assert.deepEqual(result.valid_proposal_ids, []);
    assert.deepEqual(result.invalid_proposal_ids, ["prop-invalid-missing-path"]);
    assert.ok(result.report.issues.some((issue) => issue.code === INVALID_AFFECTED_PATH_CODE));
  });
});
