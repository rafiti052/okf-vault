import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  GITIGNORE_ENTRY,
  GITIGNORE_PATH,
  INIT_STAGED_PATHS,
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
