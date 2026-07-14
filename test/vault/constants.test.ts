import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGED_CLEAN_PATHSPECS,
  REFERENCES_DIR,
  SOURCE_SPAN_CONTRACT_VERSION,
  SOURCE_SPANS_DIR,
  SOURCE_SPANS_PATHSPEC,
} from "../../dist/vault/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const vaultLayoutPath = join(
  root,
  ".agents",
  "skills",
  "okf-vault",
  "references",
  "vault-layout.md",
);

describe("managed source-span layout", () => {
  it("defines vault-relative, traversal-free source-span paths", () => {
    assert.equal(REFERENCES_DIR, "references");
    assert.equal(SOURCE_SPANS_DIR, `${REFERENCES_DIR}/sources`);
    assert.equal(SOURCE_SPANS_PATHSPEC, `${SOURCE_SPANS_DIR}/`);

    for (const relativePath of [REFERENCES_DIR, SOURCE_SPANS_DIR, SOURCE_SPANS_PATHSPEC]) {
      assert.equal(posix.isAbsolute(relativePath), false);
      assert.equal(relativePath.split("/").includes(".."), false);
    }
  });

  it("includes the source-span tree in managed clean pathspecs", () => {
    assert.equal(MANAGED_CLEAN_PATHSPECS.includes(SOURCE_SPANS_PATHSPEC), true);
  });

  it("keeps the vault layout reference aligned with managed constants and hydration bounds", () => {
    const layout = readFileSync(vaultLayoutPath, "utf8");

    assert.match(layout, new RegExp(`${SOURCE_SPANS_DIR.replace("/", "\\/")}\\/`));
    assert.match(layout, new RegExp(SOURCE_SPAN_CONTRACT_VERSION.replace("/", "\\/")));
    assert.match(layout, /helper-managed provenance/i);
    assert.match(layout, /one `exact` span and at most one `previous` and one `next` sibling/i);
    assert.match(layout, /no more than three spans/i);
    assert.match(layout, /never a first-hop retrieval candidate/i);
    assert.match(layout, /Git history/i);
  });
});
