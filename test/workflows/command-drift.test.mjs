import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_TOOL_PATTERN,
  OKV_COMMANDS,
  skillRoot,
  canonicalCommandsDir,
  cursorCommandsDir,
  claudeCommandsDir,
  usesVaultPrefixOnly,
  parseRegistryCommandRows,
  ALL_OKV_COMMAND_STUBS,
  MODE_STUB_SKILL_ANCHORS,
  PHASE_1B_MODE_COMMAND_STUBS,
  PHASE_1B_PIPELINE_COMMAND_STUBS,
  PIPELINE_STUB_SECTION_ANCHORS,
  INGESTION_LOOP_HAPPY_PATH_EVENTS,
  headingToMarkdownAnchor,
  extractMarkdownHeadingAnchors,
  resolveMarkdownAnchor,
  listCommandStubs,
  resolveMarkdownLink,
  brokenMarkdownLinksWithAnchors,
  violatesPointerOnlyStubRules,
  containsIngestionLoopPhaseOrder,
  linksToSkillModeAnchor,
  linksToPipelineSection,
  assertAdapterStubResolves,
  extractMarkdownLinks,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const commandsDir = canonicalCommandsDir(root);
const cursorDir = cursorCommandsDir(root);
const claudeDir = claudeCommandsDir(root);
const registryPath = join(commandsDir, "registry.md");
const skillPath = join(skillDir, "SKILL.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const pipelinesPath = join(skillDir, "references", "pipelines.md");

const skillText = readFileSync(skillPath, "utf8");
const pipelinesText = readFileSync(pipelinesPath, "utf8");
const registryText = readFileSync(registryPath, "utf8");

/**
 * @param {string} stubFileName
 * @returns {string}
 */
function readStub(stubFileName) {
  return readFileSync(join(commandsDir, stubFileName), "utf8");
}

describe("F8 command drift helpers (unit)", () => {
  it("headingToMarkdownAnchor converts SKILL.md mode headings to anchor slugs", () => {
    assert.equal(headingToMarkdownAnchor("ingest"), "ingest");
    assert.equal(headingToMarkdownAnchor("initialize"), "initialize");
    assert.equal(headingToMarkdownAnchor("Wizard step order"), "wizard-step-order");
  });

  it("extractMarkdownHeadingAnchors collects anchors from SKILL.md headings", () => {
    const anchors = extractMarkdownHeadingAnchors(skillText);
    for (const mode of ["initialize", "ingest", "organize", "validate", "visualize"]) {
      assert.equal(anchors.has(mode), true, `missing SKILL.md anchor ${mode}`);
    }
  });

  it("resolveMarkdownAnchor resolves existing and rejects missing anchors", () => {
    assert.equal(resolveMarkdownAnchor(skillText, "ingest"), true);
    assert.equal(resolveMarkdownAnchor(skillText, "initialize"), true);
    assert.equal(resolveMarkdownAnchor(skillText, "nonexistent-mode"), false);
  });

  it("listCommandStubs returns exactly seven OKV command stub files", () => {
    const stubs = listCommandStubs(commandsDir);
    assert.deepEqual(stubs, [...ALL_OKV_COMMAND_STUBS].sort());
    assert.equal(stubs.length, 7);
    assert.deepEqual(stubs, [
      "okv-bootstrap.md",
      "okv-ingest-check.md",
      "okv-ingest.md",
      "okv-init.md",
      "okv-organize.md",
      "okv-validate.md",
      "okv-visualize.md",
    ]);
  });

  it("resolveMarkdownLink validates file existence and heading anchors", () => {
    const ok = resolveMarkdownLink(commandsDir, "../SKILL.md#ingest");
    assert.equal(ok.ok, true);

    const missingFile = resolveMarkdownLink(commandsDir, "../missing.md");
    assert.equal(missingFile.ok, false);
    assert.match(missingFile.message, /Missing file/);

    const missingAnchor = resolveMarkdownLink(commandsDir, "../SKILL.md#broken-anchor");
    assert.equal(missingAnchor.ok, false);
    assert.match(missingAnchor.message, /Missing anchor/);
  });

  it("brokenMarkdownLinksWithAnchors reports broken SKILL.md anchor links", () => {
    const valid = brokenMarkdownLinksWithAnchors(commandsDir, "[ingest](../SKILL.md#ingest)");
    assert.deepEqual(valid, []);

    const broken = brokenMarkdownLinksWithAnchors(
      commandsDir,
      "[bad](../SKILL.md#nonexistent-mode)",
    );
    assert.equal(broken.length, 1);
    assert.match(broken[0], /nonexistent-mode/);
  });

  it("violatesPointerOnlyStubRules detects provider tool names", () => {
    assert.equal(violatesPointerOnlyStubRules("use mcp_fetch_drive here"), true);
    assert.equal(PROVIDER_TOOL_PATTERN.test("use mcp_fetch_drive here"), true);
    assert.equal(violatesPointerOnlyStubRules("pointer to ingest-wizard.md only"), false);
  });

  it("violatesPointerOnlyStubRules detects ingestion-loop happy-path event sequences", () => {
    const copiedSequence = INGESTION_LOOP_HAPPY_PATH_EVENTS.join(" → ");
    assert.equal(violatesPointerOnlyStubRules(copiedSequence), true);
    assert.equal(containsIngestionLoopPhaseOrder(copiedSequence), true);
  });

  it("injecting a broken SKILL.md anchor link is detectable before commit", () => {
    const driftStub = "# /okv-init\n\nSee [SKILL.md](../SKILL.md#not-a-real-mode).";
    const links = extractMarkdownLinks(driftStub);
    assert.deepEqual(links, ["../SKILL.md#not-a-real-mode"]);
    const broken = brokenMarkdownLinksWithAnchors(commandsDir, driftStub);
    assert.equal(broken.length, 1);
    assert.equal(resolveMarkdownAnchor(skillText, "not-a-real-mode"), false);
  });
});

describe("F8 command stub linkage (unit)", () => {
  for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
    describe(stubFileName, () => {
      const stubText = readStub(stubFileName);

      it("uses /okv-* prefix only (no /okf-*)", () => {
        assert.equal(usesVaultPrefixOnly(stubText), true);
      });

      it("passes pointer-only guards (no provider tools or ingestion-loop copy)", () => {
        assert.equal(violatesPointerOnlyStubRules(stubText), false);
      });

      it("resolves all markdown links including heading anchors from commands/", () => {
        const broken = brokenMarkdownLinksWithAnchors(commandsDir, stubText);
        assert.deepEqual(broken, [], `${stubFileName} drift: ${broken.join("; ")}`);
      });
    });
  }

  it("okv-ingest.md links to ingest-wizard.md and SKILL.md#ingest", () => {
    const stubText = readStub("okv-ingest.md");
    assert.match(stubText, /ingest-wizard\.md/);
    assert.match(stubText, /SKILL\.md#ingest/);
    assert.equal(resolveMarkdownAnchor(skillText, "ingest"), true);
    assert.ok(existsSync(ingestWizardPath));
  });

  for (const stubFileName of PHASE_1B_MODE_COMMAND_STUBS) {
    it(`${stubFileName} links to SKILL.md#${MODE_STUB_SKILL_ANCHORS[stubFileName]}`, () => {
      const stubText = readStub(stubFileName);
      const anchor = MODE_STUB_SKILL_ANCHORS[stubFileName];
      assert.equal(linksToSkillModeAnchor(stubText, anchor), true);
      assert.equal(resolveMarkdownAnchor(skillText, anchor), true);
      assert.doesNotMatch(stubText, /ingest-wizard\.md/);
    });
  }

  for (const stubFileName of PHASE_1B_PIPELINE_COMMAND_STUBS) {
    it(`${stubFileName} links to pipelines.md section anchor`, () => {
      const stubText = readStub(stubFileName);
      const sectionAnchor = PIPELINE_STUB_SECTION_ANCHORS[stubFileName];
      assert.equal(linksToPipelineSection(stubText, sectionAnchor), true);
      assert.equal(resolveMarkdownAnchor(pipelinesText, sectionAnchor), true);
    });
  }

  it("okv-ingest-check.md also links to ingest-wizard.md", () => {
    const stubText = readStub("okv-ingest-check.md");
    assert.match(stubText, /ingest-wizard\.md/);
  });
});

describe("F8 registry completeness (integration)", () => {
  it("registry.md lists exactly seven /okv-* commands matching on-disk stubs", () => {
    const stubs = listCommandStubs(commandsDir);
    const rows = parseRegistryCommandRows(registryText);

    assert.equal(stubs.length, 7);
    assert.equal(rows.size, 7);
    assert.deepEqual([...rows.keys()].sort(), [...OKV_COMMANDS].sort());

    for (const command of OKV_COMMANDS) {
      assert.ok(rows.has(command), `registry missing /${command}`);
      assert.ok(stubs.includes(`${command}.md`), `missing stub for /${command}`);
    }
  });

  it("registry.md uses /okv-* naming only (zero /okf-* references)", () => {
    assert.equal(usesVaultPrefixOnly(registryText), true);
    assert.doesNotMatch(registryText, /\/okf-/i);
  });

  it("canonical commands directory contains no old vault-* stub paths", () => {
    const oldStubs = readdirSync(commandsDir).filter(
      (entry) => entry.startsWith("vault-") && entry.endsWith(".md"),
    );
    assert.deepEqual(oldStubs, []);
  });

  it("each registry row links to its on-disk stub file", () => {
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
      assert.match(registryText, new RegExp(`\\]\\(${stubFileName}\\)`));
    }
  });
});

describe("F8 runtime adapter symlink paths (integration)", () => {
  it("Cursor and Claude adapter paths exist for all seven command stubs", () => {
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
      for (const runtimeDir of [cursorDir, claudeDir]) {
        const adapterPath = join(runtimeDir, stubFileName);
        assert.ok(existsSync(adapterPath), `missing ${adapterPath}`);
      }
    }
  });

  it("all seven stubs resolve through Cursor and Claude adapter trees to canonical stubs", () => {
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
      const cursorResult = assertAdapterStubResolves(cursorDir, commandsDir, stubFileName);
      assert.equal(cursorResult.ok, true, cursorResult.ok ? "" : cursorResult.message);
      const claudeResult = assertAdapterStubResolves(claudeDir, commandsDir, stubFileName);
      assert.equal(claudeResult.ok, true, claudeResult.ok ? "" : claudeResult.message);
    }
  });

  it("runtime-visible stub headings match /okv-* slash command names", () => {
    for (const command of OKV_COMMANDS) {
      const stubFileName = `${command}.md`;
      for (const runtimeDir of [cursorDir, claudeDir]) {
        const heading = readFileSync(join(runtimeDir, stubFileName), "utf8")
          .split("\n")
          .find((line) => line.startsWith("#"));
        assert.match(heading ?? "", new RegExp(`/${command}`));
      }
    }
  });
});

describe("F8 drift failure simulation (integration)", () => {
  it("detects registry/stub count mismatch when a stub is absent from the canonical set", () => {
    const stubs = listCommandStubs(commandsDir);
    const rows = parseRegistryCommandRows(registryText);
    const simulatedMissingStub = stubs.filter((name) => name !== "okv-init.md");
    assert.notEqual(simulatedMissingStub.length, rows.size);
  });

  it("detects anchor drift when pipelines.md section is renamed in a synthetic stub", () => {
    const driftStub =
      "# /okv-bootstrap\n\nSee [pipelines](../references/pipelines.md#bootstrap-renamed).";
    const broken = brokenMarkdownLinksWithAnchors(commandsDir, driftStub);
    assert.equal(broken.length, 1);
    assert.equal(resolveMarkdownAnchor(pipelinesText, "bootstrap-renamed"), false);
  });

  it("detects ingest-wizard drift when wizard contract link target is missing", () => {
    const driftStub = "# /okv-ingest\n\nSee [wizard](../references/ingest-wizard-removed.md).";
    const broken = brokenMarkdownLinksWithAnchors(commandsDir, driftStub);
    assert.equal(broken.length, 1);
    assert.match(broken[0], /ingest-wizard-removed/);
  });

  it("canonical seven-stub contract passes full F8 linkage gate", () => {
    const stubs = listCommandStubs(commandsDir);
    assert.equal(stubs.length, 7);

    for (const stubFileName of stubs) {
      const stubText = readStub(stubFileName);
      assert.equal(usesVaultPrefixOnly(stubText), true);
      assert.equal(violatesPointerOnlyStubRules(stubText), false);
      const broken = brokenMarkdownLinksWithAnchors(commandsDir, stubText);
      assert.deepEqual(broken, [], `${stubFileName}: ${broken.join("; ")}`);
    }

    const rows = parseRegistryCommandRows(registryText);
    assert.equal(rows.size, stubs.length);

    for (const stubFileName of stubs) {
      for (const runtimeDir of [cursorDir, claudeDir]) {
        const result = assertAdapterStubResolves(runtimeDir, commandsDir, stubFileName);
        assert.equal(result.ok, true, result.ok ? "" : result.message);
      }
    }
  });
});
