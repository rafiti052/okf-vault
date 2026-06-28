import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { ExitCode } from "../../dist/cli/cli.js";
import { MANIFEST_SCHEMA_VERSION } from "../../dist/vault/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const bin = join(root, "dist", "main.js");
const okvCommands = [
  "okv-ingest",
  "okv-init",
  "okv-organize",
  "okv-validate",
  "okv-visualize",
  "okv-bootstrap",
  "okv-ingest-check",
  "okv-ask",
];

function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function commandEnv(projectRoot: string): NodeJS.ProcessEnv {
  const shimDir = join(projectRoot, "bin");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "okv"), "#!/bin/sh\n", "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: shimDir,
    CI: "1",
  };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function seedHealthyVault(projectRoot: string): void {
  const vaultRoot = join(projectRoot, "knowledge");
  mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
  mkdirSync(join(vaultRoot, "notes"), { recursive: true });
  mkdirSync(join(vaultRoot, "topics"), { recursive: true });
  writeFileSync(join(vaultRoot, "index.md"), "# Knowledge\n", "utf8");
  writeFileSync(join(vaultRoot, "log.md"), "# Log\n", "utf8");
  writeFileSync(join(vaultRoot, "notes", "index.md"), "# Notes\n", "utf8");
  writeFileSync(join(vaultRoot, "topics", "index.md"), "# Topics\n", "utf8");
  writeFileSync(
    join(vaultRoot, ".okf-vault", "manifest.json"),
    JSON.stringify({
      schema_version: MANIFEST_SCHEMA_VERSION,
      note_contract_version: "okf-note-contract/1.0.0",
      sources: [],
    }),
    "utf8",
  );

  const canonicalSkill = join(projectRoot, ".agents", "skills", "okf-vault");
  const template = join(canonicalSkill, "templates", "okv.mdc");
  mkdirSync(dirname(template), { recursive: true });
  writeFileSync(template, "okv rule\n", "utf8");
  mkdirSync(join(projectRoot, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(projectRoot, ".cursor", "rules", "okv.mdc"), readFileSync(template), "utf8");

  mkdirSync(join(projectRoot, ".cursor", "skills"), { recursive: true });
  mkdirSync(join(projectRoot, ".claude", "skills"), { recursive: true });
  symlinkSync(canonicalSkill, join(projectRoot, ".cursor", "skills", "okf-vault"));
  symlinkSync(canonicalSkill, join(projectRoot, ".claude", "skills", "okf-vault"));

  mkdirSync(join(canonicalSkill, "commands"), { recursive: true });
  mkdirSync(join(projectRoot, ".claude", "commands"), { recursive: true });
  for (const command of okvCommands) {
    const commandFile = join(canonicalSkill, "commands", `${command}.md`);
    writeFileSync(commandFile, `# ${command}\n`, "utf8");
    mkdirSync(join(projectRoot, ".cursor", "skills", command), { recursive: true });
    symlinkSync(commandFile, join(projectRoot, ".cursor", "skills", command, "SKILL.md"));
    symlinkSync(commandFile, join(projectRoot, ".claude", "commands", `${command}.md`));
  }

  const hook = join(projectRoot, ".git", "hooks", "pre-commit");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\nokv validate-staged\n", "utf8");
}

function runDoctor(projectRoot: string, args: string[]) {
  return spawnSync(process.execPath, [bin, "doctor", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: commandEnv(projectRoot),
  });
}

describe("okv doctor workflow", () => {
  it("prints PASS check results for a healthy vault in human mode", () => {
    const projectRoot = tempRoot("okv-doctor-healthy-human-");
    try {
      seedHealthyVault(projectRoot);

      const result = runDoctor(projectRoot, ["--human"]);

      assert.equal(result.status, ExitCode.SUCCESS);
      assert.match(result.stdout, /doctor/);
      assert.match(result.stdout, /pass/i);
      assert.match(result.stdout, /System PATH and legacy executable conflict check/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("outputs the raw DoctorReport JSON and exits cleanly with --json", () => {
    const projectRoot = tempRoot("okv-doctor-healthy-json-");
    try {
      seedHealthyVault(projectRoot);

      const result = runDoctor(projectRoot, ["--json"]);
      const payload = JSON.parse(result.stdout) as {
        status?: string;
        checks?: Record<string, { status: string }>;
      };

      assert.equal(result.status, ExitCode.SUCCESS);
      assert.equal(payload.status, undefined);
      assert.equal(payload.checks?.path?.status, "pass");
      assert.equal(payload.checks?.rules?.status, "pass");
      assert.equal(payload.checks?.hooks?.status, "pass");
      assert.equal(payload.checks?.vault?.status, "pass");
      assert.equal(result.stderr, "");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("exits with validation status for a broken vault in headless JSON mode", () => {
    const projectRoot = tempRoot("okv-doctor-broken-json-");
    try {
      const result = runDoctor(projectRoot, ["--json"]);
      const payload = JSON.parse(result.stdout) as {
        checks?: Record<string, { status: string }>;
      };

      assert.equal(result.status, ExitCode.VALIDATION);
      assert.equal(payload.checks?.vault?.status, "fail");
      assert.equal(payload.checks?.rules?.status, "fail");
      assert.equal(result.stderr, "");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
