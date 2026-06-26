import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tombstonePath = join(root, "dist", "tombstone.js");
const mainPath = join(root, "dist", "main.js");

test("tombstone exits code 2 and prints redirect guidance", () => {
  const result = spawnSync(process.execPath, [tombstonePath, "validate"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("`okf-vault` is now `okv` — run `okv <command>`"));
  assert.equal(result.stdout.trim(), ""); // no JSON to stdout
});

test("main entry point okv works normally (regression)", () => {
  const result = spawnSync(process.execPath, [mainPath, "--version", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim().startsWith("{"));
});

test("package.json bin keys are okv and okf-vault", () => {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["okf-vault", "okv"].sort());
  assert.equal(pkg.bin["okv"], "./dist/main.js");
  assert.equal(pkg.bin["okf-vault"], "./dist/tombstone.js");
});
