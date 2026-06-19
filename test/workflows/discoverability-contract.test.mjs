import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VAULT_COMMANDS,
  SKILL_MODES,
  PIPELINE_COMMANDS,
  skillRoot,
  usesVaultPrefixOnly,
  extractVaultCommandSlugs,
  parseRegistryCommandRows,
  documentsIngestFirstRouting,
  documentsVaultSetupRouting,
  documentsSkillModeTriggers,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const agentsPath = join(root, "AGENTS.md");
const skillPath = join(skillDir, "SKILL.md");
const registryPath = join(skillDir, "commands", "registry.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");

/**
 * @param {string} markdown
 * @returns {string}
 */
function extractYamlDescription(markdown) {
  const match = markdown.match(/^---\n[\s\S]*?description:\s*>-?\n([\s\S]*?)\n---/);
  assert.ok(match, "SKILL.md frontmatter description missing");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}

/**
 * @param {string} markdown
 * @param {string} linkTarget
 * @returns {boolean}
 */
function agentsLinkResolves(markdown, linkTarget) {
  const pattern = new RegExp(`\\]\\(${linkTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`);
  return pattern.test(markdown);
}

describe("discoverability contract (unit)", () => {
  const agentsText = readFileSync(agentsPath, "utf8");
  const skillText = readFileSync(skillPath, "utf8");
  const registryText = readFileSync(registryPath, "utf8");
  const frontmatterDescription = extractYamlDescription(skillText);

  it("AGENTS.md recommends /vault-ingest as entry for new content", () => {
    assert.equal(documentsIngestFirstRouting(agentsText), true);
    assert.match(agentsText, /\/vault-ingest/);
    assert.match(agentsText.toLowerCase(), /recommended|new content|starting point/);
  });

  it("AGENTS.md decision tree routes new vault setup to /vault-init and /vault-bootstrap at ./knowledge/", () => {
    assert.equal(documentsVaultSetupRouting(agentsText), true);
    assert.match(agentsText, /Choose the right command/i);
  });

  it("registry.md lists exactly seven /vault-* commands with no /okf-* references", () => {
    const slugs = extractVaultCommandSlugs(registryText);
    assert.deepEqual(slugs, [...VAULT_COMMANDS].sort());
    assert.equal(usesVaultPrefixOnly(registryText), true);
    assert.doesNotMatch(registryText, /\/okf-/i);
  });

  it("SKILL.md frontmatter includes trigger phrases for ingest wizard and other modes", () => {
    assert.equal(documentsSkillModeTriggers(frontmatterDescription), true);
    for (const command of VAULT_COMMANDS) {
      assert.match(frontmatterDescription, new RegExp(`/${command}`));
    }
    for (const mode of SKILL_MODES) {
      assert.match(skillText, new RegExp(`\`${mode}\``));
    }
  });

  it("AGENTS.md and SKILL.md reference ingest-wizard.md in contract tables", () => {
    assert.match(agentsText, /ingest-wizard\.md/);
    assert.match(skillText, /ingest-wizard\.md/);
  });

  it("AGENTS.md cross-links commands/registry.md", () => {
    assert.match(agentsText, /commands\/registry\.md/);
  });
});

describe("discoverability contract (integration)", () => {
  const registryText = readFileSync(registryPath, "utf8");
  const skillText = readFileSync(skillPath, "utf8");
  const agentsText = readFileSync(agentsPath, "utf8");
  const rows = parseRegistryCommandRows(registryText);

  it("every registry command maps to a documented skill mode or pipeline placeholder", () => {
    assert.equal(rows.size, VAULT_COMMANDS.length);

    for (const command of VAULT_COMMANDS) {
      const row = rows.get(command);
      assert.ok(row, `missing registry row for ${command}`);

      if (PIPELINE_COMMANDS.includes(command)) {
        assert.match(row.mode, /pipelines\.md/i);
        assert.match(registryText, /pipelines\.md/);
      } else if (command === "vault-ingest") {
        assert.match(row.mode, /ingest-wizard\.md/i);
        assert.match(registryText, /ingest-wizard\.md/);
      } else {
        const mode = command.replace("vault-", "");
        const skillMode = mode === "init" ? "initialize" : mode;
        assert.ok(SKILL_MODES.includes(skillMode), `unknown mode for ${command}`);
        assert.match(row.mode, new RegExp(skillMode, "i"));
        assert.match(row.mode, /SKILL\.md/i);
        assert.match(skillText, new RegExp(`### ${skillMode}`, "i"));
      }
    }
  });

  it("registry availability labels distinguish MVP shipped and Phase 1b shipped", () => {
    const ingestRow = rows.get("vault-ingest");
    assert.ok(ingestRow);
    assert.match(ingestRow.availability, /MVP/i);

    for (const command of [
      "vault-init",
      "vault-organize",
      "vault-validate",
      "vault-visualize",
      "vault-bootstrap",
      "vault-ingest-check",
    ]) {
      const row = rows.get(command);
      assert.ok(row);
      assert.match(row.availability, /Phase 1b/i);
      assert.match(row.availability, /shipped/i);
    }
  });

  it("ingest-wizard.md link in AGENTS.md resolves to an existing file", () => {
    const linkTarget = ".agents/skills/okf-knowledge-vault/references/ingest-wizard.md";
    assert.equal(agentsLinkResolves(agentsText, linkTarget), true);
    assert.ok(existsSync(ingestWizardPath));
    assert.ok(existsSync(resolve(root, linkTarget)));
  });

  it("registry.md relative links resolve under the skill directory", () => {
    const links = registryText.match(/\]\(([^)]+)\)/g) ?? [];
    assert.ok(links.length > 0);
    const registryDir = dirname(registryPath);

    for (const raw of links) {
      const target = raw.slice(2, -1);
      if (target.startsWith("http") || target.startsWith("#")) {
        continue;
      }
      const filePart = target.split("#")[0];
      if (!filePart) {
        continue;
      }
      const resolved = resolve(registryDir, filePart);
      assert.ok(existsSync(resolved), `Broken registry link "${target}" → ${resolved}`);
    }
  });
});
