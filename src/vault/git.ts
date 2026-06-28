import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  GITIGNORE_ENTRY,
  GITIGNORE_PATH,
  INIT_STAGED_PATHS,
  MANAGED_CLEAN_PATHSPECS,
  REVIEWS_DIR,
  REVIEWS_GITKEEP,
  TMP_DIR,
} from "./constants.js";

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: readonly string[]): GitCommandResult {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function isGitRepository(vaultRoot: string): boolean {
  return existsSync(join(vaultRoot, ".git"));
}

export function initRepository(vaultRoot: string): boolean {
  if (isGitRepository(vaultRoot)) {
    return false;
  }
  const result = runGit(vaultRoot, ["init"]);
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  }
  return true;
}

export function ensureGitignore(vaultRoot: string): boolean {
  const gitignorePath = join(vaultRoot, GITIGNORE_PATH);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, "utf8");
    return true;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  if (!existing.split("\n").some((line) => line.trim() === GITIGNORE_ENTRY)) {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, `${existing}${suffix}${GITIGNORE_ENTRY}\n`, "utf8");
    return true;
  }
  return false;
}

export interface InitDirectoryResult {
  updated: boolean;
  filesCreated: string[];
}

function ensureDirectory(vaultRoot: string, relativePath: string): boolean {
  const fullPath = join(vaultRoot, relativePath);
  if (existsSync(fullPath)) {
    return false;
  }
  mkdirSync(fullPath, { recursive: true });
  return true;
}

export function ensureInitDirectories(vaultRoot: string): InitDirectoryResult {
  let updated = false;
  updated = ensureDirectory(vaultRoot, "notes") || updated;
  updated = ensureDirectory(vaultRoot, "topics") || updated;
  updated = ensureDirectory(vaultRoot, REVIEWS_DIR) || updated;
  updated = ensureDirectory(vaultRoot, TMP_DIR) || updated;

  const filesCreated: string[] = [];
  const gitkeepPath = join(vaultRoot, REVIEWS_GITKEEP);
  if (!existsSync(gitkeepPath)) {
    writeFileSync(gitkeepPath, "", "utf8");
    filesCreated.push(REVIEWS_GITKEEP);
    updated = true;
  }
  return { updated, filesCreated };
}

export interface InitCommitResult {
  committed: boolean;
  commit?: string;
}

export function commitInitializationBaseline(
  vaultRoot: string,
  paths: readonly string[] = INIT_STAGED_PATHS,
): InitCommitResult {
  if (paths.length === 0) {
    return { committed: false };
  }

  for (const pathspec of paths) {
    const add = runGit(vaultRoot, ["add", "--", pathspec]);
    if (add.status !== 0) {
      throw new Error(`git add failed for ${pathspec}: ${add.stderr || add.stdout}`);
    }
  }

  const diff = runGit(vaultRoot, ["diff", "--cached", "--quiet"]);
  if (diff.status === 0) {
    return { committed: false };
  }

  const commit = runGit(vaultRoot, ["commit", "-m", "okf-vault: initialize managed vault layout"]);
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  const rev = runGit(vaultRoot, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    throw new Error(`git rev-parse failed: ${rev.stderr || rev.stdout}`);
  }
  return { committed: true, commit: rev.stdout.trim() };
}

export interface ManagedPathStatus {
  clean: boolean;
  dirtyPaths: string[];
}

function parsePorcelainPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const path = line.slice(3).trim();
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

export function getManagedPathStatus(vaultRoot: string): ManagedPathStatus {
  const pathspecs = [...MANAGED_CLEAN_PATHSPECS];
  const indexStatus = runGit(vaultRoot, ["diff", "--cached", "--name-only", "--", ...pathspecs]);
  const worktreeStatus = runGit(vaultRoot, ["status", "--porcelain", "--", ...pathspecs]);
  const dirtyPaths = [
    ...new Set([
      ...parsePorcelainPaths(indexStatus.stdout),
      ...parsePorcelainPaths(worktreeStatus.stdout),
    ]),
  ].sort();
  return { clean: dirtyPaths.length === 0, dirtyPaths };
}

export function stageManagedPaths(vaultRoot: string, paths: readonly string[]): void {
  if (paths.length === 0) {
    return;
  }
  const add = runGit(vaultRoot, ["add", "--", ...paths]);
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  }
}

export function createCommit(vaultRoot: string, message: string): string {
  const commit = runGit(vaultRoot, ["commit", "-m", message]);
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  const rev = runGit(vaultRoot, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    throw new Error(`git rev-parse failed: ${rev.stderr || rev.stdout}`);
  }
  return rev.stdout.trim();
}

export function amendCommitNoEdit(vaultRoot: string): string {
  const amend = runGit(vaultRoot, ["commit", "--amend", "--no-edit"]);
  if (amend.status !== 0) {
    throw new Error(`git commit --amend failed: ${amend.stderr || amend.stdout}`);
  }
  const rev = runGit(vaultRoot, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    throw new Error(`git rev-parse failed: ${rev.stderr || rev.stdout}`);
  }
  return rev.stdout.trim();
}

export function getHeadCommit(vaultRoot: string): string {
  const rev = runGit(vaultRoot, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    throw new Error(`git rev-parse failed: ${rev.stderr || rev.stdout}`);
  }
  return rev.stdout.trim();
}

export function getCommitChangedPaths(vaultRoot: string, commit: string): string[] {
  const show = runGit(vaultRoot, ["show", "--name-only", "--pretty=format:", commit]);
  if (show.status !== 0) {
    throw new Error(`git show failed: ${show.stderr || show.stdout}`);
  }
  return show.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export function readManagedFileFromHead(
  vaultRoot: string,
  relativePath: string,
): string | undefined {
  const show = runGit(vaultRoot, ["show", `HEAD:${relativePath}`]);
  if (show.status !== 0) {
    return undefined;
  }
  return show.stdout;
}
