/**
 * YouTube MVP fixture corpus — loadability, pairing conventions, and cross-suite reuse.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initializeVault } from "../../dist/vault/manifest.js";
import {
  loadSourceEnvelope,
  validateSourceEnvelope,
  validateStagedNotes,
} from "../../dist/vault/validation.js";
import { selectConversionProfile } from "../../dist/vault/ingestion.js";
import {
  assertYoutubeFixturesPresent,
  pairedYoutubeEnvelopePath,
  youtubeAccepted,
  youtubeAmbiguous,
  youtubeRejected,
} from "../../dist-test/fixtures/youtube-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stageGoldNote(vaultRoot, runId, notePath, stagedName) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(stagedName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(notePath, join(stagingDir, stagedName));
  return stagingDir;
}

describe("YouTube fixture corpus", () => {
  it("loads accepted, rejected, and ambiguous envelope fixtures from disk", () => {
    assertYoutubeFixturesPresent();

    const accepted = loadSourceEnvelope(youtubeAccepted.envelopePath);
    assert.equal(accepted.kind, "youtube");
    assert.ok(accepted.anchors.some((anchor) => anchor.kind === "timestamp"));

    const rejected = loadSourceEnvelope(youtubeRejected.envelopePath);
    assert.equal(rejected.kind, "youtube");
    assert.equal(rejected.anchors.length, 0);

    const ambiguous = loadSourceEnvelope(youtubeAmbiguous.envelopePath);
    assert.equal(ambiguous.kind, "youtube");
    assert.ok(ambiguous.anchors.some((anchor) => anchor.kind === "speaker"));
  });

  it("pairs gold notes with profile-scoped envelope paths using stem naming", () => {
    assert.equal(
      pairedYoutubeEnvelopePath(youtubeAccepted.notePath, "video"),
      youtubeAccepted.envelopePath,
    );
    assert.equal(
      pairedYoutubeEnvelopePath(youtubeAmbiguous.notePath, "panel"),
      youtubeAmbiguous.envelopePath,
    );
    assert.ok(existsSync(youtubeAccepted.envelopePath));
    assert.ok(existsSync(youtubeAmbiguous.envelopePath));
  });

  it("accepts the MVP YouTube video transcript pair through validation", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-youtube-fixture-pass-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(
      vaultRoot,
      "run-youtube-accepted",
      youtubeAccepted.notePath,
      youtubeAccepted.stagedNotePath,
    );
    const envelope = loadSourceEnvelope(youtubeAccepted.envelopePath);
    const envelopeIssues = validateSourceEnvelope(envelope);
    assert.equal(envelopeIssues.length, 0);

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
  });

  it("rejects transcript-insufficient YouTube envelope with INCOMPLETE_TRANSCRIPT_TIMESTAMPS", () => {
    const envelope = loadSourceEnvelope(youtubeRejected.envelopePath);
    const issues = validateSourceEnvelope(envelope);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "INCOMPLETE_TRANSCRIPT_TIMESTAMPS");
  });

  it("supports explicit panel routing for ambiguous YouTube transcript fixtures", () => {
    assert.equal(selectConversionProfile("text/vtt", { kind: "youtube" }), "video");
    assert.equal(
      selectConversionProfile("text/vtt", { kind: "youtube", confirmedProfile: "panel" }),
      "panel",
    );

    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-youtube-fixture-panel-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(
      vaultRoot,
      "run-youtube-ambiguous",
      youtubeAmbiguous.notePath,
      youtubeAmbiguous.stagedNotePath,
    );
    const envelope = loadSourceEnvelope(youtubeAmbiguous.envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
    assert.match(basename(youtubeAmbiguous.notePath), /^youtube-ambiguous-\d+\.md$/);
  });
});
