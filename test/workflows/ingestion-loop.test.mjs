import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  documentsIngestionFailureActions,
  skillRoot,
  verifyHappyPathOrdering,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const ingestionLoop = join(skillRoot(root), "references", "ingestion-loop.md");

describe("ingestion-loop contract", () => {
  it("documents happy-path progress event ordering and curator failure actions", () => {
    const text = readFileSync(ingestionLoop, "utf8");
    const events = [
      "run_started",
      "preflight_passed",
      "source_acquired",
      "conversion_started",
      "source_committed",
      "run_completed",
    ].map((name) => ({ event: name, run_id: "r", phase: "p", status: "ok", duration_ms: 0 }));

    assert.equal(verifyHappyPathOrdering(events), true);
    assert.equal(documentsIngestionFailureActions(text), true);
    assert.match(text, /source_already_processed/);
    assert.match(text, /changed_conflict/);
    assert.match(text, /skip_reason/);
    assert.match(text, /no automatic watchers/i);
    assert.match(text, /batch silent conversion/i);
  });

  it("maps four conversion profiles to tasks 08-09 references", () => {
    const text = readFileSync(ingestionLoop, "utf8");
    for (const profile of ["article", "deck", "panel", "video"]) {
      assert.match(text, new RegExp(profile, "i"));
      assert.match(text, new RegExp(`conversion-profiles/${profile}\\.md`));
    }
  });

  it("documents youtube as a valid source kind and MVP profile routing", () => {
    const text = readFileSync(ingestionLoop, "utf8");
    assert.match(text, /`youtube`/);
    assert.match(text, /YouTube MVP profile routing/i);
    assert.match(text, /ingest-wizard\.md.*acquire_youtube|acquire_youtube/i);
  });
});
