import { readFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OKV_COMMANDS,
  SKILL_MODES,
  PIPELINE_COMMANDS,
  skillRoot,
  usesVaultPrefixOnly,
  extractVaultCommandSlugs,
  parseRegistryCommandRows,
  documentsIngestFirstRouting,
  documentsVaultSetupRouting,
  documentsRepoRootInit,
  documentsSkillModeTriggers,
  documentsYoutubeIngestMvp,
  documentsYoutubeTranscriptFallback,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const skillDir = skillRoot(root);
const agentsPath = join(root, "AGENTS.md");
const readmePath = join(root, "README.md");
const skillPath = join(skillDir, "SKILL.md");
const registryPath = join(skillDir, "commands", "registry.md");
const ingestStubPath = join(skillDir, "commands", "okv-ingest.md");
const ingestWizardPath = join(skillDir, "references", "ingest-wizard.md");
const packageJsonPath = join(root, "package.json");
const oldCanonicalPathPattern = /\.agents\/skills\/okf-knowledge-vault/g;
const allowedOldCanonicalPathFiles = new Set([
  join("scripts", "managed-artifacts.mjs"),
  join("test", "workflows", "managed-artifacts.test.mjs"),
]);
const scanExclusions = new Set([
  ".git",
  ".compozy",
  "coverage",
  "dist",
  "dist-test",
  "node_modules",
]);

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

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (scanExclusions.has(entry)) {
      continue;
    }
    const path = join(dir, entry);
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      files.push(...listFiles(path));
    } else if (stats.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/**
 * @param {string} markdown
 * @returns {string[]}
 */
function extractMarkdownLinkTargets(markdown) {
  const targets = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    targets.push(match[1]);
  }
  return targets;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isExternalOrAnchorOnly(target) {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#")
  );
}

describe("discoverability contract (unit)", () => {
  const agentsText = readFileSync(agentsPath, "utf8");
  const skillText = readFileSync(skillPath, "utf8");
  const registryText = readFileSync(registryPath, "utf8");
  const frontmatterDescription = extractYamlDescription(skillText);

  it("skillRoot resolves to the canonical okf-vault skill", () => {
    assert.equal(skillDir, join(root, ".agents", "skills", "okf-vault"));
    assert.ok(existsSync(skillPath));
  });

  it("AGENTS.md recommends /okv-ingest as entry for new content", () => {
    assert.equal(documentsIngestFirstRouting(agentsText), true);
    assert.match(agentsText, /\/okv-ingest/);
    assert.match(agentsText.toLowerCase(), /recommended|new content|starting point/);
  });

  it("AGENTS.md decision tree routes new vault setup to /okv-init and /okv-bootstrap at ./knowledge/", () => {
    assert.equal(documentsVaultSetupRouting(agentsText), true);
    assert.match(agentsText, /Choose the right command/i);
  });

  it("registry.md lists exactly eight /okv-* commands with no /okf-* references", () => {
    const slugs = extractVaultCommandSlugs(registryText);
    assert.deepEqual(slugs, [...OKV_COMMANDS].sort());
    assert.equal(usesVaultPrefixOnly(registryText), true);
    assert.doesNotMatch(registryText, /\/okf-/i);
  });

  it("SKILL.md frontmatter includes trigger phrases for ingest wizard and other modes", () => {
    assert.equal(documentsSkillModeTriggers(frontmatterDescription), true);
    for (const command of OKV_COMMANDS) {
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

  it("package format:check checks the okf-vault skill tree", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const formatCheck = packageJson.scripts["format:check"];
    assert.match(formatCheck, /\.agents\/skills\/okf-vault/);
    assert.doesNotMatch(formatCheck, /\.agents\/skills\/okf-knowledge-vault/);
  });
});

describe("README discoverability contract (unit)", () => {
  const readmeText = readFileSync(readmePath, "utf8");

  it("README recommends /okv-ingest as entry for new content", () => {
    assert.equal(documentsIngestFirstRouting(readmeText), true);
    assert.match(readmeText, /\/okv-ingest/);
    assert.match(readmeText.toLowerCase(), /start here|recommended|new content/);
  });

  it("README lists all seven /okv-* commands", () => {
    for (const command of OKV_COMMANDS) {
      assert.match(readmeText, new RegExp(`/${command}`), `missing /${command} in README`);
    }
  });

  it("README documents pnpm run setup", () => {
    assert.match(readmeText, /pnpm run setup/);
  });

  it("README documents repo-root okf-vault init workflow", () => {
    assert.equal(documentsRepoRootInit(readmeText), true);
    assert.match(readmeText, /\bokf-vault init\b/);
    assert.match(readmeText, /setup:link/);
  });

  it("README mentions both Cursor and Claude Code", () => {
    assert.match(readmeText, /Cursor/i);
    assert.match(readmeText, /Claude Code/i);
  });

  it("README links to commands/registry.md", () => {
    assert.match(readmeText, /commands\/registry\.md/);
  });
});

describe("YouTube curator-facing docs contract (unit)", () => {
  const agentsText = readFileSync(agentsPath, "utf8");
  const readmeText = readFileSync(readmePath, "utf8");
  const registryText = readFileSync(registryPath, "utf8");
  const ingestStubText = readFileSync(ingestStubPath, "utf8");

  it("AGENTS.md describes YouTube as a transcript-dependent MVP in /okv-ingest guidance", () => {
    assert.equal(documentsYoutubeIngestMvp(agentsText), true);
    assert.match(agentsText, /YouTube link/i);
    assert.match(agentsText, /ingest-wizard\.md/);
  });

  it("AGENTS.md documents fallback when a usable YouTube transcript is unavailable", () => {
    assert.equal(documentsYoutubeTranscriptFallback(agentsText), true);
  });

  it("README describes YouTube as a transcript-dependent MVP path", () => {
    assert.equal(documentsYoutubeIngestMvp(readmeText), true);
    assert.match(readmeText, /YouTube link/i);
  });

  it("README documents fallback when no usable transcript is available", () => {
    assert.equal(documentsYoutubeTranscriptFallback(readmeText), true);
  });

  it("registry.md and okv-ingest.md use consistent YouTube MVP wording", () => {
    assert.equal(documentsYoutubeIngestMvp(registryText), true);
    assert.equal(documentsYoutubeIngestMvp(ingestStubText), true);
    assert.match(registryText, /YouTube URL/i);
    assert.match(ingestStubText, /YouTube URL/i);
    assert.match(registryText, /ingest-wizard\.md/);
    assert.match(ingestStubText, /ingest-wizard\.md/);
  });

  it("registry.md documents transcript-unavailable fallback expectations", () => {
    assert.equal(documentsYoutubeTranscriptFallback(registryText), true);
  });

  it("okv-ingest.md documents transcript-unavailable fallback expectations", () => {
    assert.equal(documentsYoutubeTranscriptFallback(ingestStubText), true);
  });
});

describe("discoverability contract (integration)", () => {
  const registryText = readFileSync(registryPath, "utf8");
  const skillText = readFileSync(skillPath, "utf8");
  const agentsText = readFileSync(agentsPath, "utf8");
  const rows = parseRegistryCommandRows(registryText);

  it("every registry command maps to a documented skill mode or pipeline placeholder", () => {
    assert.equal(rows.size, OKV_COMMANDS.length);

    for (const command of OKV_COMMANDS) {
      const row = rows.get(command);
      assert.ok(row, `missing registry row for ${command}`);

      if (PIPELINE_COMMANDS.includes(command)) {
        assert.match(row.mode, /pipelines\.md/i);
        assert.match(registryText, /pipelines\.md/);
      } else if (command === "okv-ingest") {
        assert.match(row.mode, /ingest-wizard\.md/i);
        assert.match(registryText, /ingest-wizard\.md/);
      } else {
        const mode = command.replace("okv-", "");
        const skillMode = mode === "init" ? "initialize" : mode;
        assert.ok(SKILL_MODES.includes(skillMode), `unknown mode for ${command}`);
        assert.match(row.mode, new RegExp(skillMode, "i"));
        assert.match(row.mode, /SKILL\.md/i);
        assert.match(skillText, new RegExp(`### ${skillMode}`, "i"));
      }
    }
  });

  it("registry availability labels distinguish MVP shipped and Phase 1b shipped", () => {
    const ingestRow = rows.get("okv-ingest");
    assert.ok(ingestRow);
    assert.match(ingestRow.availability, /MVP/i);

    for (const command of [
      "okv-init",
      "okv-organize",
      "okv-validate",
      "okv-visualize",
      "okv-bootstrap",
      "okv-ingest-check",
    ]) {
      const row = rows.get(command);
      assert.ok(row);
      assert.match(row.availability, /Phase 1b/i);
      assert.match(row.availability, /shipped/i);
    }
  });

  it("ingest-wizard.md link in AGENTS.md resolves to an existing file", () => {
    const linkTarget = ".agents/skills/okf-vault/references/ingest-wizard.md";
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

  it("all relative markdown links resolve inside the canonical skill tree", () => {
    const markdownFiles = listFiles(skillDir).filter((file) => extname(file) === ".md");
    assert.ok(markdownFiles.length > 0);

    for (const markdownFile of markdownFiles) {
      const markdown = readFileSync(markdownFile, "utf8");
      const markdownDir = dirname(markdownFile);
      for (const target of extractMarkdownLinkTargets(markdown)) {
        if (isExternalOrAnchorOnly(target)) {
          continue;
        }
        const filePart = target.split("#")[0];
        if (!filePart) {
          continue;
        }
        const resolved = resolve(markdownDir, filePart);
        assert.ok(
          existsSync(resolved),
          `Broken link in ${relative(root, markdownFile)}: "${target}" → ${resolved}`,
        );
      }
    }
  });

  it("does not reintroduce the old canonical skill path outside legacy manifest coverage", () => {
    const offenders = [];
    for (const file of listFiles(root)) {
      const relativePath = relative(root, file);
      if (allowedOldCanonicalPathFiles.has(relativePath)) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (oldCanonicalPathPattern.test(text)) {
        offenders.push(relativePath);
      }
      oldCanonicalPathPattern.lastIndex = 0;
    }
    assert.deepEqual(offenders, []);
  });
});
