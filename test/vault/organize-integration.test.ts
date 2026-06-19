import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../../dist/cli.js";
import { generateVaultDossiers } from "../../dist/vault/dossier.js";
import {
  filterProposalsToScope,
  listTopicMapPaths,
  selectIncrementalOrganizeScope,
} from "../../dist/vault/organize.js";
import { parseProposalBatch, validateProposalBatch } from "../../dist/vault/proposals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const bin = join(root, "dist", "main.js");
const FIXTURE_ROOT = join(root, "test", "fixtures", "vaults", "organize");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readNoteHashes(vaultRoot: string, paths: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const relativePath of paths) {
    hashes.set(relativePath, sha256(readFileSync(join(vaultRoot, relativePath), "utf8")));
  }
  return hashes;
}

function applyAcceptedLinkProposal(vaultRoot: string): void {
  const revenuePath = join(vaultRoot, "notes/revenue-growth.md");
  const revenue = readFileSync(revenuePath, "utf8");
  writeFileSync(
    revenuePath,
    `${revenue.trim()}\n\nSee also [[notes/market-strategy.md]].\n`,
    "utf8",
  );

  const strategyTopicPath = join(vaultRoot, "topics/strategy.md");
  const strategyTopic = readFileSync(strategyTopicPath, "utf8");
  writeFileSync(
    strategyTopicPath,
    `${strategyTopic.trim()}\n\n- [[notes/revenue-growth.md]]\n- [[notes/market-strategy.md]]\n`,
    "utf8",
  );

  const topicsIndexPath = join(vaultRoot, "topics/index.md");
  const topicsIndex = readFileSync(topicsIndexPath, "utf8");
  if (!topicsIndex.includes("notes/revenue-growth.md")) {
    writeFileSync(
      topicsIndexPath,
      `${topicsIndex.trim()}\n\nLinked notes: [[notes/revenue-growth.md]], [[notes/market-strategy.md]]\n`,
      "utf8",
    );
  }
}

describe("initial organize fixture integration", () => {
  it("generates dossiers, validates proposals, and leaves note bodies unchanged", () => {
    const vaultRoot = join(FIXTURE_ROOT, "initial");
    const notePaths = [
      "notes/revenue-growth.md",
      "notes/market-strategy.md",
      "notes/unrelated-astronomy.md",
    ];
    const beforeHashes = readNoteHashes(vaultRoot, notePaths);

    const dossierOutcome = spawnSync(process.execPath, [bin, "dossier", vaultRoot], {
      encoding: "utf8",
    });
    assert.equal(dossierOutcome.status, ExitCode.SUCCESS);

    const proposalsPath = join(vaultRoot, "proposals", "initial-batch.json");
    const validateOutcome = spawnSync(
      process.execPath,
      [bin, "validate-proposals", vaultRoot, proposalsPath],
      { encoding: "utf8" },
    );
    assert.equal(validateOutcome.status, ExitCode.SUCCESS);

    const payload = JSON.parse(validateOutcome.stdout) as {
      data: { status: string; valid_proposal_ids: string[] };
    };
    assert.equal(payload.data.status, "pass");
    assert.equal(payload.data.valid_proposal_ids.length, 2);

    const afterHashes = readNoteHashes(vaultRoot, notePaths);
    for (const path of notePaths) {
      assert.equal(afterHashes.get(path), beforeHashes.get(path));
    }

    const dossierSet = generateVaultDossiers(vaultRoot);
    assert.equal(dossierSet.count, 3);
  });

  it("passes graph validation after documented index and topic map updates", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-organize-graph-"));
    cpSync(join(FIXTURE_ROOT, "initial"), vaultRoot, { recursive: true });
    applyAcceptedLinkProposal(vaultRoot);

    const graphOutcome = spawnSync(process.execPath, [bin, "validate-graph", vaultRoot], {
      encoding: "utf8",
    });
    assert.equal(graphOutcome.status, ExitCode.SUCCESS);

    const payload = JSON.parse(graphOutcome.stdout) as { data: { status: string } };
    assert.equal(payload.data.status, "pass");
  });
});

describe("incremental organize fixture integration", () => {
  it("scopes to new dossier, overlapping note, and topic maps with zero out-of-scope proposals", () => {
    const vaultRoot = join(FIXTURE_ROOT, "incremental");
    const dossierSet = generateVaultDossiers(vaultRoot);
    const scope = selectIncrementalOrganizeScope({
      dossiers: dossierSet.dossiers,
      newSourceKeys: ["local:/fixtures/customer-retention"],
      topicMapPaths: listTopicMapPaths(vaultRoot),
    });

    assert.ok(scope.selected_dossier_paths.includes("notes/customer-retention.md"));
    assert.ok(scope.overlap_selected_paths.includes("notes/market-strategy.md"));
    assert.ok(scope.selected_dossier_paths.includes("topics/strategy.md"));
    assert.equal(scope.selected_dossier_paths.includes("notes/unrelated-astronomy.md"), false);

    const proposalsPath = join(vaultRoot, "proposals", "incremental-batch.json");
    const proposals = parseProposalBatch(
      JSON.parse(readFileSync(proposalsPath, "utf8")) as unknown,
    );
    const validation = validateProposalBatch(vaultRoot, proposals);
    assert.equal(validation.report.status, "pass");

    const scoped = filterProposalsToScope(proposals, scope.selected_dossier_paths);
    assert.equal(scoped.length, proposals.length);
  });

  it("leaves pre-existing notes outside overlap byte-identical after organize scoping", () => {
    const vaultRoot = join(FIXTURE_ROOT, "incremental");
    const untouchedPaths = ["notes/revenue-growth.md", "notes/unrelated-astronomy.md"];
    const beforeHashes = readNoteHashes(vaultRoot, untouchedPaths);

    const dossierSet = generateVaultDossiers(vaultRoot);
    selectIncrementalOrganizeScope({
      dossiers: dossierSet.dossiers,
      newSourceKeys: ["local:/fixtures/customer-retention"],
      topicMapPaths: listTopicMapPaths(vaultRoot),
    });

    const afterHashes = readNoteHashes(vaultRoot, untouchedPaths);
    for (const path of untouchedPaths) {
      assert.equal(afterHashes.get(path), beforeHashes.get(path));
    }
  });
});

describe("organize progress event contract", () => {
  it("supports organize_proposals_ready emission after validated proposal batch", () => {
    const vaultRoot = join(FIXTURE_ROOT, "initial");
    const proposalsPath = join(vaultRoot, "proposals", "initial-batch.json");
    const validateOutcome = spawnSync(
      process.execPath,
      [bin, "validate-proposals", vaultRoot, proposalsPath],
      { encoding: "utf8" },
    );
    assert.equal(validateOutcome.status, ExitCode.SUCCESS);

    const payload = JSON.parse(validateOutcome.stdout) as {
      data: { valid_proposal_ids: string[] };
    };
    const event = {
      event: "organize_proposals_ready",
      run_id: "run-organize-fixture",
      phase: "organize",
      status: "ok",
      timestamp: new Date().toISOString(),
      duration_ms: 1000,
      proposal_count: payload.data.valid_proposal_ids.length,
      message: "Validated proposal batch ready for curator review",
    };

    assert.equal(event.proposal_count, 2);
    assert.equal(event.event, "organize_proposals_ready");
  });
});
