import { type DispatchOutcome, ExitCode, failure } from "../cli/cli.js";

export function handleRetrieve(args: string[]): DispatchOutcome {
  const evalFlag = args.includes("--eval");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (evalFlag) {
    // eval mode: okv retrieve --eval [vault-root]
    // vault-root may be omitted (cwd fallback handled in later tasks)
    if (positional.length === 0) {
      // cwd fallback will be implemented in task-02; for now require explicit root
      return {
        exitCode: ExitCode.USAGE,
        result: failure(
          "retrieve",
          "USAGE_MISSING_VAULT_ROOT",
          "Usage: okv retrieve --eval <vault-root>",
        ),
        diagnostic: "Missing vault-root for --eval mode.",
      };
    }
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

  if (positional.length === 1) {
    // Single positional: cwd fallback will be resolved in task-02
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        "USAGE_MISSING_QUERY",
        "Usage: okv retrieve <vault-root> <query>  or  okv retrieve <query>",
      ),
      diagnostic: "Missing query argument for retrieve.",
    };
  }

  // Placeholder: retrieval execution implemented in tasks 02–11
  return {
    exitCode: ExitCode.USAGE,
    result: failure(
      "retrieve",
      "NOT_YET_IMPLEMENTED",
      "Retrieval is not yet implemented.",
    ),
  };
}
