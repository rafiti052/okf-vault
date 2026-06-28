import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIngestRunInput } from "../../dist/vault/ingestion.js";
import {
  buildWizardHandoffInput,
  containsIngestionLoopPhaseOrder,
  documentsIngestRunInputHandoff,
  documentsNotInitializedRoutesAway,
  duplicatesWizardStepList,
  extractSkillModeSection,
  INGEST_WIZARD_STEPS,
  skillRoot,
  validateYoutubeWizardHandoff,
  verifyHappyPathOrdering,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const skillPath = join(skillDir, "SKILL.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const ingestionLoopPath = join(skillDir, "references", "ingestion-loop.md");

describe("skill ingest wizard delegation (unit)", () => {
  const skillText = readFileSync(skillPath, "utf8");
  const ingestSection = extractSkillModeSection(skillText, "ingest");
  const wizardText = readFileSync(ingestWizardPath, "utf8");

  it("extractSkillModeSection isolates ingest mode content", () => {
    assert.ok(ingestSection.length > 0);
    assert.match(ingestSection, /Entry paths/i);
    assert.doesNotMatch(ingestSection, /^### organize/m);
  });

  it("duplicatesWizardStepList flags shadow orchestrator step lists", () => {
    const violation = INGEST_WIZARD_STEPS.map((step) => `\`${step}\``).join(" ");
    assert.equal(duplicatesWizardStepList(violation), true);
    assert.equal(duplicatesWizardStepList("only `delegate_ingest` and `resolve_vault`"), false);
  });

  it("documentsIngestRunInputHandoff requires vault_root, run_id, and sources", () => {
    assert.equal(documentsIngestRunInputHandoff("`vault_root` `run_id` `sources` handoff"), true);
    assert.equal(documentsIngestRunInputHandoff("missing run_id"), false);
  });

  it("documentsNotInitializedRoutesAway detects initialize routing copy", () => {
    assert.equal(
      documentsNotInitializedRoutesAway(
        "`not_initialized` routes to /okv-init — do not delegate to ingest mode",
      ),
      true,
    );
    assert.equal(documentsNotInitializedRoutesAway("vault not ready"), false);
  });

  it("SKILL.md ingest mode links to references/ingest-wizard.md", () => {
    assert.match(ingestSection, /ingest-wizard\.md/);
    assert.match(ingestSection, /Command-driven/i);
    assert.match(ingestSection, /\/okv-ingest/);
  });

  it("SKILL.md ingest mode does not duplicate the full wizard step list", () => {
    assert.equal(duplicatesWizardStepList(ingestSection), false);
    assert.doesNotMatch(ingestSection, /##\s+[0-9]+\.\s+resolve_vault/i);
    assert.doesNotMatch(ingestSection, /\|\s*1\s*\|\s*`resolve_vault`/);
  });

  it("ingest-wizard.md delegate_ingest links to ingestion-loop.md without redefining happy-path order", () => {
    const delegateSection = wizardText.slice(wizardText.indexOf("## 5. delegate_ingest"));
    assert.match(delegateSection, /ingestion-loop\.md/);
    assert.match(delegateSection, /do not redefine/i);
    assert.doesNotMatch(delegateSection, /##\s+[0-9]+\.\s+(convert|validate|commit)\b/i);
  });

  it("handoff documentation names required IngestRunInput fields", () => {
    assert.equal(documentsIngestRunInputHandoff(ingestSection), true);
    assert.match(ingestSection, /IngestRunInput/);
    assert.match(ingestSection, /parseIngestRunInput/);
  });

  it("SKILL.md documents not_initialized vault outcome routes away from ingest delegation", () => {
    assert.equal(documentsNotInitializedRoutesAway(ingestSection), true);
    assert.match(wizardText, /Stop wizard acquisition/i);
    assert.match(wizardText, /not_initialized/);
  });

  it("SKILL.md places preflight after source metadata confirmation and before helper acquisition", () => {
    const orchestration = ingestSection.slice(ingestSection.indexOf("#### Orchestration"));
    assert.match(
      orchestration,
      /after.*source metadata is confirmed.*before.*helper acquisition/is,
    );
    assert.match(orchestration, /Run full preflight/i);
  });
});

describe("skill ingest wizard delegation (integration)", () => {
  const skillText = readFileSync(skillPath, "utf8");
  const ingestionLoopText = readFileSync(ingestionLoopPath, "utf8");

  it("sample wizard handoff object passes parseIngestRunInput()", () => {
    const handoff = parseIngestRunInput({
      vault_root: "knowledge",
      run_id: "run-1",
      sources: [
        {
          kind: "local",
          locator: "/tmp/a.md",
          content_type: "text/markdown",
        },
      ],
    });

    assert.equal(handoff.vault_root, "knowledge");
    assert.equal(handoff.run_id, "run-1");
    assert.equal(handoff.sources.length, 1);
    assert.equal(handoff.sources[0]?.kind, "local");
  });

  it("youtube wizard handoff passes contract shape and parseIngestRunInput()", () => {
    const raw = buildWizardHandoffInput("knowledge", "run-youtube-delegate", {
      kind: "youtube",
      locator: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      content_type: "text/vtt",
    });

    const shape = validateYoutubeWizardHandoff(raw);
    assert.equal(shape.ok, true);

    const parsed = parseIngestRunInput(raw);
    assert.equal(parsed.sources[0]?.kind, "youtube");
    assert.equal(parsed.sources[0]?.content_type, "text/vtt");
    assert.match(String(parsed.sources[0]?.locator), /dQw4w9WgXcQ/);
  });

  it("ingestion-loop happy-path ordering still passes after SKILL.md wizard pointer addition", () => {
    const events = [
      "run_started",
      "preflight_passed",
      "source_acquired",
      "conversion_started",
      "source_committed",
      "run_completed",
    ].map((name) => ({ event: name, run_id: "r", phase: "p", status: "ok", duration_ms: 0 }));

    assert.equal(verifyHappyPathOrdering(events), true);
    assert.equal(containsIngestionLoopPhaseOrder(skillText), false);
    assert.match(ingestionLoopText, /run_started/);
  });
});
