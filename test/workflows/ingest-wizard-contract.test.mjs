import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_NAMES,
  documentsIngestionFailureActions,
  skillRoot,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const sessionSourcePath = join(root, "src", "vault", "session.ts");

const INGEST_WIZARD_STEPS = [
  "resolve_vault",
  "choose_source_type",
  "acquire_mcp",
  "acquire_local",
  "confirm_source",
  "delegate_ingest",
  "post_commit",
];

const VAULT_SESSION_CONTEXT_FIELDS = [
  "vault_root",
  "last_run_id",
  "last_mode",
  "last_exit_status",
  "last_source_kind",
];

const INGEST_WIZARD_STATE_FIELDS = ["step", "source_type", "pending_source", "run_id"];

const INGEST_SOURCE_INPUT_FIELDS = ["kind", "locator", "content_type"];

/**
 * @param {string} markdown
 * @returns {string[]}
 */
function extractMarkdownTableFields(markdown, sectionHeading) {
  const sectionIndex = markdown.indexOf(sectionHeading);
  assert.ok(sectionIndex >= 0, `Missing section: ${sectionHeading}`);

  const afterSection = markdown.slice(sectionIndex);
  const tableStart = afterSection.indexOf("| Field |");
  assert.ok(tableStart >= 0, `Missing field table under ${sectionHeading}`);

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
 * @param {string} markdown
 * @returns {string[]}
 */
function extractRelativeLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1];
    if (!target.startsWith("http") && !target.startsWith("#")) {
      links.push(target);
    }
  }
  return links;
}

/**
 * @param {string} text
 * @returns {number}
 */
function indexOfSuggestion(text, command) {
  return text.indexOf(command);
}

describe("ingest-wizard contract", () => {
  const text = readFileSync(ingestWizardPath, "utf8");

  it("contains numbered step sections for all seven IngestWizardStep values", () => {
    for (const step of INGEST_WIZARD_STEPS) {
      assert.match(text, new RegExp(`##\\s+[0-9a-z.]+\\s+${step}\\b`, "i"));
    }
    for (const step of INGEST_WIZARD_STEPS) {
      assert.match(text, new RegExp(`\`${step}\``, "g"));
    }
  });

  it("documents exactly two source type branches: MCP artifact and local file", () => {
    assert.match(text, /\*\*MCP artifact\*\*/);
    assert.match(text, /\*\*Local file\*\*/);
    assert.match(text, /`mcp_artifact`/);
    assert.match(text, /`local_file`/);
    assert.match(text, /no inference/i);

    const mcpCount = (text.match(/MCP artifact/gi) ?? []).length;
    const localCount = (text.match(/Local file/gi) ?? []).length;
    assert.ok(mcpCount >= 1);
    assert.ok(localCount >= 1);
  });

  it("contains numbered A/B/C failure choices matching ADR-009 language", () => {
    assert.match(text, /\*\*A\)\s*Retry\*\*/i);
    assert.match(text, /\*\*B\)\s*Skip with reason\*\*/i);
    assert.match(text, /\*\*C\)\s*Abort\*\*/i);
    assert.match(text, /no silent default/i);
    assert.equal(documentsIngestionFailureActions(text), true);
  });

  it("forbids automatic watchers and batch silent conversion with explicit negative statements", () => {
    assert.match(text, /no automatic watchers/i);
    assert.match(text, /batch silent conversion/i);
    assert.match(text, /Do not.*enumerate directories|must never.*Enumerate directories/is);
    assert.match(text, /must never/i);
  });

  it("markdown table fields match VaultSessionContext and IngestWizardState from session.ts", () => {
    const sessionSource = readFileSync(sessionSourcePath, "utf8");

    for (const field of VAULT_SESSION_CONTEXT_FIELDS) {
      assert.match(sessionSource, new RegExp(`${field}:`));
    }
    for (const field of INGEST_WIZARD_STATE_FIELDS) {
      assert.match(sessionSource, new RegExp(`${field}:`));
    }

    const sessionFields = extractMarkdownTableFields(text, "### VaultSessionContext fields");
    const wizardFields = extractMarkdownTableFields(text, "### IngestWizardState fields");

    assert.deepEqual(sessionFields, VAULT_SESSION_CONTEXT_FIELDS);
    assert.deepEqual(wizardFields, INGEST_WIZARD_STATE_FIELDS);

    for (const field of INGEST_SOURCE_INPUT_FIELDS) {
      assert.match(text, new RegExp(`\`${field}\``));
    }
  });

  it("contains delegate_ingest handoff referencing SKILL.md ingest mode without redefining phase order", () => {
    assert.match(text, /##\s+5\.\s+delegate_ingest/i);
    assert.match(text, /Hard stop/i);
    assert.match(text, /SKILL\.md.*ingest mode/i);
    assert.match(text, /ingestion-loop\.md/);
    assert.match(text, /do not redefine/i);
    assert.doesNotMatch(text, /##\s+[0-9]+\.\s+(convert|validate|commit)\b/i);
  });

  it("documents vault resolution outcomes found and not_initialized", () => {
    assert.match(text, /`found`/);
    assert.match(text, /`not_initialized`/);
    assert.match(text, /resolveVaultRoot/);
    assert.match(text, /does not.*ask.*vault path|does not\*\* ask the curator for a vault path/i);
    assert.match(text, /\/vault-init/);
  });

  it("cross-links capability names for MCP and local branches", () => {
    assert.match(text, /capabilities\.md/);
    for (const capability of [
      "fetch_drive_document",
      "fetch_granola_transcript",
      "read_local_file",
    ]) {
      assert.match(text, new RegExp(capability));
      assert.ok(CAPABILITY_NAMES.includes(capability));
    }
    assert.match(text, /google_drive/);
    assert.match(text, /granola/);
  });

  it("aligns progress event emission points with progress-events.md vocabulary", () => {
    assert.match(text, /progress-events\.md/);
    for (const event of [
      "run_started",
      "preflight_passed",
      "source_acquired",
      "conversion_started",
      "validation_failed",
      "source_committed",
      "run_completed",
      "run_failed",
    ]) {
      assert.match(text, new RegExp(`\`${event}\``));
    }
  });
});

describe("ingest-wizard contract integration", () => {
  const text = readFileSync(ingestWizardPath, "utf8");

  it("resolves all relative links to existing files under the skill directory", () => {
    const links = extractRelativeLinks(text);
    assert.ok(links.length > 0);

    const contractDir = dirname(ingestWizardPath);
    for (const link of links) {
      const resolved = resolve(contractDir, link);
      assert.ok(existsSync(resolved), `Broken link "${link}" → expected ${resolved}`);
      assert.ok(
        resolved.startsWith(skillDir),
        `Link "${link}" must target a file under ${skillDir}`,
      );
    }
  });

  it("lists post-commit suggestions with /vault-ingest before /vault-validate before session end", () => {
    const ingestIdx = indexOfSuggestion(text, "/vault-ingest");
    const validateIdx = indexOfSuggestion(text, "/vault-validate");
    const sessionEndIdx = text.toLowerCase().indexOf("session end");

    assert.ok(ingestIdx >= 0, "missing /vault-ingest suggestion");
    assert.ok(validateIdx >= 0, "missing /vault-validate suggestion");
    assert.ok(sessionEndIdx >= 0, "missing session end suggestion");

    const postCommitSection = text.slice(text.indexOf("## 6. post_commit"));
    const sectionIngest = indexOfSuggestion(postCommitSection, "/vault-ingest");
    const sectionValidate = indexOfSuggestion(postCommitSection, "/vault-validate");
    const sectionEnd = postCommitSection.toLowerCase().indexOf("session end");

    assert.ok(sectionIngest < sectionValidate, "/vault-ingest must precede /vault-validate");
    assert.ok(sectionValidate < sectionEnd, "/vault-validate must precede session end");
  });
});
