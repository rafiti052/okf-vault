import { readFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_NAMES,
  MANDATORY_EVENT_FIELDS,
  NORMALIZATION_ERROR_CODES,
  PREFLIGHT_ERROR_CODES,
  PROVIDER_TOOL_PATTERN,
  REQUIRED_PROGRESS_EVENTS,
  capabilityRequirements,
  documentsAllExitClasses,
  documentsIngestionFailureActions,
  listSkillMarkdownFiles,
  loadEnvelopeFixture,
  runPreflight,
  simulateSingleSourceHappyPath,
  skillRoot,
  validateDeckCompleteness,
  validateEnvelopeShape,
  validateGranolaSpeakers,
  verifyHappyPathOrdering,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const fixturesDir = join(root, "test", "fixtures", "envelopes");
const refsDir = join(skillRoot(root), "references");
const skillDir = skillRoot(root);

after(() => {
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".preflight-missing-")) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
});

describe("provider-neutral skill artifacts", () => {
  it("SKILL.md and capability references contain zero vendor MCP tool name patterns", () => {
    for (const file of listSkillMarkdownFiles(skillDir)) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, PROVIDER_TOOL_PATTERN, `${file} must stay provider-neutral`);
    }
    const capabilities = readFileSync(join(refsDir, "capabilities.md"), "utf8");
    assert.doesNotMatch(capabilities, PROVIDER_TOOL_PATTERN);
    for (const name of CAPABILITY_NAMES) {
      assert.match(capabilities, new RegExp(name));
    }
  });

  it("documents five user-facing modes in SKILL.md", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    for (const mode of ["initialize", "ingest", "organize", "validate", "visualize"]) {
      assert.match(skill, new RegExp(`\`${mode}\``));
    }
  });
});

describe("progress event contract", () => {
  it("lists every required progress-event name with mandatory fields", () => {
    const text = readFileSync(join(refsDir, "progress-events.md"), "utf8");
    for (const eventName of REQUIRED_PROGRESS_EVENTS) {
      assert.match(text, new RegExp(`\`${eventName}\``), `missing event ${eventName}`);
    }
    for (const field of MANDATORY_EVENT_FIELDS) {
      assert.match(text, new RegExp(`\`${field}\``), `missing field ${field}`);
    }
    assert.match(text, /run_id|run ID/i);
    assert.match(text, /source_key|source key/i);
    assert.match(text, /duration/i);
    assert.match(text, /error_code|error code/i);
    assert.match(text, /commit_id|commit ID/i);
  });
});

describe("helper invocation contract", () => {
  it("lists exit classes 0–5 with curator actions for ingestion failures", () => {
    const text = readFileSync(join(refsDir, "helper-invocation.md"), "utf8");
    assert.equal(documentsAllExitClasses(text), true);
    assert.equal(documentsIngestionFailureActions(text), true);
    assert.match(text, /stdout/i);
    assert.match(text, /stderr/i);
    assert.doesNotMatch(text, PROVIDER_TOOL_PATTERN);
  });
});

describe("envelope normalization harness", () => {
  it("validates a redacted Drive fixture against the source-envelope contract", () => {
    const envelope = loadEnvelopeFixture(join(fixturesDir, "google-drive-article.json"));
    const shape = validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);
    const deck = validateDeckCompleteness(envelope);
    assert.equal(deck.ok, true);
  });

  it("fails deck normalization pre-check with INCOMPLETE_DECK_SLIDE_GAP when slide 2 is missing", () => {
    const envelope = loadEnvelopeFixture(join(fixturesDir, "deck-incomplete-slide-gap.json"));
    const shape = validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);
    const deck = validateDeckCompleteness(envelope);
    assert.equal(deck.ok, false);
    if (!deck.ok) {
      assert.equal(deck.code, NORMALIZATION_ERROR_CODES.incompleteDeckSlideGap);
      assert.match(deck.message, /slide 2/i);
    }
  });

  it("rejects Granola fixture missing speaker markers when profile requires them", () => {
    const envelope = loadEnvelopeFixture(join(fixturesDir, "granola-missing-speakers.json"));
    const shape = validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);
    const speakers = validateGranolaSpeakers(envelope, { requireSpeakerMarkers: true });
    assert.equal(speakers.ok, false);
    if (!speakers.ok) {
      assert.equal(speakers.code, NORMALIZATION_ERROR_CODES.incompleteTranscriptSpeakers);
    }
  });
});

describe("preflight contract", () => {
  it("fails when Git, initialized vault, or compiled helper prerequisites are absent", () => {
    const vaultRoot = mkdtempSync(join(root, ".preflight-missing-"));
    const helperPath = join(root, "dist", "main.js");

    const noVault = runPreflight({
      vaultRoot,
      gitAvailable: true,
      helperPath,
      capabilities: ["invoke_process"],
      sources: [],
    });
    assert.equal(noVault.ok, false);
    if (!noVault.ok) {
      assert.equal(noVault.code, PREFLIGHT_ERROR_CODES.vaultNotInitialized);
    }

    const noGit = runPreflight({
      vaultRoot: join(root, "test", "fixtures", "vaults", "navigation", "pass"),
      gitAvailable: false,
      helperPath,
      capabilities: ["invoke_process"],
      sources: [],
    });
    assert.equal(noGit.ok, false);
    if (!noGit.ok) {
      assert.equal(noGit.code, PREFLIGHT_ERROR_CODES.gitUnavailable);
    }

    const noHelper = runPreflight({
      vaultRoot: join(root, "test", "fixtures", "vaults", "navigation", "pass"),
      gitAvailable: true,
      helperPath: join(root, "dist", "missing-helper.js"),
      capabilities: ["invoke_process"],
      sources: [],
    });
    assert.equal(noHelper.ok, false);
    if (!noHelper.ok) {
      assert.equal(noHelper.code, PREFLIGHT_ERROR_CODES.helperMissing);
    }
  });

  it("reports preflight_passed for synthetic initialized vault when capabilities and helper are present", () => {
    const vaultRoot = join(root, "test", "fixtures", "vaults", "navigation", "pass");
    const helperPath = join(root, "dist", "main.js");
    assert.equal(existsSync(helperPath), true, "run npm run build before workflow tests");

    const result = runPreflight({
      vaultRoot,
      gitAvailable: true,
      helperPath,
      capabilities: ["fetch_drive_document", "invoke_process"],
      sources: [
        {
          kind: "google_drive",
          locator: "drive:file-redacted-001",
          content_type: "application/vnd.google-apps.document",
        },
      ],
      runId: "integration-preflight-001",
    });

    assert.equal(result.ok, true);
    if (result.ok && result.event) {
      assert.equal(result.event.event, "preflight_passed");
      assert.equal(result.event.run_id, "integration-preflight-001");
    }
  });

  it("maps source kinds to capability requirements without provider tool names", () => {
    assert.deepEqual(capabilityRequirements("local"), ["read_local_file", "invoke_process"]);
    assert.deepEqual(capabilityRequirements("google_drive"), [
      "fetch_drive_document",
      "invoke_process",
    ]);
    assert.deepEqual(capabilityRequirements("granola"), [
      "fetch_granola_transcript",
      "invoke_process",
    ]);
  });
});

describe("workflow progress integration", () => {
  it("verifies progress-event ordering for a simulated single-source happy path", () => {
    const events = simulateSingleSourceHappyPath("run-happy-001", "drive:file-redacted-001");
    assert.equal(verifyHappyPathOrdering(events), true);
    for (const entry of events) {
      for (const field of ["event", "run_id", "phase", "status", "duration_ms"]) {
        assert.ok(entry[field] !== undefined, `missing ${field} on ${entry.event}`);
      }
    }
  });
});
