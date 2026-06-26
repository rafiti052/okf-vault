import * as fs from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import {
  MANIFEST_RELATIVE_PATH,
  MANIFEST_SCHEMA_VERSION,
  ROOT_INDEX_PATH,
  LOG_PATH,
  NOTES_INDEX_PATH,
  TOPICS_INDEX_PATH,
} from "./constants.js";

export interface DiagnosticCheckResult {
  code: string;
  status: "pass" | "warn" | "fail";
  message: string;
  path?: string;
}

export interface DoctorReport {
  checks: Record<
    string,
    {
      status: "pass" | "warn" | "fail";
      summary: string;
      issues: DiagnosticCheckResult[];
    }
  >;
}

export function checkPath(
  envPath: string = process.env.PATH || "",
  fsImpl: typeof fs = fs,
): DiagnosticCheckResult[] {
  const issues: DiagnosticCheckResult[] = [];
  const dirs = envPath.split(delimiter).filter(Boolean);

  let okvPath: string | undefined;
  const legacyPaths: string[] = [];

  for (const dir of dirs) {
    try {
      const stat = fsImpl.statSync(dir);
      if (!stat.isDirectory()) {
        continue;
      }

      // Check for okv
      const possibleOkv = join(dir, "okv");
      try {
        const fileStat = fsImpl.statSync(possibleOkv);
        if (fileStat.isFile() || fileStat.isSymbolicLink()) {
          if (!okvPath) {
            okvPath = possibleOkv;
          }
        }
      } catch {
        // ignore
      }

      // Check for okf-vault
      const possibleOkf = join(dir, "okf-vault");
      try {
        const fileStat = fsImpl.statSync(possibleOkf);
        if (fileStat.isFile() || fileStat.isSymbolicLink()) {
          legacyPaths.push(possibleOkf);
        }
      } catch {
        // ignore
      }

      // Check for okv-cli
      const possibleCli = join(dir, "okv-cli");
      try {
        const fileStat = fsImpl.statSync(possibleCli);
        if (fileStat.isFile() || fileStat.isSymbolicLink()) {
          legacyPaths.push(possibleCli);
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore inaccessible directories
    }
  }

  if (legacyPaths.length > 0) {
    for (const legacy of legacyPaths) {
      issues.push({
        code: "PATH_LEGACY_CONFLICT",
        status: "fail",
        message: `Legacy conflict found on PATH: ${legacy}`,
        path: legacy,
      });
    }
  }

  if (okvPath) {
    issues.push({
      code: "PATH_OKV_RESOLVED",
      status: "pass",
      message: `okv is available on PATH at ${okvPath}`,
      path: okvPath,
    });
  } else {
    issues.push({
      code: "PATH_OKV_MISSING",
      status: "fail",
      message: "okv binary was not found on PATH",
    });
  }

  return issues;
}

export function checkRules(projectRoot: string, fsImpl: typeof fs = fs): DiagnosticCheckResult[] {
  const issues: DiagnosticCheckResult[] = [];
  const root = resolve(projectRoot);

  // 1. Rule template check
  const sourceTemplate = join(root, ".agents", "skills", "okf-vault", "templates", "okv.mdc");
  const destRule = join(root, ".cursor", "rules", "okv.mdc");

  if (!fsImpl.existsSync(sourceTemplate)) {
    issues.push({
      code: "RULES_TEMPLATE_MISSING",
      status: "warn",
      message: `System rule template is missing at ${sourceTemplate}`,
      path: sourceTemplate,
    });
  } else {
    if (!fsImpl.existsSync(destRule)) {
      issues.push({
        code: "RULES_MISSING",
        status: "fail",
        message: "Cursor rule template .cursor/rules/okv.mdc is missing",
        path: destRule,
      });
    } else {
      try {
        const sourceContent = fsImpl.readFileSync(sourceTemplate, "utf8");
        const destContent = fsImpl.readFileSync(destRule, "utf8");
        if (sourceContent === destContent) {
          issues.push({
            code: "RULES_MATCH",
            status: "pass",
            message: "Cursor rule template is up to date",
            path: destRule,
          });
        } else {
          issues.push({
            code: "RULES_OUTDATED",
            status: "fail",
            message: "Cursor rule template .cursor/rules/okv.mdc is out of date",
            path: destRule,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push({
          code: "RULES_READ_FAILED",
          status: "fail",
          message: `Failed to read rule files: ${msg}`,
          path: destRule,
        });
      }
    }
  }

  // 2. Command adapters (symlinks)
  const canonicalSkill = join(root, ".agents", "skills", "okf-vault");
  const symlinksToCheck = [
    {
      path: join(root, ".cursor", "skills", "okf-vault"),
      target: canonicalSkill,
      label: "Cursor umbrella skill",
    },
    {
      path: join(root, ".claude", "skills", "okf-vault"),
      target: canonicalSkill,
      label: "Claude umbrella skill",
    },
  ];

  const okvCommands = [
    "okv-ingest",
    "okv-init",
    "okv-organize",
    "okv-validate",
    "okv-visualize",
    "okv-bootstrap",
    "okv-ingest-check",
  ];

  for (const command of okvCommands) {
    const target = join(root, ".agents", "skills", "okf-vault", "commands", `${command}.md`);
    symlinksToCheck.push(
      {
        path: join(root, ".cursor", "skills", command, "SKILL.md"),
        target,
        label: `Cursor /${command}`,
      },
      {
        path: join(root, ".claude", "commands", `${command}.md`),
        target,
        label: `Claude /${command}`,
      },
    );
  }

  for (const symlink of symlinksToCheck) {
    if (!fsImpl.existsSync(symlink.path)) {
      issues.push({
        code: "IDE_ADAPTER_MISSING",
        status: "fail",
        message: `${symlink.label} symlink is missing: ${symlink.path}`,
        path: symlink.path,
      });
      continue;
    }

    try {
      const stat = fsImpl.lstatSync(symlink.path);
      if (!stat.isSymbolicLink()) {
        issues.push({
          code: "IDE_ADAPTER_INVALID",
          status: "fail",
          message: `${symlink.label} exists but is not a symbolic link: ${symlink.path}`,
          path: symlink.path,
        });
        continue;
      }

      const linkTarget = fsImpl.readlinkSync(symlink.path);
      const absTarget = resolve(dirname(symlink.path), linkTarget);
      const absExpected = resolve(symlink.target);

      if (absTarget === absExpected) {
        issues.push({
          code: "IDE_ADAPTER_MATCH",
          status: "pass",
          message: `${symlink.label} is valid`,
          path: symlink.path,
        });
      } else {
        issues.push({
          code: "IDE_ADAPTER_INVALID",
          status: "fail",
          message: `${symlink.label} points to invalid target: expected ${absExpected}, got ${absTarget}`,
          path: symlink.path,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push({
        code: "IDE_ADAPTER_ERROR",
        status: "fail",
        message: `Failed to verify ${symlink.label}: ${msg}`,
        path: symlink.path,
      });
    }
  }

  return issues;
}

export function checkHooks(projectRoot: string, fsImpl: typeof fs = fs): DiagnosticCheckResult[] {
  const issues: DiagnosticCheckResult[] = [];
  const root = resolve(projectRoot);

  const huskyPath = join(root, ".husky", "pre-commit");
  const gitHookPath = join(root, ".git", "hooks", "pre-commit");

  let huskyExists = false;
  let gitHookExists = false;
  let hasOkv = false;
  let matchedPath: string | undefined;

  if (fsImpl.existsSync(huskyPath)) {
    huskyExists = true;
    try {
      const content = fsImpl.readFileSync(huskyPath, "utf8");
      if (content.includes("okv validate-staged")) {
        hasOkv = true;
        matchedPath = huskyPath;
      }
    } catch {
      // ignore read error
    }
  }

  if (fsImpl.existsSync(gitHookPath)) {
    gitHookExists = true;
    try {
      const content = fsImpl.readFileSync(gitHookPath, "utf8");
      if (content.includes("okv validate-staged")) {
        hasOkv = true;
        matchedPath = gitHookPath;
      }
    } catch {
      // ignore read error
    }
  }

  if (hasOkv && matchedPath) {
    issues.push({
      code: "HOOKS_OK",
      status: "pass",
      message: `Pre-commit hook runs 'okv validate-staged' via ${matchedPath}`,
      path: matchedPath,
    });
  } else if (huskyExists || gitHookExists) {
    const hookPath = huskyExists ? huskyPath : gitHookPath;
    issues.push({
      code: "HOOKS_LACKS_OKV",
      status: "fail",
      message: `Pre-commit hook at ${hookPath} exists but does not call 'okv validate-staged'`,
      path: hookPath,
    });
  } else {
    issues.push({
      code: "HOOKS_MISSING",
      status: "fail",
      message: "Pre-commit hook is missing entirely",
      path: gitHookPath,
    });
  }

  return issues;
}

export function checkVault(projectRoot: string, fsImpl: typeof fs = fs): DiagnosticCheckResult[] {
  const issues: DiagnosticCheckResult[] = [];

  let vaultRoot = join(projectRoot, "knowledge");
  const knowledgeManifest = join(vaultRoot, MANIFEST_RELATIVE_PATH);
  if (!fsImpl.existsSync(knowledgeManifest)) {
    const rootManifest = join(projectRoot, MANIFEST_RELATIVE_PATH);
    if (fsImpl.existsSync(rootManifest)) {
      vaultRoot = projectRoot;
    } else {
      issues.push({
        code: "VAULT_MISSING",
        status: "fail",
        message: "No vault found at ./knowledge or project root",
        path: join(projectRoot, "knowledge"),
      });
      return issues;
    }
  }

  const layoutFiles = [ROOT_INDEX_PATH, LOG_PATH, NOTES_INDEX_PATH, TOPICS_INDEX_PATH];

  for (const file of layoutFiles) {
    const filePath = join(vaultRoot, file);
    if (!fsImpl.existsSync(filePath)) {
      issues.push({
        code: "VAULT_LAYOUT_MISSING",
        status: "fail",
        message: `Vault layout file ${file} is missing`,
        path: filePath,
      });
    }
  }

  try {
    const manifestPath = join(vaultRoot, MANIFEST_RELATIVE_PATH);
    const content = fsImpl.readFileSync(manifestPath, "utf8");
    const raw = JSON.parse(content);
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Manifest must be a JSON object");
    }
    if (raw.schema_version !== MANIFEST_SCHEMA_VERSION) {
      issues.push({
        code: "MANIFEST_SCHEMA_MISMATCH",
        status: "fail",
        message: `Manifest schema version mismatch: expected ${MANIFEST_SCHEMA_VERSION}, got ${raw.schema_version}`,
        path: manifestPath,
      });
    }
    if (!Array.isArray(raw.sources)) {
      issues.push({
        code: "MANIFEST_INVALID_SOURCES",
        status: "fail",
        message: "Manifest sources must be an array",
        path: manifestPath,
      });
    } else {
      for (const record of raw.sources) {
        if (record && record.status === "committed" && typeof record.note_path === "string") {
          const noteDiskPath = join(vaultRoot, record.note_path);
          if (!fsImpl.existsSync(noteDiskPath)) {
            issues.push({
              code: "MANIFEST_NOTE_MISSING",
              status: "fail",
              message: `Committed note file is missing from disk: ${record.note_path}`,
              path: noteDiskPath,
            });
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push({
      code: "MANIFEST_INVALID",
      status: "fail",
      message: `Failed to load or parse manifest: ${msg}`,
      path: join(vaultRoot, MANIFEST_RELATIVE_PATH),
    });
  }

  return issues;
}

export function runDiagnostics(
  projectRoot: string,
  envPath?: string,
  fsImpl: typeof fs = fs,
): DoctorReport {
  const pathIssues = checkPath(envPath, fsImpl);
  const rulesIssues = checkRules(projectRoot, fsImpl);
  const hooksIssues = checkHooks(projectRoot, fsImpl);
  const vaultIssues = checkVault(projectRoot, fsImpl);

  const getStatus = (issues: DiagnosticCheckResult[]): "pass" | "warn" | "fail" => {
    if (issues.some((i) => i.status === "fail")) {
      return "fail";
    }
    if (issues.some((i) => i.status === "warn")) {
      return "warn";
    }
    return "pass";
  };

  return {
    checks: {
      path: {
        status: getStatus(pathIssues),
        summary: "System PATH and legacy executable conflict check",
        issues: pathIssues,
      },
      rules: {
        status: getStatus(rulesIssues),
        summary: "IDE rule templates and command adapters check",
        issues: rulesIssues,
      },
      hooks: {
        status: getStatus(hooksIssues),
        summary: "Git pre-commit hooks check",
        issues: hooksIssues,
      },
      vault: {
        status: getStatus(vaultIssues),
        summary: "Vault layout and manifest health check",
        issues: vaultIssues,
      },
    },
  };
}
