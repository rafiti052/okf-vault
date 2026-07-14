import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { posix } from "node:path";
import {
  MANAGED_CLEAN_PATHSPECS,
  REFERENCES_DIR,
  SOURCE_SPANS_DIR,
  SOURCE_SPANS_PATHSPEC,
} from "../../dist/vault/constants.js";

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
});
