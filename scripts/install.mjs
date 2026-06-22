#!/usr/bin/env node
/**
 * Cross-platform setup: install deps, build helper CLI, link runtime adapters, verify, smoke test.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyRuntimeAdapters } from "../test/workflows/workflow-contract.mjs";
import { linkRuntimeAdapters } from "./link-runtime-adapters.mjs";
import { assertPnpmGlobalBinOnPath, PNPM_GLOBAL_LINK_ARGS } from "./pnpm-global-path.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const linkGlobal = args.includes("--link");
const filteredArgs = args.filter((arg) => arg !== "--link");

if (filteredArgs.length > 0) {
  console.error(`Unknown argument(s): ${filteredArgs.join(", ")}`);
  console.error("Usage: node scripts/install.mjs [--link]");
  process.exit(1);
}

function fail(message, hint) {
  console.error(`error: ${message}`);
  if (hint) {
    console.error(hint);
  }
  process.exit(1);
}

function runStep(label, command, commandArgs, options = {}) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status ?? "unknown"})`);
  }
}

function commandExists(name) {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [name], { stdio: "ignore", shell: true })
      : spawnSync("which", [name], { stdio: "ignore" });
  return probe.status === 0;
}

function checkNodeVersion() {
  const nvmrcPath = join(root, ".nvmrc");
  if (!existsSync(nvmrcPath)) {
    fail("Missing .nvmrc");
  }
  const recommendedMajor = Number.parseInt(
    readFileSync(nvmrcPath, "utf8").trim().split(".")[0],
    10,
  );
  const actualMajor = Number.parseInt(String(process.versions.node).split(".")[0], 10);
  if (Number.isNaN(recommendedMajor) || Number.isNaN(actualMajor)) {
    fail(`Could not determine Node major version (found ${process.version}).`);
  }
  if (actualMajor < recommendedMajor) {
    fail(
      `Node ${recommendedMajor}+ required (found ${process.version}). Use nvm or fnm to install Node ${recommendedMajor}.`,
    );
  }
  if (actualMajor > recommendedMajor) {
    console.warn(
      `[WARN] Node ${process.version} is newer than the tested range (Node ${recommendedMajor}.x from .nvmrc). Setup continues; report issues if they appear.`,
    );
  }
  console.log(`ok: Node ${process.version}`);
}

function checkPnpm() {
  if (commandExists("pnpm")) {
    console.log("ok: pnpm on PATH");
    return;
  }
  fail(
    "pnpm not found on PATH",
    "Hint: enable Corepack with `corepack enable`, then retry `pnpm run setup`.",
  );
}

function checkPnpmGlobalBinOnPath() {
  let check;
  try {
    check = assertPnpmGlobalBinOnPath();
  } catch (error) {
    fail(
      "could not resolve pnpm global bin directory",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!check.ok) {
    console.error(
      `[ERROR] The configured global bin directory "${check.globalBinDir}" is not in PATH`,
    );
    fail("pnpm global bin directory is not on PATH", check.message);
  }
  console.log(`ok: pnpm global bin on PATH (${check.globalBinDir})`);
}

console.log("OKF Knowledge Vault setup\n");

checkNodeVersion();
checkPnpm();

runStep("Installing dependencies", "pnpm", ["install"]);
runStep("Building helper CLI", "pnpm", ["run", "build"]);

console.log("\n→ Installing runtime adapters");
linkRuntimeAdapters({
  projectRoot: root,
  canonicalSkillRoot: join(root, ".agents", "skills", "okf-vault"),
});

const adapterCheck = verifyRuntimeAdapters(root);
if (!adapterCheck.ok) {
  fail(
    adapterCheck.message,
    "Remediation: ensure Git symlink support (`git config core.symlinks true`), then re-run `pnpm run setup`.",
  );
}
console.log("ok: Cursor and Claude runtime adapters verified");

runStep("Smoke test helper CLI", "node", ["dist/main.js", "--version"]);

if (linkGlobal) {
  checkPnpmGlobalBinOnPath();
  runStep("Linking okf-vault globally", "pnpm", PNPM_GLOBAL_LINK_ARGS);

  if (!commandExists("okf-vault")) {
    const postLinkCheck = assertPnpmGlobalBinOnPath();
    fail(
      "okf-vault not found on PATH after global link",
      postLinkCheck.ok
        ? "Hint: restart your shell, then retry `pnpm run setup:link`."
        : postLinkCheck.message,
    );
  }

  runStep("Smoke test global binary", "okf-vault", ["--version"]);
}

const cliHelp = linkGlobal ? "okf-vault --help" : "node dist/main.js --help";

if (!linkGlobal) {
  console.warn(
    "\n[WARN] Setup completed without global link. Cross-project use requires `pnpm run setup:link`.",
  );
}

console.log(`
Setup complete.

Each \`/vault-*\` command is now installed as an individual slash entry in both runtimes
(Cursor: \`.cursor/skills/<cmd>/SKILL.md\`; Claude: \`.claude/commands/<cmd>.md\`).
Reload the editor window after the first install so the new commands appear.

## Cursor
Open this repo in Cursor and type \`/vault-ingest\` (or any \`/vault-*\`).
Project rule auto-applies from \`.cursor/rules/okf-vault.mdc\`.

## Claude Code
Open this repo in Claude Code. Skill at \`.claude/skills/okf-vault\`; type \`/vault-ingest\`.

## Helper CLI
Run \`${cliHelp}\` for deterministic validation, manifest, graph, and Git commands.

Recommended first command: \`/vault-ingest\`.
New vault at \`./knowledge/\`: \`/vault-bootstrap\` or \`/vault-init\`.
Full slash-command list: .agents/skills/okf-vault/commands/registry.md
`);
