#!/usr/bin/env node
/**
 * Recreate runtime adapter symlinks when Git checks out symlink paths as plain files
 * (common on Windows with core.symlinks=false). Idempotent — skips existing valid links.
 *
 * Emits, per project:
 * - Umbrella skill symlinks (`/okf-vault` auto-applies):
 *   `.cursor/skills/okf-vault` and `.claude/skills/okf-vault` → canonical skill.
 * - Per-command discoverable units so every `/okv-*` shows up individually:
 *   Cursor `.cursor/skills/<cmd>/SKILL.md` and Claude `.claude/commands/<cmd>.md` → canonical `commands/<cmd>.md`.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { OKV_COMMANDS } from "./managed-artifacts.mjs";

export { OKV_COMMANDS };

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * True when `candidate` is the same path as, or nested under, `root`.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves a symlink to its real target without throwing on broken links.
 * @param {string} linkPath
 * @returns {string | null}
 */
function safeRealpath(linkPath) {
  try {
    return realpathSync(linkPath);
  } catch {
    return null;
  }
}

/**
 * @param {string} linkPath
 * @param {string} canonicalPath absolute path the link must resolve to
 * @returns {boolean}
 */
function isValidSymlink(linkPath, canonicalPath) {
  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) {
    return false;
  }
  const resolvedLink = safeRealpath(linkPath);
  const resolvedCanonical = safeRealpath(canonicalPath);
  return resolvedLink !== null && resolvedCanonical !== null && resolvedLink === resolvedCanonical;
}

/**
 * Computes the symlink target string for a link pointing at a canonical path.
 * Uses a relative target from the link's own directory when the canonical target stays inside the
 * project root; falls back to an absolute path when it escapes (foreign-repo `okf-vault init`).
 * @param {string} linkPath
 * @param {string} canonicalPath
 * @param {string} projectRoot
 * @returns {string}
 */
function computeSymlinkTarget(linkPath, canonicalPath, projectRoot) {
  const resolvedProject = resolve(projectRoot);
  const resolvedCanonical = resolve(canonicalPath);
  if (!isInsideRoot(resolvedProject, resolvedCanonical)) {
    return resolvedCanonical;
  }
  return relative(dirname(resolve(linkPath)), resolvedCanonical);
}

/**
 * Idempotently (re)creates one symlink at `linkPath` resolving to `canonicalPath`.
 * Handles both directory links (umbrella skills) and file links (`SKILL.md`, command files).
 * @param {{ linkPath: string; canonicalPath: string; label: string; projectRoot: string; quiet: boolean; linked: string[]; skipped: string[] }} params
 */
function ensureSymlink({ linkPath, canonicalPath, label, projectRoot, quiet, linked, skipped }) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (isValidSymlink(linkPath, canonicalPath)) {
    if (!quiet) {
      console.log(`ok: ${label} symlink already valid at ${linkPath}`);
    }
    skipped.push(linkPath);
    return;
  }
  rmSync(linkPath, { recursive: true, force: true });
  const target = computeSymlinkTarget(linkPath, canonicalPath, projectRoot);
  symlinkSync(target, linkPath);
  if (!quiet) {
    console.log(`linked: ${label} → ${target}`);
  }
  linked.push(linkPath);
}

/**
 * @param {{ projectRoot: string; canonicalSkillRoot: string; quiet?: boolean }} options
 * @returns {{ linked: string[]; skipped: string[] }}
 */
export function linkRuntimeAdapters({ projectRoot, canonicalSkillRoot, quiet = false }) {
  const resolvedProject = resolve(projectRoot);
  const resolvedCanonical = resolve(canonicalSkillRoot);
  const canonicalCommandsRoot = join(resolvedCanonical, "commands");
  const linked = [];
  const skipped = [];

  /** @type {Array<{ linkPath: string; canonicalPath: string; label: string }>} */
  const links = [
    {
      linkPath: join(resolvedProject, ".cursor", "skills", "okf-vault"),
      canonicalPath: resolvedCanonical,
      label: "Cursor skill",
    },
    {
      linkPath: join(resolvedProject, ".claude", "skills", "okf-vault"),
      canonicalPath: resolvedCanonical,
      label: "Claude skill",
    },
  ];

  for (const command of OKV_COMMANDS) {
    const canonicalStub = join(canonicalCommandsRoot, `${command}.md`);
    links.push({
      linkPath: join(resolvedProject, ".cursor", "skills", command, "SKILL.md"),
      canonicalPath: canonicalStub,
      label: `Cursor /${command}`,
    });
    links.push({
      linkPath: join(resolvedProject, ".claude", "commands", `${command}.md`),
      canonicalPath: canonicalStub,
      label: `Claude /${command}`,
    });
  }

  for (const { linkPath, canonicalPath, label } of links) {
    ensureSymlink({
      linkPath,
      canonicalPath,
      label,
      projectRoot: resolvedProject,
      quiet,
      linked,
      skipped,
    });
  }

  if (!quiet) {
    console.log(`Runtime adapter symlinks ready (${linked.length} linked, ${skipped.length} skipped).`);
  }

  return { linked, skipped };
}

function parseCliArgs(argv) {
  let projectRoot = defaultRoot;
  let canonicalSkillRoot = join(defaultRoot, ".agents", "skills", "okf-vault");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --project-root");
      }
      projectRoot = value;
      index += 1;
      continue;
    }
    if (arg === "--canonical-skill-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --canonical-skill-root");
      }
      canonicalSkillRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { projectRoot, canonicalSkillRoot };
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  try {
    const { projectRoot, canonicalSkillRoot } = parseCliArgs(process.argv.slice(2));
    linkRuntimeAdapters({ projectRoot, canonicalSkillRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    console.error("Usage: node scripts/link-runtime-adapters.mjs [--project-root <path>] [--canonical-skill-root <path>]");
    process.exit(1);
  }
}
