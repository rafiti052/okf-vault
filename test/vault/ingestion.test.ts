import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli.js";
import { LOG_PATH, MANIFEST_RELATIVE_PATH } from "../../dist/vault/constants.js";
import { initializeVault, loadManifest, manifestRevision } from "../../dist/vault/manifest.js";
import { runGit } from "../../dist/vault/git.js";
import {
  commitIngestFixture,
  HAPPY_PATH_PROGRESS_EVENTS,
  IngestInputError,
  parseIngestRunInput,
  recordSkippedSource,
  resolveManifestPreflight,
  selectConversionProfile,
  stageIngestFixture,
  envelopeHasSlides,
} from "../../dist/vault/ingestion.js";
import { commitStagedSource, recoverVault } from "../../dist/vault/transaction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const fixturesDir = join(root, "test", "fixtures");
const goldDir = join(fixturesDir, "notes", "gold");
const envelopesDir = join(fixturesDir, "envelopes");
const notesDir = join(fixturesDir, "notes");
const bin = join(root, "dist", "main.js");

const ARTICLE_ENVELOPE = join(envelopesDir, "article", "accepted-01.json");
const ARTICLE_NOTE = join(goldDir, "article", "accepted-01.md");
const ARTICLE_STAGED = "notes/gold-article-01.md";

const DECK_ENVELOPE = join(envelopesDir, "deck", "accepted-01.json");
const DECK_NOTE = join(goldDir, "deck", "accepted-01.md");
const DECK_STAGED = "notes/gold-deck-01.md";

const PANEL_ENVELOPE = join(envelopesDir, "panel", "accepted-01.json");
const PANEL_NOTE = join(goldDir, "panel", "accepted-01.md");
const PANEL_STAGED = "notes/gold-panel-01.md";

const VIDEO_ENVELOPE = join(envelopesDir, "video", "accepted-01.json");
const VIDEO_NOTE = join(goldDir, "video", "accepted-01.md");
const VIDEO_STAGED = "notes/gold-video-01.md";

function prepareVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), "okf-ingest-"));
  initializeVault(vaultRoot);
  return vaultRoot;
}

function countCommitsSince(vaultRoot: string, baseHead: string): number {
  return Number.parseInt(
    runGit(vaultRoot, ["rev-list", "--count", `${baseHead}..HEAD`]).stdout.trim(),
    10,
  );
}

describe("ingestion loop documentation", () => {
  it("lists happy-path progress events in required order", () => {
    const doc = readFileSync(
      join(root, ".agents", "skills", "okf-vault", "references", "ingestion-loop.md"),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("## Progress events — happy path order"));
    const indices = HAPPY_PATH_PROGRESS_EVENTS.map((name) => section.indexOf(`\`${name}\``));
    for (let index = 1; index < indices.length; index += 1) {
      assert.ok(indices[index]! > indices[index - 1]!, `event order broken at ${index}`);
    }
    assert.deepEqual(
      [...HAPPY_PATH_PROGRESS_EVENTS],
      [
        "run_started",
        "preflight_passed",
        "source_acquired",
        "conversion_started",
        "source_committed",
        "run_completed",
      ],
    );
  });
});

describe("ingest input parser", () => {
  it("rejects empty source lists and duplicate stable source keys", () => {
    assert.throws(
      () =>
        parseIngestRunInput({
          vault_root: "/tmp/vault",
          run_id: "run-empty",
          sources: [],
        }),
      (error: unknown) => error instanceof IngestInputError && error.code === "EMPTY_SOURCE_LIST",
    );

    assert.throws(
      () =>
        parseIngestRunInput({
          vault_root: "/tmp/vault",
          run_id: "run-dup",
          sources: [
            { kind: "local", locator: "/tmp/a.md", content_type: "text/markdown" },
            { kind: "local", locator: "/tmp/a.md", content_type: "text/plain" },
          ],
        }),
      (error: unknown) =>
        error instanceof IngestInputError && error.code === "DUPLICATE_SOURCE_KEY",
    );
  });
});

describe("manifest preflight wiring", () => {
  it("maps already-processed to source_already_processed without commit", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    commitIngestFixture({
      vaultRoot,
      runId: "run-first",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });

    const manifest = loadManifest(vaultRoot);
    const preflight = resolveManifestPreflight(
      manifest,
      "local",
      "/tmp/sources/sample-article.md",
      "a".repeat(64),
      "run-second",
    );

    assert.equal(preflight.outcome, "already_processed");
    assert.equal(preflight.stop_before_conversion, true);
    assert.equal(preflight.progress_event.event, "source_already_processed");
    assert.equal(preflight.progress_event.commit_id, undefined);
  });

  it("stops before conversion on changed content without altering note path", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    const result = commitIngestFixture({
      vaultRoot,
      runId: "run-commit",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });

    const manifest = loadManifest(vaultRoot);
    const preflight = resolveManifestPreflight(
      manifest,
      "local",
      "/tmp/sources/sample-article.md",
      "b".repeat(64),
      "run-changed",
    );

    assert.equal(preflight.outcome, "changed_conflict");
    assert.equal(preflight.stop_before_conversion, true);
    assert.equal(preflight.existing_note_path, result.note_path);
    assert.equal(preflight.progress_event.event, "run_failed");
    assert.equal(existsSync(join(vaultRoot, result.note_path)), true);
    assert.equal(
      readFileSync(join(vaultRoot, result.note_path), "utf8"),
      readFileSync(ARTICLE_NOTE, "utf8"),
    );
  });
});

describe("skip-with-reason", () => {
  it("records skipped manifest entry and emits progress without commit id", () => {
    const vaultRoot = prepareVault();
    const skipped = recordSkippedSource({
      vaultRoot,
      kind: "local",
      origin: "/tmp/sources/skipped.md",
      contentSha256: "c".repeat(64),
      reason: "Curator skipped after validation failure",
      runId: "run-skip",
      errorCode: "STAGED_VALIDATION_FAILED",
    });

    const record = loadManifest(vaultRoot).sources[0];
    assert.equal(record?.status, "skipped");
    assert.equal(record?.skip_reason, "Curator skipped after validation failure");
    assert.equal(skipped.progress_event.event, "validation_failed");
    assert.equal(skipped.progress_event.status, "skipped");
    assert.equal(skipped.progress_event.commit_id, undefined);
  });
});

describe("profile selection", () => {
  it("maps content types to article, deck, panel, and video profiles", () => {
    assert.equal(selectConversionProfile("text/markdown"), "article");
    assert.equal(
      selectConversionProfile("application/vnd.google-apps.presentation", { hasSlides: true }),
      "deck",
    );
    assert.equal(selectConversionProfile("text/plain", { kind: "granola" }), "panel");
    assert.equal(selectConversionProfile("video/transcript"), "video");
    assert.equal(envelopeHasSlides(DECK_ENVELOPE), true);
    assert.equal(envelopeHasSlides(ARTICLE_ENVELOPE), false);
  });
});

describe("article ingest integration", () => {
  it("commits one article fixture updating note, manifest, and log with exactly one git commit", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const result = commitIngestFixture({
      vaultRoot,
      runId: "run-article",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });

    const afterHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(afterHead, beforeHead);
    assert.equal(countCommitsSince(vaultRoot, beforeHead), 1);
    assert.equal(existsSync(join(vaultRoot, result.note_path)), true);
    assert.equal(existsSync(join(vaultRoot, MANIFEST_RELATIVE_PATH)), true);
    assert.match(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), /sample-article/);

    const changed = runGit(vaultRoot, ["show", "--name-only", "--pretty=format:", afterHead])
      .stdout.split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(changed, [LOG_PATH, MANIFEST_RELATIVE_PATH, result.note_path].sort());
  });
});

describe("sequential multi-type ingest integration", () => {
  it("commits deck, panel, and video fixtures three times with growing manifest records", () => {
    const vaultRoot = prepareVault();
    let revision = manifestRevision(loadManifest(vaultRoot));
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const fixtures = [
      {
        runId: "run-deck",
        envelopePath: DECK_ENVELOPE,
        goldNotePath: DECK_NOTE,
        stagedNotePath: DECK_STAGED,
      },
      {
        runId: "run-panel",
        envelopePath: PANEL_ENVELOPE,
        goldNotePath: PANEL_NOTE,
        stagedNotePath: PANEL_STAGED,
      },
      {
        runId: "run-video",
        envelopePath: VIDEO_ENVELOPE,
        goldNotePath: VIDEO_NOTE,
        stagedNotePath: VIDEO_STAGED,
      },
    ];

    for (const [index, fixture] of fixtures.entries()) {
      commitIngestFixture({
        vaultRoot,
        ...fixture,
        expectedRevision: revision,
      });
      revision = manifestRevision(loadManifest(vaultRoot));
      assert.equal(loadManifest(vaultRoot).sources.length, index + 1);
    }

    assert.equal(countCommitsSince(vaultRoot, beforeHead), 3);
    assert.equal(loadManifest(vaultRoot).sources.length, 3);
  });
});

describe("duplicate ingest detection", () => {
  it("re-ingesting same path and hash emits already-processed behavior with zero new commits", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    commitIngestFixture({
      vaultRoot,
      runId: "run-once",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });

    const inspectOutcome = dispatch(
      parseArgs(["inspect", vaultRoot, "local", "/tmp/sources/sample-article.md", "a".repeat(64)]),
    );
    assert.equal(inspectOutcome.exitCode, ExitCode.SUCCESS);
    if (inspectOutcome.result?.status === "ok") {
      assert.equal(inspectOutcome.result.data.outcome, "already_processed");
    }

    const preflight = resolveManifestPreflight(
      loadManifest(vaultRoot),
      "local",
      "/tmp/sources/sample-article.md",
      "a".repeat(64),
      "run-dup",
    );
    assert.equal(preflight.progress_event.event, "source_already_processed");
    assert.equal(countCommitsSince(vaultRoot, beforeHead), 1);
  });
});

describe("changed-source conflict integration", () => {
  it("aborts before note overwrite and leaves prior commit unchanged", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));

    const first = commitIngestFixture({
      vaultRoot,
      runId: "run-original",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });
    const headAfterFirst = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const changedEnvelopePath = join(vaultRoot, ".okf-vault", "tmp", "changed-envelope.json");
    mkdirSync(dirname(changedEnvelopePath), { recursive: true });
    const changedEnvelope = JSON.parse(readFileSync(ARTICLE_ENVELOPE, "utf8")) as Record<
      string,
      unknown
    >;
    changedEnvelope.content_sha256 = "b".repeat(64);
    writeFileSync(changedEnvelopePath, `${JSON.stringify(changedEnvelope, null, 2)}\n`, "utf8");

    stageIngestFixture({
      vaultRoot,
      runId: "run-changed",
      envelopePath: changedEnvelopePath,
      goldNotePath: join(notesDir, "article-valid.md"),
      stagedNotePath: "notes/changed-article.md",
      expectedRevision: manifestRevision(loadManifest(vaultRoot)),
    });

    const outcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-changed",
        changedEnvelopePath,
        manifestRevision(loadManifest(vaultRoot)),
      ]),
    );
    assert.equal(outcome.exitCode, ExitCode.CONFLICT);
    assert.equal(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), headAfterFirst);
    assert.equal(existsSync(join(vaultRoot, first.note_path)), true);
    assert.equal(loadManifest(vaultRoot).sources[0]?.note_path, first.note_path);
    assert.equal(loadManifest(vaultRoot).sources.length, 1);
  });
});

describe("validation failure before commit", () => {
  it("exits before commit, recovers, and preserves pre-run HEAD tree for managed paths", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const beforeManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const beforeLog = readFileSync(join(vaultRoot, LOG_PATH), "utf8");

    const stagingDir = join(vaultRoot, ".okf-vault", "tmp", "run-invalid");
    mkdirSync(join(stagingDir, "notes"), { recursive: true });
    copyFileSync(
      join(goldDir, "article", "rejected-invented-claim.md"),
      join(stagingDir, "notes/invalid-article.md"),
    );

    const outcome = dispatch(
      parseArgs(["commit", vaultRoot, "run-invalid", ARTICLE_ENVELOPE, revision]),
    );
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);

    recoverVault(vaultRoot);

    assert.equal(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), beforeHead);
    assert.equal(readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"), beforeManifest);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), beforeLog);
    assert.equal(existsSync(join(vaultRoot, "notes/invalid-article.md")), false);
    assert.equal(loadManifest(vaultRoot).sources.length, 0);
  });

  it("rolls back via commitStagedSource when validation fails on rejected deck note", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageIngestFixture({
      vaultRoot,
      runId: "run-bad-deck",
      envelopePath: DECK_ENVELOPE,
      goldNotePath: join(goldDir, "deck", "rejected-missing-slide-coverage.md"),
      stagedNotePath: "notes/bad-deck.md",
      expectedRevision: revision,
    });

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-bad-deck",
          envelopePath: DECK_ENVELOPE,
          expectedRevision: revision,
        }),
      /STAGED_VALIDATION_FAILED|validation/i,
    );
    assert.equal(loadManifest(vaultRoot).sources.length, 0);
  });
});

describe("ingest CLI harness", () => {
  it("runs inspect and commit through compiled helper for gold article fixture", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageIngestFixture({
      vaultRoot,
      runId: "run-cli",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
      expectedRevision: revision,
    });

    const inspect = spawnSync(
      process.execPath,
      [bin, "inspect", vaultRoot, "local", "/tmp/sources/sample-article.md", "a".repeat(64)],
      { encoding: "utf8" },
    );
    assert.equal(inspect.status, ExitCode.SUCCESS);
    assert.match(inspect.stdout, /"outcome":"new"/);

    const commit = spawnSync(
      process.execPath,
      [bin, "commit", vaultRoot, "run-cli", ARTICLE_ENVELOPE, revision],
      { encoding: "utf8" },
    );
    assert.equal(commit.status, ExitCode.SUCCESS);
    assert.match(commit.stdout, /"status":"ok"/);
    assert.equal(loadManifest(vaultRoot).sources.length, 1);
  });
});
