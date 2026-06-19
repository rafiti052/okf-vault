import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_ENVELOPE_VERSION = "okf-source-envelope/1.0.0";
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const CREDENTIAL_FIELD_PATTERN = /(?:^|_)(token|api_key|password|secret|credential)(?:$|_)/i;
export const PROVIDER_TOOL_PATTERN = /mcp_|claude_|codex_/i;

export const REQUIRED_PROGRESS_EVENTS = [
  "run_started",
  "preflight_passed",
  "source_acquired",
  "source_already_processed",
  "conversion_started",
  "validation_failed",
  "source_committed",
  "organize_proposals_ready",
  "quality_gate_passed",
  "run_failed",
  "run_completed",
];

export const MANDATORY_EVENT_FIELDS = [
  "event",
  "run_id",
  "phase",
  "status",
  "timestamp",
  "duration_ms",
];

export const REQUIRED_EXIT_CLASSES = ["0", "1", "2", "3", "4", "5"];

export const CAPABILITY_NAMES = [
  "read_local_file",
  "fetch_drive_document",
  "fetch_granola_transcript",
  "inspect_deck_slides",
  "invoke_process",
];

export const VAULT_COMMANDS = [
  "vault-ingest",
  "vault-init",
  "vault-organize",
  "vault-validate",
  "vault-visualize",
  "vault-bootstrap",
  "vault-ingest-check",
];

export const SKILL_MODES = ["initialize", "ingest", "organize", "validate", "visualize"];

export const PIPELINE_COMMANDS = ["vault-bootstrap", "vault-ingest-check"];

export const PIPELINE_NAMES = ["bootstrap", "ingest-check"];

export const PIPELINE_MODE_SEQUENCES = {
  bootstrap: ["initialize", "validate"],
  "ingest-check": ["ingest", "validate"],
};

export const PREFLIGHT_ERROR_CODES = {
  vaultNotInitialized: "PREFLIGHT_VAULT_NOT_INITIALIZED",
  gitUnavailable: "PREFLIGHT_GIT_UNAVAILABLE",
  helperMissing: "PREFLIGHT_HELPER_MISSING",
  capabilityMissing: "PREFLIGHT_CAPABILITY_MISSING",
  sourceMetadataIncomplete: "PREFLIGHT_SOURCE_METADATA_INCOMPLETE",
};

export const NORMALIZATION_ERROR_CODES = {
  incompleteDeckSlideGap: "INCOMPLETE_DECK_SLIDE_GAP",
  incompleteTranscriptSpeakers: "INCOMPLETE_TRANSCRIPT_SPEAKERS",
};

/**
 * @param {string} root
 * @returns {string}
 */
export function skillRoot(root) {
  return join(root, ".agents", "skills", "okf-knowledge-vault");
}

/**
 * @param {string} root
 * @returns {string}
 */
export function canonicalCommandsDir(root) {
  return join(skillRoot(root), "commands");
}

/**
 * @param {string} root
 * @returns {string}
 */
export function cursorCommandsDir(root) {
  return join(root, ".cursor", "skills", "okf-knowledge-vault", "commands");
}

/**
 * @param {string} root
 * @returns {string}
 */
export function claudeCommandsDir(root) {
  return join(root, ".claude", "skills", "okf-knowledge-vault", "commands");
}

export const MVP_COMMAND_STUBS = ["vault-ingest.md", "registry.md"];

/**
 * @param {string} path
 * @returns {boolean}
 */
export function pathIsSymlink(path) {
  return existsSync(path) && lstatSync(path).isSymbolicLink();
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function resolvesToSameRealpath(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }
  return realpathSync(left) === realpathSync(right);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function stripYamlFrontmatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasDisableModelInvocationFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return false;
  }
  return /disable-model-invocation:\s*true/.test(match[1]);
}

/**
 * True when a regular file copies the canonical stub body instead of symlinking or wrapping.
 * @param {string} adapterText
 * @param {string} canonicalText
 * @returns {boolean}
 */
export function isDuplicateStubBody(adapterText, canonicalText) {
  const adapterBody = stripYamlFrontmatter(adapterText).trim();
  const canonicalBody = stripYamlFrontmatter(canonicalText).trim();
  return adapterBody.length > 0 && adapterBody === canonicalBody;
}

/**
 * @param {string} adapterCommandsDir
 * @param {string} canonicalCommandsDirPath
 * @param {string} stubFileName
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function assertAdapterStubResolves(
  adapterCommandsDir,
  canonicalCommandsDirPath,
  stubFileName,
) {
  const adapterPath = join(adapterCommandsDir, stubFileName);
  const canonicalPath = join(canonicalCommandsDirPath, stubFileName);

  if (!existsSync(adapterPath)) {
    return { ok: false, message: `Missing adapter stub: ${adapterPath}` };
  }
  if (!existsSync(canonicalPath)) {
    return { ok: false, message: `Missing canonical stub: ${canonicalPath}` };
  }
  if (!resolvesToSameRealpath(adapterPath, canonicalPath)) {
    const adapterText = readFileSync(adapterPath, "utf8");
    const canonicalText = readFileSync(canonicalPath, "utf8");
    if (isDuplicateStubBody(adapterText, canonicalText)) {
      return {
        ok: false,
        message: `Adapter stub duplicates canonical body: ${adapterPath}`,
      };
    }
    return {
      ok: false,
      message: `Adapter stub does not resolve to canonical path: ${adapterPath}`,
    };
  }

  return { ok: true };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function listSkillMarkdownFiles(dir) {
  const files = ["SKILL.md", join("references", "capabilities.md")];
  return files.map((relative) => join(dir, relative));
}

/**
 * @param {unknown} envelope
 * @returns {{ ok: true } | { ok: false; code: string; message: string }}
 */
export function validateEnvelopeShape(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, code: "ENVELOPE_MISSING_FIELD", message: "Envelope must be an object." };
  }

  const record = /** @type {Record<string, unknown>} */ (envelope);

  if (record.contract_version !== SOURCE_ENVELOPE_VERSION) {
    return {
      ok: false,
      code: "ENVELOPE_UNSUPPORTED_VERSION",
      message: `Unsupported contract_version '${record.contract_version}'.`,
    };
  }

  for (const key of [
    "source_key",
    "kind",
    "content_type",
    "origin",
    "canonical_uri",
    "title",
    "modified_at",
    "content_sha256",
    "normalized_text",
    "anchors",
  ]) {
    if (record[key] === undefined || record[key] === "") {
      return { ok: false, code: "ENVELOPE_MISSING_FIELD", message: `Missing ${key}.` };
    }
  }

  if (!SHA256_PATTERN.test(String(record.content_sha256))) {
    return { ok: false, code: "ENVELOPE_INVALID_HASH", message: "Invalid content_sha256." };
  }

  if (!Array.isArray(record.anchors)) {
    return { ok: false, code: "ENVELOPE_MISSING_FIELD", message: "anchors must be an array." };
  }

  for (const key of Object.keys(record)) {
    if (CREDENTIAL_FIELD_PATTERN.test(key)) {
      return { ok: false, code: "ENVELOPE_CREDENTIAL_FIELD", message: `Credential field ${key}.` };
    }
  }

  const serialized = JSON.stringify(record);
  if (PROVIDER_TOOL_PATTERN.test(serialized)) {
    return {
      ok: false,
      code: "ENVELOPE_PROVIDER_LEAK",
      message: "Provider tool name in envelope.",
    };
  }

  return { ok: true };
}

/**
 * @param {Record<string, unknown>} envelope
 * @returns {{ ok: true } | { ok: false; code: string; message: string }}
 */
export function validateDeckCompleteness(envelope) {
  const contentType = String(envelope.content_type ?? "");
  const isDeck =
    contentType.includes("presentation") ||
    contentType.includes("deck") ||
    envelope.slides !== undefined;

  if (!isDeck) {
    return { ok: true };
  }

  const slides = envelope.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    return {
      ok: false,
      code: NORMALIZATION_ERROR_CODES.incompleteDeckSlideGap,
      message: "Deck envelope missing slides.",
    };
  }

  const numbers = slides
    .map((slide) => /** @type {{ number?: number }} */ (slide).number)
    .filter((value) => typeof value === "number")
    .sort((left, right) => left - right);

  for (let index = 0; index < numbers.length; index += 1) {
    const expected = index + 1;
    if (numbers[index] !== expected) {
      return {
        ok: false,
        code: NORMALIZATION_ERROR_CODES.incompleteDeckSlideGap,
        message: `Missing slide ${expected}; found ${numbers[index]}.`,
      };
    }
  }

  if (envelope.deck_complete === true) {
    for (const slide of slides) {
      const entry = /** @type {{ image_available?: boolean; text?: string }} */ (slide);
      if (!entry.image_available || !entry.text) {
        return {
          ok: false,
          code: "INCOMPLETE_DECK_CONTENT",
          message: "deck_complete true with incomplete slide content.",
        };
      }
    }
  }

  return { ok: true };
}

/**
 * @param {Record<string, unknown>} envelope
 * @param {{ requireSpeakerMarkers?: boolean }} [options]
 * @returns {{ ok: true } | { ok: false; code: string; message: string }}
 */
export function validateGranolaSpeakers(envelope, options = {}) {
  if (envelope.kind !== "granola") {
    return { ok: true };
  }

  if (!options.requireSpeakerMarkers) {
    return { ok: true };
  }

  const anchors = /** @type {Array<{ kind?: string; speaker?: string }>} */ (
    envelope.anchors ?? []
  );
  const hasSpeaker = anchors.some(
    (anchor) => anchor.kind === "speaker" || (anchor.speaker ?? "").length > 0,
  );

  if (!hasSpeaker) {
    return {
      ok: false,
      code: NORMALIZATION_ERROR_CODES.incompleteTranscriptSpeakers,
      message: "Granola panel profile requires speaker markers.",
    };
  }

  return { ok: true };
}

/**
 * @param {Record<string, unknown>} context
 * @returns {{ ok: true; event?: Record<string, unknown> } | { ok: false; code: string; message: string }}
 */
export function runPreflight(context) {
  const {
    vaultRoot,
    gitAvailable,
    helperPath,
    capabilities = [],
    sources = [],
    runId = "preflight-test",
  } = context;

  if (!vaultRoot || !existsSync(join(String(vaultRoot), ".okf-vault", "manifest.json"))) {
    return {
      ok: false,
      code: PREFLIGHT_ERROR_CODES.vaultNotInitialized,
      message: "Vault manifest missing.",
    };
  }

  if (!gitAvailable) {
    return {
      ok: false,
      code: PREFLIGHT_ERROR_CODES.gitUnavailable,
      message: "Git unavailable.",
    };
  }

  if (!helperPath || !existsSync(String(helperPath))) {
    return {
      ok: false,
      code: PREFLIGHT_ERROR_CODES.helperMissing,
      message: "Helper binary missing.",
    };
  }

  for (const source of sources) {
    const entry = /** @type {{ kind?: string }} */ (source);
    const required = capabilityRequirements(entry.kind ?? "");
    const missing = required.filter((name) => !capabilities.includes(name));
    if (missing.length > 0) {
      return {
        ok: false,
        code: PREFLIGHT_ERROR_CODES.capabilityMissing,
        message: `Missing capabilities: ${missing.join(", ")}`,
      };
    }
  }

  for (const source of sources) {
    const entry = /** @type {{ kind?: string; locator?: string; content_type?: string }} */ (
      source
    );
    if (!entry.kind || !entry.locator || !entry.content_type) {
      return {
        ok: false,
        code: PREFLIGHT_ERROR_CODES.sourceMetadataIncomplete,
        message: "Curator source metadata incomplete.",
      };
    }
  }

  return {
    ok: true,
    event: {
      event: "preflight_passed",
      run_id: runId,
      phase: "preflight",
      status: "ok",
      timestamp: new Date().toISOString(),
      duration_ms: 0,
    },
  };
}

/**
 * @param {string} kind
 * @returns {string[]}
 */
export function capabilityRequirements(kind) {
  switch (kind) {
    case "local":
      return ["read_local_file", "invoke_process"];
    case "google_drive":
      return ["fetch_drive_document", "invoke_process"];
    case "granola":
      return ["fetch_granola_transcript", "invoke_process"];
    default:
      return ["invoke_process"];
  }
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function loadEnvelopeFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Simulated happy-path progress events for one source through acquire, validate, commit.
 * @param {string} runId
 * @param {string} sourceKey
 * @returns {Array<Record<string, unknown>>}
 */
export function simulateSingleSourceHappyPath(runId, sourceKey) {
  return [
    { event: "run_started", run_id: runId, phase: "preflight", status: "ok", duration_ms: 0 },
    { event: "preflight_passed", run_id: runId, phase: "preflight", status: "ok", duration_ms: 10 },
    {
      event: "source_acquired",
      run_id: runId,
      phase: "acquire",
      source_key: sourceKey,
      status: "ok",
      duration_ms: 100,
    },
    {
      event: "conversion_started",
      run_id: runId,
      phase: "convert",
      source_key: sourceKey,
      status: "ok",
      duration_ms: 200,
    },
    {
      event: "source_committed",
      run_id: runId,
      phase: "commit",
      source_key: sourceKey,
      status: "ok",
      commit_id: "abc1234",
      duration_ms: 500,
    },
    { event: "run_completed", run_id: runId, phase: "finalize", status: "ok", duration_ms: 510 },
  ];
}

/**
 * @param {Array<Record<string, unknown>>} events
 * @returns {boolean}
 */
export function verifyHappyPathOrdering(events) {
  const names = events.map((entry) => entry.event);
  const runStarted = names.indexOf("run_started");
  const preflightPassed = names.indexOf("preflight_passed");
  const sourceAcquired = names.indexOf("source_acquired");
  const conversionStarted = names.indexOf("conversion_started");
  const sourceCommitted = names.indexOf("source_committed");
  const runCompleted = names.indexOf("run_completed");

  return (
    runStarted < preflightPassed &&
    preflightPassed < sourceAcquired &&
    sourceAcquired < conversionStarted &&
    conversionStarted < sourceCommitted &&
    sourceCommitted < runCompleted
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsAllExitClasses(text) {
  return REQUIRED_EXIT_CLASSES.every((code) => {
    const pattern = new RegExp(`\\b${code}\\b`);
    return pattern.test(text);
  });
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIngestionFailureActions(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("retry") &&
    lower.includes("skip") &&
    lower.includes("abort") &&
    lower.includes("stop")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizeInitialPendingGate(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("zero pending") &&
    lower.includes("ingest batch") &&
    lower.includes("committed") &&
    lower.includes("skipped")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIncrementalOrganizeScope(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("new") &&
    lower.includes("dossier") &&
    lower.includes("overlap") &&
    lower.includes("topic map") &&
    lower.includes("unrelated")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizeProposalOnlyBoundary(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("proposal json only") &&
    lower.includes("never") &&
    lower.includes("auto-apply") &&
    lower.includes("validate-proposals")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizeDispositionTemplate(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("accepted") &&
    lower.includes("rejected") &&
    lower.includes("resolve") &&
    lower.includes("duplicate") &&
    lower.includes("contradiction")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizeApplicationPreservesNotePaths(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("topics/index.md") &&
    lower.includes("notes/") &&
    lower.includes("stable") &&
    lower.includes("validate-graph")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizeJournalBlock(text) {
  const lower = text.toLowerCase();
  return lower.includes("journal") && lower.includes("recover") && lower.includes("organize");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsOrganizePathMoveRejection(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("path move") && lower.includes("rename") && lower.includes("silent duplicate")
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function usesVaultPrefixOnly(text) {
  return !/\/okf-/i.test(text);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractVaultCommandSlugs(text) {
  const slugs = new Set();
  const pattern = /\/vault-([a-z-]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    slugs.add(`vault-${match[1]}`);
  }
  return [...slugs].sort();
}

/**
 * @param {string} registryText
 * @returns {Map<string, { mode: string; availability: string }>}
 */
export function parseRegistryCommandRows(registryText) {
  const rows = new Map();
  for (const line of registryText.split("\n")) {
    if (!line.includes("`/vault-")) {
      continue;
    }
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (cells.length < 4) {
      continue;
    }
    const command = cells[0].replace(/^`\/vault-/, "vault-").replace(/`$/, "");
    const mode = cells[2];
    const availability = cells[3];
    rows.set(command, { mode, availability });
  }
  return rows;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIngestFirstRouting(text) {
  const lower = text.toLowerCase();
  return (
    text.includes("/vault-ingest") &&
    (lower.includes("recommended") ||
      lower.includes("new content") ||
      lower.includes("starting point"))
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsVaultSetupRouting(text) {
  return (
    text.includes("/vault-init") &&
    text.includes("/vault-bootstrap") &&
    text.includes("./knowledge/")
  );
}

/**
 * @param {string} frontmatterDescription
 * @returns {boolean}
 */
export function documentsSkillModeTriggers(frontmatterDescription) {
  const lower = frontmatterDescription.toLowerCase();
  const modeHits = ["initializing", "ingesting", "organizing", "validating", "visualizing"].filter(
    (phrase) => lower.includes(phrase),
  );
  return modeHits.length >= 4 && lower.includes("/vault-ingest");
}

export const INGESTION_LOOP_HAPPY_PATH_EVENTS = [
  "run_started",
  "preflight_passed",
  "source_acquired",
  "conversion_started",
  "source_committed",
  "run_completed",
];

export const INGEST_WIZARD_STEPS = [
  "resolve_vault",
  "choose_source_type",
  "acquire_mcp",
  "acquire_local",
  "confirm_source",
  "delegate_ingest",
  "post_commit",
];

export const INGEST_RUN_INPUT_FIELDS = ["vault_root", "run_id", "sources"];

export const VAULT_SESSION_CONTEXT_FIELDS = [
  "vault_root",
  "last_run_id",
  "last_mode",
  "last_exit_status",
  "last_source_kind",
];

export const INGEST_WIZARD_STATE_FIELDS = ["step", "source_type", "pending_source", "run_id"];

export const INGEST_SOURCE_INPUT_FIELDS = ["kind", "locator", "content_type"];

/** Progress events documented in ingest-wizard.md emission table (post-delegation vocabulary). */
export const WIZARD_PROGRESS_EMISSION_EVENTS = [
  "run_started",
  "preflight_passed",
  "source_acquired",
  "source_already_processed",
  "conversion_started",
  "validation_failed",
  "source_committed",
  "run_failed",
  "run_completed",
];

/** Happy-path subset in wizard emission table order for ordering checks. */
export const WIZARD_HAPPY_PATH_PROGRESS_EVENTS = [
  "run_started",
  "preflight_passed",
  "source_acquired",
  "conversion_started",
  "source_committed",
  "run_completed",
];

/**
 * @param {string} markdown
 * @param {string} sectionHeading
 * @returns {string[]}
 */
export function extractMarkdownTableFields(markdown, sectionHeading) {
  const sectionIndex = markdown.indexOf(sectionHeading);
  if (sectionIndex < 0) {
    return [];
  }

  const afterSection = markdown.slice(sectionIndex);
  const tableStart = afterSection.search(/\| Field\s+\|/);
  if (tableStart < 0) {
    return [];
  }

  const tableBlock = afterSection.slice(tableStart);
  const tableEnd = tableBlock.indexOf("\n\n");
  const tableText = tableEnd >= 0 ? tableBlock.slice(0, tableEnd) : tableBlock;

  const fields = [];
  for (const line of tableText.split("\n")) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (match) {
      fields.push(match[1]);
    }
  }
  return fields;
}

/**
 * @param {string} sourceText
 * @param {string} interfaceName
 * @returns {string[]}
 */
export function extractInterfaceFieldNames(sourceText, interfaceName) {
  const pattern = new RegExp(`export interface ${interfaceName}\\s*\\{([^}]+)\\}`, "s");
  const match = sourceText.match(pattern);
  if (!match) {
    return [];
  }

  const fields = [];
  for (const line of match[1].split("\n")) {
    const fieldMatch = line.match(/^\s*(\w+)\??\s*:/);
    if (fieldMatch) {
      fields.push(fieldMatch[1]);
    }
  }
  return fields;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function extractProgressEmissionSection(text) {
  const marker = "## Progress event emission points";
  const start = text.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const after = text.slice(start + marker.length);
  const nextHeading = after.search(/\n## /);
  return nextHeading >= 0 ? after.slice(0, nextHeading) : after;
}

/**
 * @param {string} text
 * @param {string[]} [events]
 * @returns {boolean}
 */
export function verifyWizardProgressEventDocumentation(
  text,
  events = WIZARD_PROGRESS_EMISSION_EVENTS,
) {
  const section = extractProgressEmissionSection(text);
  if (section.length === 0) {
    return false;
  }

  for (const event of events) {
    if (!REQUIRED_PROGRESS_EVENTS.includes(event)) {
      return false;
    }
    if (!section.includes(`\`${event}\``)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} text
 * @param {string[]} [steps]
 * @returns {boolean}
 */
export function assertIngestWizardStepSections(text, steps = INGEST_WIZARD_STEPS) {
  for (const step of steps) {
    if (!new RegExp(`##\\s+[0-9a-z.]+\\s+${step}\\b`, "i").test(text)) {
      return false;
    }
    if (!text.includes(`\`${step}\``)) {
      return false;
    }
  }
  return true;
}

/**
 * Builds the IngestRunInput handoff object described at delegate_ingest.
 * @param {string} vaultRoot
 * @param {string} runId
 * @param {{ kind: string; locator: string; content_type: string }} pendingSource
 * @returns {{ vault_root: string; run_id: string; sources: Array<{ kind: string; locator: string; content_type: string }> }}
 */
export function buildWizardHandoffInput(vaultRoot, runId, pendingSource) {
  return {
    vault_root: vaultRoot,
    run_id: runId,
    sources: [pendingSource],
  };
}

/**
 * @param {string} skillText
 * @param {string} heading
 * @returns {string}
 */
export function extractSkillModeSection(skillText, heading) {
  const marker = `### ${heading}`;
  const start = skillText.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const after = skillText.slice(start + marker.length);
  const nextHeading = after.search(/\n### /);
  return nextHeading >= 0 ? after.slice(0, nextHeading) : after;
}

/**
 * True when a section enumerates most wizard steps (shadow orchestrator violation).
 * @param {string} sectionText
 * @param {string[]} [steps]
 * @returns {boolean}
 */
export function duplicatesWizardStepList(sectionText, steps = INGEST_WIZARD_STEPS) {
  let referenced = 0;
  for (const step of steps) {
    if (sectionText.includes(`\`${step}\``)) {
      referenced += 1;
    }
  }
  return referenced >= 5;
}

/**
 * @param {string} text
 * @param {string[]} [fields]
 * @returns {boolean}
 */
export function documentsIngestRunInputHandoff(text, fields = INGEST_RUN_INPUT_FIELDS) {
  return fields.every((field) => text.includes(`\`${field}\``));
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsNotInitializedRoutesAway(text) {
  return (
    text.includes("`not_initialized`") &&
    /\/vault-init/.test(text) &&
    /do not.*delegate|not.*ingest|routes to/i.test(text)
  );
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractMarkdownLinks(text) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    links.push(match[1]);
  }
  return links;
}

/**
 * Returns true when text paraphrases ingestion-loop happy-path phase order (pointer-only violation).
 * @param {string} text
 * @returns {boolean}
 */
export function containsIngestionLoopPhaseOrder(text) {
  let consecutive = 0;
  let searchFrom = 0;
  for (const event of INGESTION_LOOP_HAPPY_PATH_EVENTS) {
    const idx = text.indexOf(event, searchFrom);
    if (idx >= 0) {
      consecutive += 1;
      searchFrom = idx + event.length;
    } else {
      break;
    }
  }
  if (consecutive >= 3) {
    return true;
  }
  return /acquire\s*→\s*inspect\s*→\s*convert/i.test(text);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsDisableModelInvocationGuidance(text) {
  return text.includes("disable-model-invocation");
}

/**
 * @param {string} registryText
 * @param {string} stubFileName
 * @returns {boolean}
 */
export function registryLinksToStub(registryText, stubFileName) {
  return registryText.includes(`](${stubFileName})`);
}

/**
 * @param {string} baseDir
 * @param {string} text
 * @returns {string[]}
 */
export function brokenMarkdownLinks(baseDir, text) {
  const broken = [];
  for (const link of extractMarkdownLinks(text)) {
    if (link.startsWith("http") || link.startsWith("#")) {
      continue;
    }
    const filePart = link.split("#")[0];
    if (!filePart) {
      continue;
    }
    const resolved = join(baseDir, filePart);
    if (!existsSync(resolved)) {
      broken.push(link);
    }
  }
  return broken;
}

/**
 * @param {string} text
 * @param {string[]} [pipelines]
 * @returns {boolean}
 */
export function assertPipelineSections(text, pipelines = PIPELINE_NAMES) {
  for (const name of pipelines) {
    if (!new RegExp(`##\\s+${name}\\b`, "i").test(text)) {
      return false;
    }
  }
  return pipelines.length === 2;
}

/**
 * @param {string} text
 * @param {string} pipelineName
 * @param {string[]} modes
 * @returns {boolean}
 */
export function referencesSkillModeEntries(text, pipelineName, modes) {
  const marker = `## ${pipelineName}`;
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const after = text.slice(start);
  const nextPipeline = after.search(/\n## (?!#)/);
  const section = nextPipeline >= 0 ? after.slice(0, nextPipeline) : after;

  if (!section.includes("SKILL.md")) {
    return false;
  }
  for (const mode of modes) {
    if (!section.includes(mode)) {
      return false;
    }
  }
  if (containsIngestionLoopPhaseOrder(section)) {
    return false;
  }
  return true;
}

/**
 * @param {string} text
 * @param {string} pipelineName
 * @returns {boolean}
 */
export function documentsPipelineRunIdPairs(text, pipelineName) {
  const marker = `## ${pipelineName}`;
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const after = text.slice(start);
  const nextPipeline = after.search(/\n## (?!#)/);
  const section = nextPipeline >= 0 ? after.slice(0, nextPipeline) : after;
  const lower = section.toLowerCase();
  return lower.includes("run_started") && lower.includes("run_completed");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIngestCheckHardPause(text) {
  const marker = "## ingest-check";
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const section = text.slice(start);
  const lower = section.toLowerCase();
  return (
    lower.includes("hard pause") &&
    lower.includes("skipped") &&
    lower.includes("aborted") &&
    /do\s+\*\*not\*\*\s+auto-validate|do not auto-validate/i.test(section)
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIngestCheckValidateSuggestion(text) {
  const marker = "## ingest-check";
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const section = text.slice(start);
  const lower = section.toLowerCase();
  return (
    lower.includes("full success") &&
    lower.includes("auto-suggest") &&
    (lower.includes("confirms") || lower.includes("confirm")) &&
    (lower.includes("opts out") || lower.includes("opt out"))
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsBootstrapVaultResolution(text) {
  const marker = "## bootstrap";
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const section = text.slice(start);
  return (
    section.includes("./knowledge/") &&
    section.includes("`not_initialized`") &&
    /\/vault-init/.test(section)
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsIngestCheckWizardReuse(text) {
  const marker = "## ingest-check";
  const start = text.indexOf(marker);
  if (start < 0) {
    return false;
  }
  const section = text.slice(start);
  return section.includes("ingest-wizard.md") && section.includes("delegate_ingest");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function documentsFreshValidateRunId(text) {
  const lower = text.toLowerCase();
  return lower.includes("fresh `run_id`") || lower.includes("fresh run_id");
}

/**
 * @param {string} registryText
 * @returns {Map<string, string>}
 */
export function parsePipelineRegistrySectionLinks(registryText) {
  const links = new Map();
  for (const command of PIPELINE_COMMANDS) {
    const pattern = new RegExp(
      `\\| \`/${command}\`[^\\n]*pipelines\\.md\\)\\s+(bootstrap|ingest-check)`,
      "i",
    );
    const match = registryText.match(pattern);
    if (match) {
      links.set(command, match[1]);
      continue;
    }
    const fallback = new RegExp(
      `\\| \`/${command}\`[^\\n]*pipelines\\.md[^\\n]*(bootstrap|ingest-check)`,
      "i",
    );
    const fallbackMatch = registryText.match(fallback);
    if (fallbackMatch) {
      links.set(command, fallbackMatch[1]);
    }
  }
  return links;
}
