import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli/cli.js";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  initializeVault,
  saveManifest,
  type Manifest,
  type SourceRecord,
} from "../../dist/vault/manifest.js";
import {
  MISSING_GOLD_REVIEW_CODE,
  PENDING_PROPOSAL_DISPOSITION_CODE,
  REVIEW_SCHEMA_VERSION,
  runQualityGate,
  TRANSACTION_STATE_UNRESOLVED_CODE,
} from "../../dist/vault/quality-gate.js";
import { TRANSACTION_JOURNAL_VERSION, writeFailureJournal } from "../../dist/vault/transaction.js";
import { invokeVisualizer, VISUALIZER_SCHEMA_VERSION } from "../../dist/vault/visualizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const fixtureRoot = join(root, "test", "fixtures", "vaults", "quality-gate");
const organizeFixture = join(root, "test", "fixtures", "vaults", "organize", "initial");
const noopVisualizer = join(root, "test", "fixtures", "tools", "noop-visualizer.mjs");

const VALID_SHA = "a".repeat(64);
const VALID_SHA_B = "b".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function articleNoteBody(extra = ""): string {
  return [
    "# Summary",
    "Fixture summary.",
    "",
    "# Key Claims",
    "- Fixture claim (claim-001).",
    "",
    "# Citations",
    "- Fixture source.",
    "",
    "# Evidence",
    "> Evidence text. [anchor-001]",
    extra,
  ].join("\n");
}

function articleFrontmatter(title: string, sourceKey: string, sha: string): string {
  return [
    "---",
    "type: Article Note",
    `title: ${title}`,
    `description: ${title} fixture note.`,
    `contract_version: ${NOTE_CONTRACT_VERSION}`,
    "source:",
    `  source_key: ${sourceKey}`,
    "  kind: local",
    `  origin: /fixtures/${sourceKey}`,
    `  content_sha256: ${sha}`,
    `  acquired_at: ${VALID_TS}`,
    "claims:",
    "  - id: claim-001",
    "    text: Fixture claim text.",
    "    anchors:",
    "      - anchor-001",
    "---",
  ].join("\n");
}

function committedRecord(notePath: string, sourceKey: string, sha = VALID_SHA): SourceRecord {
  return {
    source_key: sourceKey,
    kind: "local",
    origin: `/fixtures/${sourceKey}`,
    content_sha256: sha,
    contract_version: NOTE_CONTRACT_VERSION,
    note_path: notePath,
    status: "committed",
    commit: "abc1234",
    processed_at: VALID_TS,
  };
}

function writePassingVault(
  vaultRoot: string,
  options: {
    notes: Record<string, string>;
    sources: SourceRecord[];
    rootLinks?: string;
    notesIndexLinks?: string;
  },
): void {
  mkdirSync(join(vaultRoot, "notes"), { recursive: true });
  mkdirSync(join(vaultRoot, "topics"), { recursive: true });
  mkdirSync(join(vaultRoot, ".okf-vault", "reviews"), { recursive: true });

  writeFileSync(
    join(vaultRoot, "index.md"),
    `# Root\n\n${options.rootLinks ?? "- [Notes](notes/index.md)\n"}`,
    "utf8",
  );
  writeFileSync(join(vaultRoot, "log.md"), "# Change Log\n", "utf8");
  writeFileSync(
    join(vaultRoot, "notes/index.md"),
    `# Notes\n\n${options.notesIndexLinks ?? "- [A](notes/a.md)\n"}`,
    "utf8",
  );
  writeFileSync(
    join(vaultRoot, "topics/index.md"),
    "# Topics\n\n- [Strategy](topics/strategy.md)\n",
    "utf8",
  );
  writeFileSync(
    join(vaultRoot, "topics/strategy.md"),
    "---\ntype: Topic Map\ntitle: Strategy\ndescription: Strategy topic map.\n---\n\n# Topics\n",
    "utf8",
  );

  for (const [relativePath, content] of Object.entries(options.notes)) {
    writeFileSync(join(vaultRoot, relativePath), content, "utf8");
  }

  const manifest: Manifest = {
    schema_version: "okf-vault-manifest/1.0.0",
    note_contract_version: NOTE_CONTRACT_VERSION,
    sources: options.sources,
  };
  saveManifest(vaultRoot, manifest);
}

function writeReview(vaultRoot: string, runId: string, body: Record<string, unknown>): void {
  const reviewsDir = join(vaultRoot, ".okf-vault", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, `${runId}.json`),
    `${JSON.stringify({ schema_version: REVIEW_SCHEMA_VERSION, ...body }, null, 2)}\n`,
    "utf8",
  );
}

function copyOrganizeFixture(vaultRoot: string): void {
  cpSync(organizeFixture, vaultRoot, { recursive: true });
}

describe("quality gate unit checks", () => {
  it("returns fail with graph orphan errors when a committed note lacks navigation", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-orphan-"));
    writePassingVault(vaultRoot, {
      rootLinks: "- [Notes](notes/index.md)\n",
      notesIndexLinks: "- [A](notes/a.md)\n",
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody("\nSee [[notes/b.md]].")}`,
        "notes/orphan.md": `${articleFrontmatter("Orphan", "local:/orphan", VALID_SHA_B)}\n${articleNoteBody()}`,
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/orphan.md", "local:/orphan", VALID_SHA_B),
      ],
    });

    const result = runQualityGate(vaultRoot);
    assert.equal(result.status, "fail");
    assert.equal(result.quality_gate_passed, false);
    assert.ok(result.issues.some((entry) => entry.code === "ORPHAN_NOTE"));
    assert.ok(result.checks.graph.issues.some((entry) => entry.code === "ORPHAN_NOTE"));
  });

  it("fails bidirectional manifest consistency when a manifest record points to a missing note", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-manifest-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/missing.md", "local:/missing", VALID_SHA_B),
      ],
      notesIndexLinks: "- [A](notes/a.md)\n- [Missing](notes/missing.md)\n",
    });

    const result = runQualityGate(vaultRoot);
    assert.ok(result.issues.some((entry) => entry.code === "MANIFEST_DRIFT"));
  });

  it("fails with transaction-state error when a stale journal remains without deleting data", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-journal-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
      },
      sources: [committedRecord("notes/a.md", "local:/a")],
    });

    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-stale",
      source_key: "local:/a",
      phase: "commit",
      failed_at: VALID_TS,
      error_code: "TRANSACTION_FAILED",
      error_message: "stale journal fixture",
      snapshot: {
        manifest: readFileSync(join(vaultRoot, ".okf-vault/manifest.json"), "utf8"),
        log: readFileSync(join(vaultRoot, "log.md"), "utf8"),
        notes: {},
      },
      installed_paths: [],
    });

    const result = runQualityGate(vaultRoot);
    assert.ok(result.issues.some((entry) => entry.code === TRANSACTION_STATE_UNRESOLVED_CODE));
    assert.equal(existsSync(join(vaultRoot, "notes/a.md")), true);
  });

  it("fails when a pending duplicate proposal lacks disposition even if structural checks pass", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-pending-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
        "notes/b.md": `${articleFrontmatter("Note B", "local:/b", VALID_SHA_B)}\n${articleNoteBody()}`,
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/b.md", "local:/b", VALID_SHA_B),
      ],
      notesIndexLinks: "- [A](notes/a.md)\n- [B](notes/b.md)\n",
    });

    writeReview(vaultRoot, "organize-001", {
      run_id: "organize-001",
      recorded_at: VALID_TS,
      proposals: [
        {
          schema_version: "okf-vault-proposal/1.0.0",
          proposal_id: "dup-001",
          type: "duplicate",
          affected_paths: ["notes/a.md", "notes/b.md"],
          claim_ids: ["claim-001"],
          rationale: "Similar claims.",
          confidence: "medium",
          disposition: "pending",
        },
      ],
    });

    const result = runQualityGate(vaultRoot);
    assert.equal(result.checks.curation.status, "fail");
    assert.ok(result.issues.some((entry) => entry.code === PENDING_PROPOSAL_DISPOSITION_CODE));
  });

  it("fails when required deck gold review is absent from review storage", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-gold-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
      },
      sources: [committedRecord("notes/a.md", "local:/a")],
    });

    writeReview(vaultRoot, "review-001", {
      run_id: "review-001",
      recorded_at: VALID_TS,
      required_gold_reviews: ["Slide Deck Note"],
      gold_note_reviews: {},
    });

    const result = runQualityGate(vaultRoot);
    assert.ok(result.issues.some((entry) => entry.code === MISSING_GOLD_REVIEW_CODE));
  });

  it("returns quality_gate_passed-compatible payload when all sub-checks pass", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-pass-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody("\nSee [[notes/b.md]].")}`,
        "notes/b.md": `${articleFrontmatter("Note B", "local:/b", VALID_SHA_B)}\n${articleNoteBody()}`,
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/b.md", "local:/b", VALID_SHA_B),
      ],
      notesIndexLinks: "- [A](notes/a.md)\n- [B](notes/b.md)\n",
    });

    writeReview(vaultRoot, "organize-complete", {
      run_id: "organize-complete",
      recorded_at: VALID_TS,
      required_gold_reviews: [],
      proposals: [
        {
          schema_version: "okf-vault-proposal/1.0.0",
          proposal_id: "dup-resolved",
          type: "duplicate",
          affected_paths: ["notes/a.md", "notes/b.md"],
          claim_ids: ["claim-001"],
          rationale: "Reviewed duplicate.",
          confidence: "medium",
          disposition: "resolved",
          curator_comment: "Distinct scope; keep both notes.",
        },
      ],
    });

    const result = runQualityGate(vaultRoot);
    assert.equal(result.status, "pass");
    assert.equal(result.quality_gate_passed, true);
    assert.equal(result.issues.length, 0);
  });
});

describe("quality gate CLI integration", () => {
  it("exits 3 on pre-organize fixture citing navigation or disposition failure", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-pre-"));
    copyOrganizeFixture(vaultRoot);

    writeReview(vaultRoot, "organize-pending", {
      run_id: "organize-pending",
      recorded_at: VALID_TS,
      proposals: [
        {
          schema_version: "okf-vault-proposal/1.0.0",
          proposal_id: "dup-pending",
          type: "duplicate",
          affected_paths: ["notes/revenue-growth.md", "notes/market-strategy.md"],
          claim_ids: ["claim-001", "claim-002"],
          rationale: "Overlapping strategy claims.",
          confidence: "high",
          disposition: "pending",
        },
      ],
    });

    const outcome = dispatch(parseArgs(["validate", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);
    assert.equal(outcome.result?.status, "ok");
    if (outcome.result?.status === "ok") {
      const data = outcome.result.data as {
        status: string;
        issues: { code: string }[];
      };
      assert.equal(data.status, "fail");
      assert.ok(
        data.issues.some(
          (entry) =>
            entry.code === PENDING_PROPOSAL_DISPOSITION_CODE || entry.code === "ORPHAN_NOTE",
        ),
      );
    }
  });

  it("exits 0 on post-curation fixture with dispositions and review files", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-post-"));
    copyOrganizeFixture(vaultRoot);

    writeFileSync(
      join(vaultRoot, "notes/index.md"),
      [
        "# Notes",
        "",
        "- [Revenue Growth](notes/revenue-growth.md)",
        "- [Market Strategy](notes/market-strategy.md)",
        "- [Unrelated Astronomy](notes/unrelated-astronomy.md)",
      ].join("\n"),
      "utf8",
    );

    writeReview(vaultRoot, "organize-complete", {
      run_id: "organize-complete",
      recorded_at: VALID_TS,
      required_gold_reviews: [],
      proposals: [
        {
          schema_version: "okf-vault-proposal/1.0.0",
          proposal_id: "dup-resolved",
          type: "duplicate",
          affected_paths: ["notes/revenue-growth.md", "notes/market-strategy.md"],
          claim_ids: ["claim-001", "claim-002"],
          rationale: "Reviewed overlap.",
          confidence: "high",
          disposition: "resolved",
          curator_comment: "Keep both with cross-links.",
        },
      ],
    });

    const outcome = dispatch(parseArgs(["validate", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    if (outcome.result?.status === "ok") {
      const data = outcome.result.data as { quality_gate_passed: boolean };
      assert.equal(data.quality_gate_passed, true);
    }
  });

  it("invokes stub visualizer without modifying managed vault files", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-viz-"));
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
      },
      sources: [committedRecord("notes/a.md", "local:/a")],
    });

    writeFileSync(
      join(vaultRoot, ".okf-vault/visualizer.json"),
      `${JSON.stringify(
        {
          schema_version: VISUALIZER_SCHEMA_VERSION,
          command: [process.execPath, noopVisualizer],
          output_dir: ".okf-vault/tmp/visualizer-output",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const manifestBefore = readFileSync(join(vaultRoot, ".okf-vault/manifest.json"), "utf8");
    const result = invokeVisualizer(vaultRoot);
    assert.equal(result.exit_code, 0);
    assert.equal(readFileSync(join(vaultRoot, ".okf-vault/manifest.json"), "utf8"), manifestBefore);
  });

  it("exits 3 after induced validation failure until journal recovery succeeds", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-qg-recover-"));
    initializeVault(vaultRoot);
    writePassingVault(vaultRoot, {
      notes: {
        "notes/a.md": `${articleFrontmatter("Note A", "local:/a", VALID_SHA)}\n${articleNoteBody()}`,
      },
      sources: [committedRecord("notes/a.md", "local:/a")],
    });

    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-fail",
      source_key: "local:/a",
      phase: "commit",
      failed_at: VALID_TS,
      error_code: "VALIDATION_FAILED",
      error_message: "induced failure",
      snapshot: {
        manifest: readFileSync(join(vaultRoot, ".okf-vault/manifest.json"), "utf8"),
        log: readFileSync(join(vaultRoot, "log.md"), "utf8"),
        notes: {
          "notes/a.md": readFileSync(join(vaultRoot, "notes/a.md"), "utf8"),
        },
      },
      installed_paths: [],
    });

    const failed = dispatch(parseArgs(["validate", vaultRoot]));
    assert.equal(failed.exitCode, ExitCode.VALIDATION);

    const recovered = dispatch(parseArgs(["recover", vaultRoot]));
    assert.equal(recovered.exitCode, ExitCode.SUCCESS);

    writeReview(vaultRoot, "gate-ready", {
      run_id: "gate-ready",
      recorded_at: VALID_TS,
      required_gold_reviews: [],
      proposals: [],
    });

    const passed = dispatch(parseArgs(["validate", vaultRoot]));
    assert.equal(passed.exitCode, ExitCode.SUCCESS);
  });
});

describe("quality gate fixture vaults", () => {
  it("pre fixture fails validate CLI with exit 3", () => {
    const prePath = join(fixtureRoot, "pre");
    if (!existsSync(prePath)) {
      return;
    }
    const child = spawnSync(process.execPath, [join(root, "dist/main.js"), "validate", prePath], {
      encoding: "utf8",
    });
    assert.equal(child.status, ExitCode.VALIDATION);
  });

  it("post fixture passes validate CLI with exit 0", () => {
    const postPath = join(fixtureRoot, "post");
    if (!existsSync(postPath)) {
      return;
    }
    const child = spawnSync(process.execPath, [join(root, "dist/main.js"), "validate", postPath], {
      encoding: "utf8",
    });
    assert.equal(child.status, ExitCode.SUCCESS);
  });
});
