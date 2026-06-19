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

export function initRepository(vaultRoot: string): void {
  if (isGitRepository(vaultRoot)) {
    return;
  }
  const result = runGit(vaultRoot, ["init"]);
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  }
}

export function ensureGitignore(vaultRoot: string): void {
  const gitignorePath = join(vaultRoot, GITIGNORE_PATH);
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, "utf8");
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  if (!existing.split("\n").some((line) => line.trim() === GITIGNORE_ENTRY)) {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, `${existing}${suffix}${GITIGNORE_ENTRY}\n`, "utf8");
  }
}

export function ensureInitDirectories(vaultRoot: string): void {
  mkdirSync(join(vaultRoot, "notes"), { recursive: true });
  mkdirSync(join(vaultRoot, "topics"), { recursive: true });
  mkdirSync(join(vaultRoot, REVIEWS_DIR), { recursive: true });
  mkdirSync(join(vaultRoot, TMP_DIR), { recursive: true });
  const gitkeepPath = join(vaultRoot, REVIEWS_GITKEEP);
  if (!existsSync(gitkeepPath)) {
    writeFileSync(gitkeepPath, "", "utf8");
  }
}

export interface InitCommitResult {
  committed: boolean;
  commit?: string;
}

export function commitInitializationBaseline(vaultRoot: string): InitCommitResult {
  for (const pathspec of INIT_STAGED_PATHS) {
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
