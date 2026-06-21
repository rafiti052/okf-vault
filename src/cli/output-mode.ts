export type OutputMode = "json" | "human";

export interface OutputModeOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
}

function modeFromTTY(stdoutIsTTY: boolean): OutputMode {
  return stdoutIsTTY ? "human" : "json";
}

export function resolveOutputMode(options: OutputModeOptions): OutputMode {
  if (options.argv.includes("--json")) {
    return "json";
  }

  if (options.argv.includes("--human")) {
    return "human";
  }

  const envMode = options.env.OKV_OUTPUT;
  if (envMode === "json" || envMode === "human") {
    return envMode;
  }

  if (envMode === "auto") {
    return modeFromTTY(options.stdoutIsTTY);
  }

  return modeFromTTY(options.stdoutIsTTY);
}
