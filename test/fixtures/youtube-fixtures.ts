import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const fixturesRoot = join(repoRoot, "test", "fixtures");
const envelopesDir = join(fixturesRoot, "envelopes");
const goldDir = join(fixturesRoot, "notes", "gold");

export const YOUTUBE_VIDEO_ACCEPTED_STEM = "youtube-accepted-01";
export const YOUTUBE_PANEL_AMBIGUOUS_STEM = "youtube-ambiguous-01";
export const YOUTUBE_REJECTED_ENVELOPE_NAME = "youtube-missing-timestamps.json";

export const youtubeAccepted = {
  stem: YOUTUBE_VIDEO_ACCEPTED_STEM,
  envelopePath: join(envelopesDir, "video", `${YOUTUBE_VIDEO_ACCEPTED_STEM}.json`),
  notePath: join(goldDir, "video", `${YOUTUBE_VIDEO_ACCEPTED_STEM}.md`),
  stagedNotePath: `notes/${YOUTUBE_VIDEO_ACCEPTED_STEM}.md`,
} as const;

export const youtubeAmbiguous = {
  stem: YOUTUBE_PANEL_AMBIGUOUS_STEM,
  envelopePath: join(envelopesDir, "panel", `${YOUTUBE_PANEL_AMBIGUOUS_STEM}.json`),
  notePath: join(goldDir, "panel", `${YOUTUBE_PANEL_AMBIGUOUS_STEM}.md`),
  stagedNotePath: `notes/${YOUTUBE_PANEL_AMBIGUOUS_STEM}.md`,
} as const;

export const youtubeRejected = {
  envelopePath: join(envelopesDir, YOUTUBE_REJECTED_ENVELOPE_NAME),
} as const;

export type YoutubeFixtureProfile = "video" | "panel";

/** Pair a gold note stem with its profile-scoped envelope path (video/ or panel/). */
export function pairedYoutubeEnvelopePath(
  notePath: string,
  profile: YoutubeFixtureProfile,
): string {
  const stem = basename(notePath, ".md");
  return join(envelopesDir, profile, `${stem}.json`);
}

export function assertYoutubeFixturesPresent(): void {
  for (const path of [
    youtubeAccepted.envelopePath,
    youtubeAccepted.notePath,
    youtubeAmbiguous.envelopePath,
    youtubeAmbiguous.notePath,
    youtubeRejected.envelopePath,
  ]) {
    if (!existsSync(path)) {
      throw new Error(`Missing YouTube fixture: ${path}`);
    }
  }
}
