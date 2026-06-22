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
  "okf-vault",
  "references",
  "conversion-profiles",
);
const goldPanelDir = join(root, "test", "fixtures", "notes", "gold", "panel");
const goldVideoDir = join(root, "test", "fixtures", "notes", "gold", "video");
const panelEnvelopeDir = join(root, "test", "fixtures", "envelopes", "panel");
const videoEnvelopeDir = join(root, "test", "fixtures", "envelopes", "video");
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

function pairedEnvelopePath(notePath: string, kind: "panel" | "video"): string {
  const stem = basename(notePath, ".md");
  const envelopeDir = kind === "panel" ? panelEnvelopeDir : videoEnvelopeDir;
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
    for (const profileName of ["panel.md", "video.md"]) {
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

  it("requires the panel-specific evidence section named in the note contract", () => {
    const content = readFileSync(join(profilesDir, "panel.md"), "utf8");
    assert.match(content, /# Evidence/);
    assert.match(content, /panel-specific evidence section/i);
    assert.match(content, /Panel Transcript Note/);
  });

  it("describes fallback behavior when timestamps exist only at paragraph granularity", () => {
    const content = readFileSync(join(profilesDir, "video.md"), "utf8");
    assert.match(content, /paragraph/i);
    assert.match(content, /granularity|paragraph-level|paragraph boundaries/i);
    assert.match(content, /nearest preceding/i);
  });
});

describe("panel gold notes", () => {
  it("passes staged validation for accepted-01 with Granola-style speaker labels", () => {
    const notePath = join(goldPanelDir, "accepted-01.md");
    const envelopePath = pairedEnvelopePath(notePath, "panel");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-panel-01-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-panel-01", notePath, "notes/gold-panel-01.md");
    const envelope = loadSourceEnvelope(envelopePath);
    assert.equal(envelope.kind, "granola");
    assert.ok(
      envelope.anchors.some(
        (anchor) => anchor.speaker === "Speaker A" || anchor.speaker === "Speaker B",
      ),
    );
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
  });

  it("declares contract_version matching the manifest default", () => {
    for (const name of listGoldNotes(goldPanelDir, "accepted-")) {
      const content = readFileSync(join(goldPanelDir, name), "utf8");
      assert.match(content, new RegExp(`contract_version: ${NOTE_CONTRACT_VERSION}`));
    }
  });

  it("fails anchor resolution when attributing a quote to Speaker C with only A and B in envelope", () => {
    const notePath = join(goldPanelDir, "rejected-invented-speaker.md");
    const envelopePath = pairedEnvelopePath(join(goldPanelDir, "accepted-01.md"), "panel");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-panel-reject-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-reject", notePath, "notes/rejected-panel.md");
    const envelope = loadSourceEnvelope(envelopePath);
    const speakers = new Set(
      envelope.anchors
        .map((anchor) => anchor.speaker)
        .filter((value): value is string => typeof value === "string"),
    );
    assert.ok(speakers.has("Speaker A"));
    assert.ok(speakers.has("Speaker B"));
    assert.equal(speakers.has("Speaker C"), false);

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const anchorIssue = result.report.issues.find(
      (entry) => entry.code === "ANCHOR_RESOLUTION_FAILED",
    );
    assert.ok(anchorIssue);
    assert.match(anchorIssue.message, /speaker-Speaker-C/);
  });
});

describe("video gold notes", () => {
  it("passes when each Key Claims entry cites a timestamp anchor present in the envelope", () => {
    const notePath = join(goldVideoDir, "accepted-01.md");
    const envelopePath = pairedEnvelopePath(notePath, "video");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-video-01-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-video-01", notePath, "notes/gold-video-01.md");
    const envelope = loadSourceEnvelope(envelopePath);
    const timestampIds = envelope.anchors
      .filter((anchor) => anchor.kind === "timestamp")
      .map((anchor) => anchor.id);
    assert.ok(timestampIds.includes("timestamp-00:03:45"));
    assert.ok(timestampIds.includes("timestamp-00:07:20"));

    const noteContent = readFileSync(notePath, "utf8");
    const keyClaimsSection = noteContent.split("# Citations")[0] ?? noteContent;
    assert.match(keyClaimsSection, /claim-001/);
    assert.match(keyClaimsSection, /claim-002/);

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
  });

  it("declares contract_version matching the manifest default", () => {
    for (const name of listGoldNotes(goldVideoDir, "accepted-")) {
      const content = readFileSync(join(goldVideoDir, name), "utf8");
      assert.match(content, new RegExp(`contract_version: ${NOTE_CONTRACT_VERSION}`));
    }
  });

  it("fails timestamp resolution when claim anchors to 00:15:00 but envelope ends at 00:12:30", () => {
    const notePath = join(goldVideoDir, "rejected-out-of-range-timestamp.md");
    const envelopePath = pairedEnvelopePath(join(goldVideoDir, "accepted-01.md"), "video");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-video-reject-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-reject", notePath, "notes/rejected-video.md");
    const envelope = loadSourceEnvelope(envelopePath);
    const latestTimestamp = envelope.anchors
      .filter((anchor) => anchor.kind === "timestamp")
      .map((anchor) => anchor.timestamp)
      .sort()
      .at(-1);
    assert.equal(latestTimestamp, "00:12:30");

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const anchorIssue = result.report.issues.find(
      (entry) => entry.code === "ANCHOR_RESOLUTION_FAILED",
    );
    assert.ok(anchorIssue);
    assert.match(anchorIssue.message, /timestamp-00:15:00/);
  });
});

describe("profile validation harness integration", () => {
  it("runs staged validation CLI against all accepted panel and video gold notes with exit 0", () => {
    assert.ok(existsSync(bin), "helper must be built before profile integration tests");

    const pairs: Array<{ notePath: string; envelopePath: string; kind: "panel" | "video" }> = [
      ...listGoldNotes(goldPanelDir, "accepted-").map((name) => ({
        notePath: join(goldPanelDir, name),
        envelopePath: pairedEnvelopePath(join(goldPanelDir, name), "panel"),
        kind: "panel" as const,
      })),
      ...listGoldNotes(goldVideoDir, "accepted-").map((name) => ({
        notePath: join(goldVideoDir, name),
        envelopePath: pairedEnvelopePath(join(goldVideoDir, name), "video"),
        kind: "video" as const,
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

  it("exits 3 for panel and video counterexamples with at least one stable error each", () => {
    const counterexamples = [
      {
        notePath: join(goldPanelDir, "rejected-invented-speaker.md"),
        envelopePath: pairedEnvelopePath(join(goldPanelDir, "accepted-01.md"), "panel"),
      },
      {
        notePath: join(goldVideoDir, "rejected-out-of-range-timestamp.md"),
        envelopePath: pairedEnvelopePath(join(goldVideoDir, "accepted-01.md"), "video"),
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
      assert.ok(
        report.issues.some((entry) => entry.code === "ANCHOR_RESOLUTION_FAILED"),
        `${counter.notePath} must fail with ANCHOR_RESOLUTION_FAILED`,
      );
    }
  });

  it("validates local panel gold note without Drive or Granola credentials", () => {
    const notePath = join(goldPanelDir, "accepted-02.md");
    const envelopePath = pairedEnvelopePath(notePath, "panel");
    const envelope = loadSourceEnvelope(envelopePath);
    assert.equal(envelope.kind, "local");
    assert.match(envelope.source_key, /^local:/);

    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-profile-local-panel-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(vaultRoot, "run-local", notePath, "notes/local-panel.md");
    const { exitCode, report } = runValidateStagedCli(vaultRoot, stagingDir, envelopePath);
    assert.equal(exitCode, ExitCode.SUCCESS);
    assert.equal(report.status, "pass");
  });
});
