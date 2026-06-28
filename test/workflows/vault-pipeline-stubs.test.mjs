import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_TOOL_PATTERN,
  OKV_COMMANDS,
  PIPELINE_COMMANDS,
  skillRoot,
  usesVaultPrefixOnly,
  parseRegistryCommandRows,
  containsIngestionLoopPhaseOrder,
  documentsDisableModelInvocationGuidance,
  registryLinksToStub,
  brokenMarkdownLinks,
  ALL_OKV_COMMAND_STUBS,
  PHASE_1B_PIPELINE_COMMAND_STUBS,
  PIPELINE_STUB_SECTION_ANCHORS,
  linksToPipelineSection,
  containsInlinePipelineModeSequence,
  documentsPipelineHandoffPointer,
  registryMarksPhase1bShipped,
  parsePipelineRegistrySectionLinks,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const commandsDir = join(skillDir, "commands");
const registryPath = join(commandsDir, "registry.md");
const pipelinesPath = join(skillDir, "references", "pipelines.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");

/**
 * @param {string} stubFileName
 * @returns {string}
 */
function stubPath(stubFileName) {
  return join(commandsDir, stubFileName);
}

describe("Phase 1b pipeline stub helpers (unit)", () => {
  it("linksToPipelineSection matches pipelines.md hash targets", () => {
    const sample = "[pipelines](../references/pipelines.md#bootstrap)";
    assert.equal(linksToPipelineSection(sample, "bootstrap"), true);
    assert.equal(linksToPipelineSection(sample, "ingest-check"), false);
  });

  it("containsInlinePipelineModeSequence detects arrow-separated mode legs", () => {
    assert.equal(containsInlinePipelineModeSequence("initialize → validate"), true);
    assert.equal(containsInlinePipelineModeSequence("pointer to pipelines.md only"), false);
  });

  it("documentsPipelineHandoffPointer detects curator handoff references", () => {
    assert.equal(documentsPipelineHandoffPointer("curator handoff gates"), true);
    assert.equal(documentsPipelineHandoffPointer("no gate documentation"), false);
  });

  it("parsePipelineRegistrySectionLinks reads pipeline section names from registry rows", () => {
    const sample =
      "| `/okv-bootstrap` | purpose | pipelines.md) bootstrap | shipped |\n" +
      "| `/okv-ingest-check` | purpose | pipelines.md) ingest-check | shipped |";
    const links = parsePipelineRegistrySectionLinks(sample);
    assert.equal(links.get("okv-bootstrap"), "bootstrap");
    assert.equal(links.get("okv-ingest-check"), "ingest-check");
  });
});

describe("Phase 1b pipeline command stubs (unit)", () => {
  it("all eight OKV command stub files exist in canonical commands/", () => {
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
      assert.ok(existsSync(stubPath(stubFileName)), `missing ${stubFileName}`);
    }
    assert.equal(ALL_OKV_COMMAND_STUBS.length, 8);
  });

  for (const stubFileName of PHASE_1B_PIPELINE_COMMAND_STUBS) {
    const path = stubPath(stubFileName);
    const stubText = readFileSync(path, "utf8");
    const commandSlug = stubFileName.replace(".md", "");
    const sectionAnchor = PIPELINE_STUB_SECTION_ANCHORS[stubFileName];
    const firstHeading = stubText.split("\n").find((line) => line.startsWith("#"));

    describe(stubFileName, () => {
      it("exists at the canonical skill commands path", () => {
        assert.ok(existsSync(path));
      });

      it("first heading references the /okv-* command and not /okf-*", () => {
        assert.ok(firstHeading);
        assert.match(firstHeading, new RegExp(`/${commandSlug}`));
        assert.equal(usesVaultPrefixOnly(stubText), true);
      });

      it(`links to pipelines.md#${sectionAnchor} and registry.md`, () => {
        assert.equal(linksToPipelineSection(stubText, sectionAnchor), true);
        assert.match(stubText, /registry\.md/);
      });

      it("documents curator handoff gates as a pointer only", () => {
        assert.equal(documentsPipelineHandoffPointer(stubText), true);
      });

      it("is pointer-only: no inline pipeline mode sequences", () => {
        assert.equal(containsInlinePipelineModeSequence(stubText), false);
        assert.equal(containsIngestionLoopPhaseOrder(stubText), false);
      });

      it("contains no provider tool name patterns", () => {
        assert.equal(PROVIDER_TOOL_PATTERN.test(stubText), false);
      });

      it("notes disable-model-invocation guidance for runtime adapters", () => {
        assert.equal(documentsDisableModelInvocationGuidance(stubText), true);
      });

      it("stays under 30 non-empty lines", () => {
        const lines = stubText.split("\n").filter((line) => line.trim().length > 0);
        assert.ok(lines.length <= 30, `${stubFileName} has ${lines.length} non-empty lines`);
      });
    });
  }

  it("okv-ingest-check.md also links to ingest-wizard.md", () => {
    const stubText = readFileSync(stubPath("okv-ingest-check.md"), "utf8");
    assert.match(stubText, /ingest-wizard\.md/);
  });

  it("okv-bootstrap.md does not link to ingest-wizard.md", () => {
    const stubText = readFileSync(stubPath("okv-bootstrap.md"), "utf8");
    assert.doesNotMatch(stubText, /ingest-wizard\.md/);
  });
});

describe("Phase 1b pipeline command stubs (integration)", () => {
  const registryText = readFileSync(registryPath, "utf8");
  const rows = parseRegistryCommandRows(registryText);
  const pipelineLinks = parsePipelineRegistrySectionLinks(registryText);

  it("registry.md lists all eight commands with consistent /okv-* naming", () => {
    const slugs = [...rows.keys()].sort();
    assert.deepEqual(slugs, [...OKV_COMMANDS].sort());
    assert.equal(usesVaultPrefixOnly(registryText), true);
  });

  it("registry.md marks both pipeline commands as Phase 1b shipped", () => {
    for (const command of PIPELINE_COMMANDS) {
      assert.equal(registryMarksPhase1bShipped(registryText, command), true);
      const row = rows.get(command);
      assert.ok(row);
      assert.match(row.availability, /Phase 1b/i);
      assert.match(row.availability, /shipped/i);
    }
  });

  it("registry.md links each pipeline stub file and pipelines.md section", () => {
    for (const stubFileName of PHASE_1B_PIPELINE_COMMAND_STUBS) {
      assert.equal(registryLinksToStub(registryText, stubFileName), true);
    }
    assert.equal(pipelineLinks.size, PIPELINE_COMMANDS.length);
    for (const [command, section] of pipelineLinks) {
      assert.ok(PIPELINE_COMMANDS.includes(command));
      assert.ok(existsSync(pipelinesPath));
      const pipelinesText = readFileSync(pipelinesPath, "utf8");
      assert.match(pipelinesText, new RegExp(`##\\s+${section}\\b`, "i"));
    }
  });

  it("all markdown links in pipeline stubs resolve relative to commands/", () => {
    for (const stubFileName of PHASE_1B_PIPELINE_COMMAND_STUBS) {
      const text = readFileSync(stubPath(stubFileName), "utf8");
      const broken = brokenMarkdownLinks(commandsDir, text);
      assert.deepEqual(broken, [], `${stubFileName} has broken links: ${broken.join(", ")}`);
    }
    assert.ok(existsSync(pipelinesPath));
    assert.ok(existsSync(ingestWizardPath));
    assert.ok(existsSync(registryPath));
  });
});
