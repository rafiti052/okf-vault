import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IngestInputError, parseIngestRunInput } from "../../dist/vault/ingestion.js";
import {
  assertIngestWizardStepSections,
  buildWizardHandoffInput,
  CAPABILITY_NAMES,
  documentsIngestionFailureActions,
  extractInterfaceFieldNames,
  extractMarkdownTableFields,
  INGEST_SOURCE_INPUT_FIELDS,
  INGEST_WIZARD_STATE_FIELDS,
  INGEST_WIZARD_STEPS,
  REQUIRED_PROGRESS_EVENTS,
  skillRoot,
  VAULT_SESSION_CONTEXT_FIELDS,
  verifyHappyPathOrdering,
  verifyWizardProgressEventDocumentation,
  WIZARD_HAPPY_PATH_PROGRESS_EVENTS,
  WIZARD_PROGRESS_EMISSION_EVENTS,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const sessionSourcePath = join(root, "src", "vault", "session.ts");

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
  const sessionSource = readFileSync(sessionSourcePath, "utf8");

  it("contains numbered step sections for all seven IngestWizardStep values", () => {
    assert.equal(assertIngestWizardStepSections(text), true);
  });

  it("detects missing wizard step headings in synthetic markdown", () => {
    const broken = text.replace(/##\s+5\.\s+delegate_ingest/i, "## 5. removed_step");
    assert.equal(assertIngestWizardStepSections(broken), false);
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
    const sessionInterfaceFields = extractInterfaceFieldNames(sessionSource, "VaultSessionContext");
    const wizardInterfaceFields = extractInterfaceFieldNames(sessionSource, "IngestWizardState");

    assert.deepEqual(sessionInterfaceFields, VAULT_SESSION_CONTEXT_FIELDS);
    assert.deepEqual(wizardInterfaceFields, INGEST_WIZARD_STATE_FIELDS);

    const sessionFields = extractMarkdownTableFields(text, "### VaultSessionContext fields");
    const wizardFields = extractMarkdownTableFields(text, "### IngestWizardState fields");

    assert.deepEqual(sessionFields, VAULT_SESSION_CONTEXT_FIELDS);
    assert.deepEqual(wizardFields, INGEST_WIZARD_STATE_FIELDS);
    assert.deepEqual(sessionFields, sessionInterfaceFields);
    assert.deepEqual(wizardFields, wizardInterfaceFields);

    for (const field of INGEST_SOURCE_INPUT_FIELDS) {
      assert.match(text, new RegExp(`\`${field}\``));
    }
  });

  it("detects field parity drift when session.ts gains an undocumented field", () => {
    const augmented = sessionSource.replace(
      "last_source_kind: SessionSourceKind | null;",
      "last_source_kind: SessionSourceKind | null;\n  experimental_field: string | null;",
    );
    const augmentedFields = extractInterfaceFieldNames(augmented, "VaultSessionContext");
    const documentedFields = extractMarkdownTableFields(text, "### VaultSessionContext fields");
    assert.notDeepEqual(augmentedFields, documentedFields);
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

  it("documents wizard progress emission points using REQUIRED_PROGRESS_EVENTS vocabulary", () => {
    assert.equal(verifyWizardProgressEventDocumentation(text), true);
    for (const event of WIZARD_PROGRESS_EMISSION_EVENTS) {
      assert.ok(
        REQUIRED_PROGRESS_EVENTS.includes(event),
        `${event} must be a canonical progress event`,
      );
    }
  });

  it("detects missing run_started in synthetic emission documentation", () => {
    const broken = text.replace(/`run_started`/g, "`run_begin`");
    assert.equal(verifyWizardProgressEventDocumentation(broken), false);
  });

  it("preserves happy-path progress event ordering in wizard emission table", () => {
    const events = WIZARD_HAPPY_PATH_PROGRESS_EVENTS.map((name) => ({
      event: name,
      run_id: "r",
      phase: "p",
      status: "ok",
      duration_ms: 0,
    }));
    assert.equal(verifyHappyPathOrdering(events), true);
  });

  it("states session memory is chat-ephemeral with no filesystem persistence to managed vault paths", () => {
    assert.match(text, /chat-ephemeral/i);
    assert.match(text, /\.\/knowledge\//);
    assert.match(text, /\.okf-vault\//);
    assert.match(text, /never.*write session fields|never\*\* write session fields/i);
  });

  it("references parseVaultSessionContext for structural validation", () => {
    assert.match(text, /parseVaultSessionContext\(\)/);
  });

  it("documents fresh run_id for validate while retaining ingest run_id in session", () => {
    assert.match(text, /fresh `run_id`/i);
    assert.match(text, /retain.*ingest `run_id`|retains ingest `run_id`/i);
  });

  it("requires explicit curator confirmation before suggesting validate after skip or abort", () => {
    assert.match(text, /Post-commit suggestion gating \(skip and abort\)/i);
    assert.match(text, /explicitly confirms.*validate|explicit confirmation on skip\/abort/i);
    assert.match(
      text,
      /not\*\* include `\/vault-validate`|Do \*\*not\*\* include `\/vault-validate`/i,
    );
  });

  it("documents session write triggers for run_completed, run_failed, skip, and abort", () => {
    assert.match(text, /Write triggers by outcome/i);
    assert.match(text, /`run_completed`/);
    assert.match(text, /`run_failed`/);
    assert.match(text, /Skip \(choice B\)/i);
    assert.match(text, /Abort \(choice C\)/i);
  });
});

describe("ingest-wizard handoff payload", () => {
  it("rejects empty sources[] through parseIngestRunInput()", () => {
    assert.throws(
      () =>
        parseIngestRunInput({
          vault_root: "knowledge",
          run_id: "run-empty",
          sources: [],
        }),
      (error) => error instanceof IngestInputError && error.code === "EMPTY_SOURCE_LIST",
    );
  });

  it("rejects duplicate source keys in a two-element sources array", () => {
    assert.throws(
      () =>
        parseIngestRunInput({
          vault_root: "knowledge",
          run_id: "run-dup",
          sources: [
            { kind: "local", locator: "/tmp/a.md", content_type: "text/markdown" },
            { kind: "local", locator: "/tmp/a.md", content_type: "text/plain" },
          ],
        }),
      (error) => error instanceof IngestInputError && error.code === "DUPLICATE_SOURCE_KEY",
    );
  });

  it("accepts google_drive wizard handoff fixture through parseIngestRunInput()", () => {
    const handoff = buildWizardHandoffInput("knowledge", "run-wizard-drive-01", {
      kind: "google_drive",
      locator: "drive:doc-123",
      content_type: "application/vnd.google-apps.document",
    });

    const parsed = parseIngestRunInput(handoff);
    assert.equal(parsed.vault_root, "knowledge");
    assert.equal(parsed.run_id, "run-wizard-drive-01");
    assert.equal(parsed.sources.length, 1);
    assert.equal(parsed.sources[0]?.kind, "google_drive");
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

  it("wizard handoff with google_drive pending_source matches delegate_ingest contract fields", () => {
    const wizardText = readFileSync(ingestWizardPath, "utf8");
    assert.match(wizardText, /`vault_root`/);
    assert.match(wizardText, /`run_id`/);
    assert.match(wizardText, /`sources`/);

    const handoff = buildWizardHandoffInput("knowledge", "run-integration-01", {
      kind: "google_drive",
      locator: "drive:integration-doc",
      content_type: "application/vnd.google-apps.presentation",
    });

    const parsed = parseIngestRunInput(handoff);
    assert.equal(parsed.sources[0]?.locator, "drive:integration-doc");
    assert.equal(parsed.sources[0]?.content_type, "application/vnd.google-apps.presentation");
  });
});

describe("ingest-wizard contract helpers (unit)", () => {
  it("extractMarkdownTableFields returns empty when section heading is missing", () => {
    assert.deepEqual(extractMarkdownTableFields("no tables here", "### Missing"), []);
  });

  it("assertIngestWizardStepSections requires every INGEST_WIZARD_STEPS entry", () => {
    assert.equal(INGEST_WIZARD_STEPS.length, 7);
    for (const step of INGEST_WIZARD_STEPS) {
      assert.match(step, /^[a-z_]+$/);
    }
  });
});
