#!/usr/bin/env node
/**
 * Recreate runtime adapter symlinks when Git checks out symlink paths as plain files
 * (common on Windows with core.symlinks=false). Idempotent — skips existing valid links.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalSkill = join(root, ".agents", "skills", "okf-knowledge-vault");
const canonicalCommands = join(canonicalSkill, "commands");

const links = [
  {
    path: join(root, ".cursor", "skills", "okf-knowledge-vault", "commands"),
    target: relative(
      join(root, ".cursor", "skills", "okf-knowledge-vault"),
      canonicalCommands,
    ),
    label: "Cursor commands/",
  },
  {
    path: join(root, ".claude", "skills", "okf-knowledge-vault"),
    target: relative(join(root, ".claude", "skills"), canonicalSkill),
    label: "Claude skill",
  },
];

function isValidSymlink(linkPath, expectedTarget) {
  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) {
    return false;
  }
  try {
    const resolved = join(dirname(linkPath), expectedTarget);
    return existsSync(resolved);
  } catch {
    return false;
  }
}

for (const { path: linkPath, target, label } of links) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (isValidSymlink(linkPath, target)) {
    console.log(`ok: ${label} symlink already valid at ${linkPath}`);
    continue;
  }
  if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath);
  console.log(`linked: ${label} → ${target}`);
}

console.log("Runtime adapter symlinks ready.");
