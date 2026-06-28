import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure } from "../cli/cli.js";
import { MANIFEST_RELATIVE_PATH } from "./constants.js";

/**
 * Returns true when the given directory satisfies the vault-root contract:
 * it must contain an initialized manifest at `.okf-vault/manifest.json`.
 */
export function isValidVaultRoot(dir: string): boolean {
  const manifestPath = join(resolve(dir), MANIFEST_RELATIVE_PATH);
  return fs.existsSync(manifestPath);
}

/**
 * Resolve the vault root from a positional argument list using the
 * ADR-006 cwd-fallback policy:
 *
 * - If `positional[0]` is a valid vault root, consume it and return the rest
 *   as `remainder`.
 * - Otherwise fall back to `process.cwd()` when it is itself a valid vault
 *   root and return the full positional list as `remainder`.
 * - Never walks parent directories or reads ambient config.
 *
 * Returns a discriminated union so callers can return the error outcome
 * directly without wrapping.
 */
export function resolveVaultRoot(
  positional: string[],
  getCwd: () => string = () => process.cwd(),
): { ok: true; vaultRoot: string; remainder: string[] } | { ok: false; outcome: DispatchOutcome } {
  // If the first positional is a valid vault root, prefer it as explicit root.
  if (positional.length > 0) {
    const candidate = positional[0] as string;
    if (isValidVaultRoot(candidate)) {
      return {
        ok: true,
        vaultRoot: resolve(candidate),
        remainder: positional.slice(1),
      };
    }
  }

  // cwd fallback: only when the current directory is itself a valid vault root.
  const cwd = getCwd();
  if (isValidVaultRoot(cwd)) {
    return { ok: true, vaultRoot: resolve(cwd), remainder: positional };
  }

  return {
    ok: false,
    outcome: {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        "VAULT_ROOT_NOT_FOUND",
        [
          "Could not determine a valid vault root.",
          "Either pass the vault root as the first argument or run the command",
          "from a directory that is itself an initialized OKV vault root.",
          "  okv retrieve <vault-root> <query>",
          "  okv retrieve <query>          # when cwd is a vault root",
        ].join("\n"),
      ),
      diagnostic:
        "No explicit vault root supplied and cwd is not a valid vault root. " +
        "Parent-directory search is not supported.",
    },
  };
}

export function handleRetrieve(
  args: string[],
  getCwd: () => string = () => process.cwd(),
): DispatchOutcome {
  const evalFlag = args.includes("--eval");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (evalFlag) {
    // eval mode: okv retrieve --eval [vault-root]
    const resolution = resolveVaultRoot(positional, getCwd);
    if (!resolution.ok) return resolution.outcome;
    // Placeholder: eval execution implemented in task-13/14
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        "NOT_YET_IMPLEMENTED",
        "Eval mode is not yet implemented.",
      ),
    };
  }

  // query mode: okv retrieve <vault-root> <query> or okv retrieve <query>
  if (positional.length === 0) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        "USAGE_MISSING_ARGS",
        "Usage: okv retrieve <vault-root> <query>  or  okv retrieve <query>",
      ),
      diagnostic: "Missing required arguments for retrieve.",
    };
  }

  const resolution = resolveVaultRoot(positional, getCwd);
  if (!resolution.ok) return resolution.outcome;

  const { vaultRoot, remainder } = resolution;

  if (remainder.length === 0) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        "USAGE_MISSING_QUERY",
        "Usage: okv retrieve <vault-root> <query>  or  okv retrieve <query>",
      ),
      diagnostic: `Vault root resolved to ${vaultRoot} but no query was provided.`,
    };
  }

  // Placeholder: retrieval execution implemented in tasks 03–11
  return {
    exitCode: ExitCode.USAGE,
    result: failure(
      "retrieve",
      "NOT_YET_IMPLEMENTED",
      "Retrieval is not yet implemented.",
    ),
  };
}
