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
  extractMarkdownLinks,
  brokenMarkdownLinks,
  INGESTION_LOOP_HAPPY_PATH_EVENTS,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const stubPath = join(skillDir, "commands", "okv-ingest.md");
const registryPath = join(skillDir, "commands", "registry.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const skillPath = join(skillDir, "SKILL.md");

describe("okv-ingest stub helpers (unit)", () => {
  it("containsIngestionLoopPhaseOrder detects happy-path event sequences", () => {
    const violation = INGESTION_LOOP_HAPPY_PATH_EVENTS.slice(0, 3).join(" then ");
    assert.equal(containsIngestionLoopPhaseOrder(violation), true);
    assert.equal(containsIngestionLoopPhaseOrder("acquire → inspect → convert"), true);
    assert.equal(containsIngestionLoopPhaseOrder("pointer to ingest-wizard.md only"), false);
  });

  it("extractMarkdownLinks and brokenMarkdownLinks resolve relative paths from base dir", () => {
    const sample = "[wizard](../references/ingest-wizard.md) [skill](../SKILL.md#ingest)";
    const links = extractMarkdownLinks(sample);
    assert.deepEqual(links, ["../references/ingest-wizard.md", "../SKILL.md#ingest"]);
    assert.deepEqual(brokenMarkdownLinks(join(skillDir, "commands"), sample), []);
    assert.deepEqual(brokenMarkdownLinks(join(skillDir, "commands"), "[missing](missing.md)"), [
      "missing.md",
    ]);
  });

  it("registryLinksToStub matches markdown link targets", () => {
    assert.equal(registryLinksToStub("[`/okv-ingest`](okv-ingest.md)", "okv-ingest.md"), true);
    assert.equal(registryLinksToStub("okv-ingest.md without link syntax", "okv-ingest.md"), false);
  });

  it("documentsDisableModelInvocationGuidance detects runtime adapter note", () => {
    assert.equal(
      documentsDisableModelInvocationGuidance("set disable-model-invocation: true"),
      true,
    );
    assert.equal(documentsDisableModelInvocationGuidance("no adapter guidance"), false);
  });
});

describe("okv-ingest stub contract (unit)", () => {
  const stubText = readFileSync(stubPath, "utf8");
  const firstHeading = stubText.split("\n").find((line) => line.startsWith("#"));

  it("okv-ingest.md exists at the canonical skill commands path", () => {
    assert.ok(existsSync(stubPath));
  });

  it("first heading references /okv-ingest and not /okf-ingest", () => {
    assert.ok(firstHeading);
    assert.match(firstHeading, /\/okv-ingest/);
    assert.equal(usesVaultPrefixOnly(stubText), true);
    assert.doesNotMatch(stubText, /\/okf-ingest/i);
  });

  it("stub links to ingest-wizard.md and SKILL.md ingest section", () => {
    assert.match(stubText, /ingest-wizard\.md/);
    assert.match(stubText, /SKILL\.md#ingest/);
    assert.match(stubText, /registry\.md/);
  });

  it("stub is pointer-only: no ingestion-loop happy-path phase order", () => {
    assert.equal(containsIngestionLoopPhaseOrder(stubText), false);
  });

  it("stub contains no provider tool name patterns", () => {
    assert.equal(PROVIDER_TOOL_PATTERN.test(stubText), false);
  });

  it("stub notes disable-model-invocation guidance for runtime adapters", () => {
    assert.equal(documentsDisableModelInvocationGuidance(stubText), true);
  });

  it("stub stays under 30 lines", () => {
    const lines = stubText.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length <= 30, `stub has ${lines.length} non-empty lines`);
  });
});

describe("okv-ingest stub contract (integration)", () => {
  const stubText = readFileSync(stubPath, "utf8");
  const registryText = readFileSync(registryPath, "utf8");
  const rows = parseRegistryCommandRows(registryText);
  const stubDir = dirname(stubPath);

  it("registry.md links to okv-ingest.md with MVP-shipped availability label", () => {
    assert.equal(registryLinksToStub(registryText, "okv-ingest.md"), true);
    const ingestRow = rows.get("okv-ingest");
    assert.ok(ingestRow);
    assert.match(ingestRow.availability, /MVP/i);
    assert.match(registryText, /MVP shipped/);
  });

  it("all markdown links in stub resolve to existing files relative to commands/", () => {
    const broken = brokenMarkdownLinks(stubDir, stubText);
    assert.deepEqual(broken, []);
    assert.ok(existsSync(ingestWizardPath));
    assert.ok(existsSync(skillPath));
    assert.ok(existsSync(registryPath));
  });
});
