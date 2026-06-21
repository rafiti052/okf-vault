import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../../dist/cli.js";
import { resolveOutputMode } from "../../dist/cli/output-mode.js";

function resolve(options: { argv?: string[]; env?: NodeJS.ProcessEnv; stdoutIsTTY?: boolean }) {
  return resolveOutputMode({
    argv: options.argv ?? [],
    env: options.env ?? {},
    stdoutIsTTY: options.stdoutIsTTY ?? false,
  });
}

describe("resolveOutputMode", () => {
  it("--json wins over --human, OKV_OUTPUT=human, and TTY", () => {
    assert.equal(
      resolve({
        argv: ["--human", "validate", "--json"],
        env: { OKV_OUTPUT: "human" },
        stdoutIsTTY: true,
      }),
      "json",
    );
  });

  it("--human wins over OKV_OUTPUT=json and non-TTY when --json is absent", () => {
    assert.equal(
      resolve({
        argv: ["validate", "--human"],
        env: { OKV_OUTPUT: "json" },
        stdoutIsTTY: false,
      }),
      "human",
    );
  });

  it("OKV_OUTPUT=json forces JSON on TTY without explicit flags", () => {
    assert.equal(resolve({ env: { OKV_OUTPUT: "json" }, stdoutIsTTY: true }), "json");
  });

  it("OKV_OUTPUT=human forces human on non-TTY without explicit flags", () => {
    assert.equal(resolve({ env: { OKV_OUTPUT: "human" }, stdoutIsTTY: false }), "human");
  });

  it("OKV_OUTPUT=auto mirrors TTY detection", () => {
    assert.equal(resolve({ env: { OKV_OUTPUT: "auto" }, stdoutIsTTY: true }), "human");
    assert.equal(resolve({ env: { OKV_OUTPUT: "auto" }, stdoutIsTTY: false }), "json");
  });

  it("falls back to TTY detection when OKV_OUTPUT is invalid", () => {
    assert.equal(resolve({ env: { OKV_OUTPUT: "pretty" }, stdoutIsTTY: true }), "human");
    assert.equal(resolve({ env: { OKV_OUTPUT: "pretty" }, stdoutIsTTY: false }), "json");
  });

  it("defaults to JSON when there are no flags, no env, and stdout is non-TTY", () => {
    assert.equal(resolve({ stdoutIsTTY: false }), "json");
  });

  it("uses human mode through TTY detection when there are no flags or env", () => {
    assert.equal(resolve({ stdoutIsTTY: true }), "human");
  });
});

describe("parseArgs output mode flags", () => {
  it("strips --json and records the JSON output mode flag", () => {
    const parsed = parseArgs(["--json", "validate"]);

    assert.equal(parsed.command, "validate");
    assert.equal(parsed.outputModeFlag, "json");
    assert.deepEqual(parsed.positional, ["validate"]);
  });

  it("strips --human and records the human output mode flag", () => {
    const parsed = parseArgs(["validate", "--human"]);

    assert.equal(parsed.command, "validate");
    assert.equal(parsed.outputModeFlag, "human");
    assert.deepEqual(parsed.positional, ["validate"]);
  });

  it("records JSON when both output mode flags are present", () => {
    const parsed = parseArgs(["--human", "validate", "--json"]);

    assert.equal(parsed.command, "validate");
    assert.equal(parsed.outputModeFlag, "json");
    assert.deepEqual(parsed.positional, ["validate"]);
  });
});

describe("parseArgs and resolveOutputMode integration", () => {
  it("keeps dispatch positional args clean while raw argv still forces JSON on TTY", () => {
    const argv = ["validate", "--json"];
    const parsed = parseArgs(argv);

    assert.equal(parsed.command, "validate");
    assert.equal(parsed.outputModeFlag, "json");
    assert.deepEqual(parsed.positional, ["validate"]);
    assert.equal(resolve({ argv, env: { OKV_OUTPUT: "human" }, stdoutIsTTY: true }), "json");
  });
});
