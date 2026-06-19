import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_TOOL_PATTERN,
  skillRoot,
  usesVaultPrefixOnly,
  parseRegistryCommandRows,
  containsIngestionLoopPhaseOrder,
  documentsDisableModelInvocationGuidance,
  registryLinksToStub,
  brokenMarkdownLinks,
  PHASE_1B_MODE_COMMAND_STUBS,
  MODE_STUB_SKILL_ANCHORS,
  PHASE_1B_SHIPPED_COMMANDS,
  PHASE_1B_PLANNED_COMMANDS,
  INGEST_WIZARD_STEPS,
  duplicatesIngestWizardStepHeadings,
  linksToSkillModeAnchor,
  registryMarksPhase1bShipped,
  extractSkillModeSection,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const commandsDir = join(skillDir, "commands");
const registryPath = join(commandsDir, "registry.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const skillPath = join(skillDir, "SKILL.md");

/**
 * @param {string} stubFileName
 * @returns {string}
 */
function stubPath(stubFileName) {
  return join(commandsDir, stubFileName);
}

describe("Phase 1b mode stub helpers (unit)", () => {
  it("duplicatesIngestWizardStepHeadings detects wizard step section headings", () => {
    assert.equal(duplicatesIngestWizardStepHeadings("## 1. resolve_vault\n"), true);
    assert.equal(duplicatesIngestWizardStepHeadings("pointer to SKILL.md only"), false);
  });

  it("linksToSkillModeAnchor matches SKILL.md hash targets", () => {
    assert.equal(linksToSkillModeAnchor("[SKILL.md](../SKILL.md#initialize)", "initialize"), true);
    assert.equal(linksToSkillModeAnchor("[SKILL.md](../SKILL.md#organize)", "initialize"), false);
  });

  it("registryMarksPhase1bShipped reads availability column", () => {
    const sample = "| `/vault-init` | purpose | mode | **Phase 1b shipped** |";
    assert.equal(registryMarksPhase1bShipped(sample, "vault-init"), true);
    assert.equal(registryMarksPhase1bShipped(sample, "vault-bootstrap"), false);
  });
});

describe("Phase 1b mode command stubs (unit)", () => {
  const skillText = readFileSync(skillPath, "utf8");
  const ingestWizardText = readFileSync(ingestWizardPath, "utf8");

  for (const stubFileName of PHASE_1B_MODE_COMMAND_STUBS) {
    const path = stubPath(stubFileName);
    const stubText = readFileSync(path, "utf8");
    const commandSlug = stubFileName.replace(".md", "");
    const anchor = MODE_STUB_SKILL_ANCHORS[stubFileName];
    const firstHeading = stubText.split("\n").find((line) => line.startsWith("#"));

    describe(stubFileName, () => {
      it("exists at the canonical skill commands path", () => {
        assert.ok(existsSync(path));
      });

      it("first heading references the /vault-* command and not /okf-*", () => {
        assert.ok(firstHeading);
        assert.match(firstHeading, new RegExp(`/${commandSlug}`));
        assert.equal(usesVaultPrefixOnly(stubText), true);
      });

      it(`links to SKILL.md#${anchor} and registry.md`, () => {
        assert.equal(linksToSkillModeAnchor(stubText, anchor), true);
        assert.match(stubText, /registry\.md/);
      });

      it("does not link to ingest-wizard.md", () => {
        assert.doesNotMatch(stubText, /ingest-wizard\.md/);
      });

      it("is pointer-only: no ingestion-loop happy-path phase order", () => {
        assert.equal(containsIngestionLoopPhaseOrder(stubText), false);
      });

      it("contains no provider tool name patterns", () => {
        assert.equal(PROVIDER_TOOL_PATTERN.test(stubText), false);
      });

      it("does not duplicate ingest wizard step section headings", () => {
        assert.equal(duplicatesIngestWizardStepHeadings(stubText), false);
        for (const step of INGEST_WIZARD_STEPS) {
          assert.doesNotMatch(stubText, new RegExp(`^##\\s+[0-9a-z.]+\\s+${step}\\b`, "im"));
        }
      });

      it("notes disable-model-invocation guidance for runtime adapters", () => {
        assert.equal(documentsDisableModelInvocationGuidance(stubText), true);
      });

      it("stays under 30 non-empty lines", () => {
        const lines = stubText.split("\n").filter((line) => line.trim().length > 0);
        assert.ok(lines.length <= 30, `${stubFileName} has ${lines.length} non-empty lines`);
      });

      it(`SKILL.md has a distinct ### ${anchor} mode section`, () => {
        const section = extractSkillModeSection(skillText, anchor);
        assert.ok(section.length > 0, `missing SKILL.md section ### ${anchor}`);
        assert.equal(duplicatesIngestWizardStepHeadings(section), false);
        assert.equal(duplicatesIngestWizardStepHeadings(ingestWizardText), true);
      });
    });
  }

  it("vault-init.md references ./knowledge/ as initialize target", () => {
    const initText = readFileSync(stubPath("vault-init.md"), "utf8");
    assert.match(initText, /\.\/knowledge\/|knowledge\//);
  });

  it("each stub links to a distinct SKILL.md mode anchor", () => {
    const anchors = PHASE_1B_MODE_COMMAND_STUBS.map(
      (fileName) => MODE_STUB_SKILL_ANCHORS[fileName],
    );
    assert.equal(new Set(anchors).size, anchors.length);
  });
});

describe("Phase 1b mode command stubs (integration)", () => {
  const registryText = readFileSync(registryPath, "utf8");
  const rows = parseRegistryCommandRows(registryText);

  it("registry.md lists all four mode commands with Phase 1b shipped labels", () => {
    for (const command of PHASE_1B_SHIPPED_COMMANDS) {
      assert.equal(registryMarksPhase1bShipped(registryText, command), true);
      const row = rows.get(command);
      assert.ok(row);
      assert.match(row.availability, /Phase 1b/i);
      assert.match(row.availability, /shipped/i);
    }
  });

  it("registry.md links each shipped mode stub file", () => {
    for (const stubFileName of PHASE_1B_MODE_COMMAND_STUBS) {
      assert.equal(registryLinksToStub(registryText, stubFileName), true);
    }
  });

  it("no Phase 1b commands remain planned in registry availability", () => {
    for (const command of PHASE_1B_PLANNED_COMMANDS) {
      const row = rows.get(command);
      assert.ok(row);
      assert.match(row.availability, /Phase 1b/i);
      assert.match(row.availability, /planned/i);
    }
  });

  it("all markdown links in each stub resolve relative to commands/", () => {
    for (const stubFileName of PHASE_1B_MODE_COMMAND_STUBS) {
      const text = readFileSync(stubPath(stubFileName), "utf8");
      const broken = brokenMarkdownLinks(commandsDir, text);
      assert.deepEqual(broken, [], `${stubFileName} has broken links: ${broken.join(", ")}`);
    }
    assert.ok(existsSync(skillPath));
    assert.ok(existsSync(registryPath));
  });
});
