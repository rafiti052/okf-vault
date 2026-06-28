import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_COMMANDS,
  PIPELINE_MODE_SEQUENCES,
  PIPELINE_NAMES,
  assertPipelineSections,
  brokenMarkdownLinks,
  containsIngestionLoopPhaseOrder,
  documentsBootstrapVaultResolution,
  documentsFreshValidateRunId,
  documentsIngestCheckHardPause,
  documentsIngestCheckValidateSuggestion,
  documentsIngestCheckWizardReuse,
  documentsPipelineRunIdPairs,
  parsePipelineRegistrySectionLinks,
  referencesSkillModeEntries,
  skillRoot,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const pipelinesPath = join(skillDir, "references", "pipelines.md");
const registryPath = join(skillDir, "commands", "registry.md");
const skillPath = join(skillDir, "SKILL.md");
const referencesDir = join(skillDir, "references");

describe("pipelines contract (unit)", () => {
  const text = readFileSync(pipelinesPath, "utf8");

  it("pipelines.md contains sections named bootstrap and ingest-check", () => {
    assert.equal(assertPipelineSections(text), true);
    for (const name of PIPELINE_NAMES) {
      assert.match(text, new RegExp(`##\\s+${name}\\b`, "i"));
    }
  });

  it("detects missing pipeline section in synthetic markdown", () => {
    const broken = text.replace(/## ingest-check/i, "## removed-pipeline");
    assert.equal(assertPipelineSections(broken), false);
  });

  it("defines exactly two pipelines in the overview table", () => {
    assert.deepEqual(PIPELINE_NAMES, ["bootstrap", "ingest-check"]);
    for (const name of PIPELINE_NAMES) {
      assert.match(text, new RegExp(`\\*\\*${name}\\*\\*`, "i"));
    }
  });

  it("each pipeline section references SKILL.md mode entries without duplicating phase order", () => {
    for (const [pipeline, modes] of Object.entries(PIPELINE_MODE_SEQUENCES)) {
      assert.equal(referencesSkillModeEntries(text, pipeline, modes), true);
      const sectionStart = text.indexOf(`## ${pipeline}`);
      const sectionEnd = text.indexOf("\n## ", sectionStart + 1);
      const section =
        sectionEnd >= 0 ? text.slice(sectionStart, sectionEnd) : text.slice(sectionStart);
      assert.equal(containsIngestionLoopPhaseOrder(section), false);
      assert.match(section, /do not.*restate|do not.*duplicate|do not.*restat/i);
    }
  });

  it("ingest-check documents hard pause before validate on skip or abort outcomes", () => {
    assert.equal(documentsIngestCheckHardPause(text), true);
    const ingestSection = text.slice(text.indexOf("## ingest-check"));
    assert.match(ingestSection, /hard pause/i);
    assert.match(ingestSection, /skipped/i);
    assert.match(ingestSection, /aborted/i);
    assert.match(ingestSection, /do \*\*not\*\* auto-validate/i);
  });

  it("ingest-check documents auto-suggest validate on full success with curator confirmation", () => {
    assert.equal(documentsIngestCheckValidateSuggestion(text), true);
    const ingestSection = text.slice(text.indexOf("## ingest-check"));
    assert.match(ingestSection, /full success/i);
    assert.match(ingestSection, /auto-suggest/i);
    assert.match(ingestSection, /confirms|confirm/i);
    assert.match(ingestSection, /opts out|opt out/i);
  });

  it("both pipelines document separate run_started and run_completed per mode leg", () => {
    for (const pipeline of PIPELINE_NAMES) {
      assert.equal(documentsPipelineRunIdPairs(text, pipeline), true);
    }
  });

  it("bootstrap confirms vault path resolution at ./knowledge/ and routes not_initialized to /okv-init", () => {
    assert.equal(documentsBootstrapVaultResolution(text), true);
    const bootstrapSection = text.slice(text.indexOf("## bootstrap"));
    assert.match(bootstrapSection, /\.\/knowledge\//);
    assert.match(bootstrapSection, /`not_initialized`/);
    assert.match(bootstrapSection, /\/okv-init/);
  });

  it("ingest-check reuses ingest-wizard.md acquisition through delegate_ingest", () => {
    assert.equal(documentsIngestCheckWizardReuse(text), true);
  });

  it("documents fresh run_id for validate legs with ingest run_id correlation", () => {
    assert.equal(documentsFreshValidateRunId(text), true);
    assert.match(text, /last_run_id/i);
  });

  it("helper functions reject broken synthetic pipeline markdown", () => {
    const broken = "## bootstrap\nno skill reference\nrun_started only";
    assert.equal(
      referencesSkillModeEntries(broken, "bootstrap", ["initialize", "validate"]),
      false,
    );
    assert.equal(documentsPipelineRunIdPairs(broken, "bootstrap"), false);
    assert.equal(documentsBootstrapVaultResolution(broken), false);
  });
});

describe("pipelines contract (integration)", () => {
  const pipelinesText = readFileSync(pipelinesPath, "utf8");
  const registryText = readFileSync(registryPath, "utf8");
  const skillText = readFileSync(skillPath, "utf8");

  it("all links in pipelines.md resolve to existing skill reference files", () => {
    const broken = brokenMarkdownLinks(referencesDir, pipelinesText);
    assert.deepEqual(broken, [], `Broken links: ${broken.join(", ")}`);
  });

  it("pipelines.md SKILL.md links target existing mode headings", () => {
    for (const modes of Object.values(PIPELINE_MODE_SEQUENCES)) {
      for (const mode of modes) {
        assert.match(skillText, new RegExp(`### ${mode}\\b`, "i"));
      }
    }
  });

  it("registry.md maps vault-bootstrap and vault-ingest-check to pipelines.md sections", () => {
    const links = parsePipelineRegistrySectionLinks(registryText);
    assert.equal(links.size, PIPELINE_COMMANDS.length);

    assert.equal(links.get("okv-bootstrap"), "bootstrap");
    assert.equal(links.get("okv-ingest-check"), "ingest-check");

    for (const command of PIPELINE_COMMANDS) {
      const section = links.get(command);
      assert.ok(section, `missing pipeline section link for ${command}`);
      assert.match(registryText, new RegExp(`pipelines\\.md[^\\n]*${section}`, "i"));
      assert.match(pipelinesText, new RegExp(`##\\s+${section}\\b`, "i"));
    }
  });

  it("registry pipelines.md links resolve to the pipelines contract file", () => {
    const registryDir = dirname(registryPath);
    const target = resolve(registryDir, "../references/pipelines.md");
    assert.ok(existsSync(target));
    assert.ok(registryText.includes("pipelines.md"));
  });
});

describe("pipelines contract helpers (unit)", () => {
  const sampleBootstrap = `
## bootstrap
See SKILL.md initialize and validate modes.
run_started and run_completed per leg.
./knowledge/ with not_initialized routes to /okv-init.
fresh run_id for validate.
`;

  const sampleIngestCheck = `
## ingest-check
Reuse ingest-wizard.md through delegate_ingest.
Full success auto-suggest validate; curator confirms or opts out.
Hard pause on skipped or aborted — do not auto-validate.
run_started and run_completed for each leg.
fresh \`run_id\` for validate leg.
`;

  it("assertPipelineSections accepts well-formed pipeline headings", () => {
    const text = `${sampleBootstrap}\n${sampleIngestCheck}`;
    assert.equal(assertPipelineSections(text), true);
  });

  it("referencesSkillModeEntries validates mode names and SKILL.md presence", () => {
    assert.equal(
      referencesSkillModeEntries(sampleBootstrap, "bootstrap", ["initialize", "validate"]),
      true,
    );
    assert.equal(referencesSkillModeEntries(sampleBootstrap, "bootstrap", ["ingest"]), false);
  });

  it("parsePipelineRegistrySectionLinks extracts section names from registry rows", () => {
    const registryText = readFileSync(registryPath, "utf8");
    const links = parsePipelineRegistrySectionLinks(registryText);
    assert.equal(links.get("okv-bootstrap"), "bootstrap");
    assert.equal(links.get("okv-ingest-check"), "ingest-check");
  });
});
