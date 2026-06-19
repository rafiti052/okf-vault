import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../../dist/cli.js";
import { initializeVault } from "../../dist/vault/manifest.js";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  loadSourceEnvelope,
  validateStagedNotes,
  type ValidationReport,
} from "../../dist/vault/validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const profilesDir = join(
  root,
  ".agents",
  "skills",
  "okf-knowledge-vault",
  "references",
  "conversion-profiles",
);
const goldArticleDir = join(root, "test", "fixtures", "notes", "gold", "article");
const goldDeckDir = join(root, "test", "fixtures", "notes", "gold", "deck");
const articleEnvelopeDir = join(root, "test", "fixtures", "envelopes", "article");
const deckEnvelopeDir = join(root, "test", "fixtures", "envelopes", "deck");
const bin = join(root, "dist", "main.js");

/** Corpus topic terms that profiles must not require as output vocabulary. */
const FORBIDDEN_PROFILE_TERMS = [
  "strategy memo",
  "market expansion",
  "three pillars",
  "leadership",
  "executive summary",
];

function listGoldNotes(dir: string, prefix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .sort();
}

function pairedEnvelopePath(notePath: string, kind: "article" | "deck"): string {
  const stem = basename(notePath, ".md");
  const envelopeDir = kind === "article" ? articleEnvelopeDir : deckEnvelopeDir;
  return join(envelopeDir, `${stem}.json`);
}

function stageGoldNote(vaultRoot: string, runId: string, notePath: string, stagedName: string) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(stagedName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(notePath, join(stagingDir, stagedName));
  return stagingDir;
}

function runValidateStagedCli(
  vaultRoot: string,
  stagingDir: string,
  envelopePath: string,
): { exitCode: number; report: ValidationReport } {
  const result = spawnSync(
    process.execPath,
    [bin, "validate-staged", vaultRoot, stagingDir, envelopePath],
    { encoding: "utf8" },
  );
  const payload = JSON.parse(result.stdout.trim()) as {
    status: string;
    data: ValidationReport;
  };
  return { exitCode: result.status ?? ExitCode.UNEXPECTED, report: payload.data };
}

describe("conversion profile documents", () => {
  it("remain topic-agnostic without required corpus domain vocabulary", () => {
    for (const profileName of ["article.md", "deck.md"]) {
      const content = readFileSync(join(profilesDir, profileName), "utf8").toLowerCase();
      for (const term of FORBIDDEN_PROFILE_TERMS) {
        assert.equal(
          content.includes(term),
          false,
          `${profileName} must not hard-code required domain term '${term}'`,
        );
      }
    }
  });
});

describe("article gold notes", () => {
  it("passes staged validation for accepted-01 with its paired envelope", () => {
    const notePath = join(goldArticleDir, "accepted-01.md");
    const envelopePath = pairedEnvelopePath(notePath, "article");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-article-01-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-01", notePath, "notes/gold-article-01.md");
    const envelope = loadSourceEnvelope(envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
  });

  it("declares contract_version matching the manifest default", () => {
    for (const name of listGoldNotes(goldArticleDir, "accepted-")) {
      const content = readFileSync(join(goldArticleDir, name), "utf8");
      assert.match(content, new RegExp(`contract_version: ${NOTE_CONTRACT_VERSION}`));
    }
  });

  it("fails anchor resolution for rejected invented claim counterexample", () => {
    const notePath = join(goldArticleDir, "rejected-invented-claim.md");
    const envelopePath = pairedEnvelopePath(join(goldArticleDir, "accepted-01.md"), "article");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-article-reject-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(
      vaultRoot,
      "run-reject",
      notePath,
      "notes/rejected-article.md",
    );
    const envelope = loadSourceEnvelope(envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const anchorIssue = result.report.issues.find(
      (entry) => entry.code === "ANCHOR_RESOLUTION_FAILED",
    );
    assert.ok(anchorIssue);
    assert.match(anchorIssue.message, /claim-002/);
  });
});

describe("deck gold notes", () => {
  it("passes deck coverage validation for accepted-01 five-slide envelope with slide 4 speaker notes", () => {
    const notePath = join(goldDeckDir, "accepted-01.md");
    const envelopePath = pairedEnvelopePath(notePath, "deck");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-deck-01-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-deck-01", notePath, "notes/gold-deck-01.md");
    const envelope = loadSourceEnvelope(envelopePath);
    assert.equal(envelope.slides?.length, 5);
    assert.ok(
      envelope.slides?.some((slide) => slide.number === 4 && slide.speaker_notes.trim().length > 0),
    );
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
  });

  it("preserves numeric tokens 42% and $1.2M from envelope anchors in Key Claims or Narrative", () => {
    const noteContent = readFileSync(join(goldDeckDir, "accepted-01.md"), "utf8");
    const envelope = loadSourceEnvelope(join(deckEnvelopeDir, "accepted-01.json"));
    const slideThree = envelope.anchors.find((anchor) => anchor.id === "slide-003");
    assert.ok(slideThree?.text?.includes("42%"));
    assert.ok(slideThree?.text?.includes("$1.2M"));

    const claimsOrNarrative = noteContent.split("# Citations")[0] ?? noteContent;
    assert.match(claimsOrNarrative, /42%/);
    assert.match(claimsOrNarrative, /\$1\.2M/);
  });

  it("declares contract_version matching the manifest default", () => {
    for (const name of listGoldNotes(goldDeckDir, "accepted-")) {
      const content = readFileSync(join(goldDeckDir, name), "utf8");
      assert.match(content, new RegExp(`contract_version: ${NOTE_CONTRACT_VERSION}`));
    }
  });

  it("fails with DECK_COVERAGE_INCOMPLETE when slide 3 is missing from coverage", () => {
    const notePath = join(goldDeckDir, "rejected-missing-slide-coverage.md");
    const envelopePath = pairedEnvelopePath(join(goldDeckDir, "accepted-01.md"), "deck");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-deck-reject-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-reject", notePath, "notes/rejected-deck.md");
    const envelope = loadSourceEnvelope(envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const coverageIssue = result.report.issues.find(
      (entry) => entry.code === "DECK_COVERAGE_INCOMPLETE",
    );
    assert.ok(coverageIssue);
    assert.match(coverageIssue.message, /3/);
  });
});

describe("profile validation harness integration", () => {
  it("runs staged validation CLI against all accepted gold notes collectively with exit 0", () => {
    assert.ok(existsSync(bin), "helper must be built before profile integration tests");

    const pairs: Array<{ notePath: string; envelopePath: string; kind: "article" | "deck" }> = [
      ...listGoldNotes(goldArticleDir, "accepted-").map((name) => ({
        notePath: join(goldArticleDir, name),
        envelopePath: pairedEnvelopePath(join(goldArticleDir, name), "article"),
        kind: "article" as const,
      })),
      ...listGoldNotes(goldDeckDir, "accepted-").map((name) => ({
        notePath: join(goldDeckDir, name),
        envelopePath: pairedEnvelopePath(join(goldDeckDir, name), "deck"),
        kind: "deck" as const,
      })),
    ];

    assert.ok(pairs.length >= 4, "expected at least two accepted notes per profile");

    for (const pair of pairs) {
      const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-harness-pass-"));
      initializeVault(vaultRoot);
      const stagingDir = stageGoldNote(
        vaultRoot,
        `run-${basename(pair.notePath, ".md")}`,
        pair.notePath,
        `notes/${basename(pair.notePath)}`,
      );
      const { exitCode, report } = runValidateStagedCli(vaultRoot, stagingDir, pair.envelopePath);
      assert.equal(exitCode, ExitCode.SUCCESS, `${pair.notePath} should pass CLI validation`);
      assert.equal(report.status, "pass");
    }
  });

  it("exits 3 for counterexamples with at least one error per file", () => {
    const counterexamples = [
      {
        notePath: join(goldArticleDir, "rejected-invented-claim.md"),
        envelopePath: pairedEnvelopePath(join(goldArticleDir, "accepted-01.md"), "article"),
      },
      {
        notePath: join(goldDeckDir, "rejected-missing-slide-coverage.md"),
        envelopePath: pairedEnvelopePath(join(goldDeckDir, "accepted-01.md"), "deck"),
      },
    ];

    for (const counter of counterexamples) {
      const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-harness-fail-"));
      initializeVault(vaultRoot);
      const stagingDir = stageGoldNote(
        vaultRoot,
        "run-fail",
        counter.notePath,
        `notes/${basename(counter.notePath)}`,
      );
      const { exitCode, report } = runValidateStagedCli(
        vaultRoot,
        stagingDir,
        counter.envelopePath,
      );
      assert.equal(exitCode, ExitCode.VALIDATION, `${counter.notePath} should fail CLI validation`);
      assert.equal(report.status, "fail");
      assert.ok(report.issues.length >= 1, `${counter.notePath} must report at least one issue`);
    }
  });
});
