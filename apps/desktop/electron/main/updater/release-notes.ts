// INF-11 (D8): a published release's notes, from the GitHub API. The repo is
// public, so no token: 60 unauthenticated requests an hour per address, and
// this asks at most once per launch plus once per What's New.
//
// The API never shows a draft without a token, so only what the maintainer
// published can be read here.
import { net } from "electron";
import {
  RELEASE_NOTES_MAX,
  RELEASE_REPO,
  type ReleaseNotes,
} from "../../../shared/updater";

const TIMEOUT_MS = 15_000;

const cache = new Map<string, ReleaseNotes>();

/**
 * The notes of release `v<version>`, or null when GitHub cannot be reached
 * or has no published release of that name.
 */
export async function fetchReleaseNotes(
  version: string,
): Promise<ReleaseNotes | null> {
  const cached = cache.get(version);
  if (cached) return cached;
  const { owner, repo } = RELEASE_REPO;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/v${encodeURIComponent(version)}`;
  try {
    const response = await net.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Lanework-Desktop",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const release = (await response.json()) as Record<string, unknown>;
    if (release.draft === true) return null;
    const page = release.html_url;
    if (
      typeof page !== "string" ||
      !page.startsWith(`https://github.com/${owner}/${repo}/releases/`)
    )
      return null;
    const body = typeof release.body === "string" ? release.body : "";
    const notes: ReleaseNotes = {
      version,
      title:
        typeof release.name === "string" && release.name.trim()
          ? release.name.trim()
          : `Lanework ${version}`,
      body: body.slice(0, RELEASE_NOTES_MAX),
      url: page,
    };
    cache.set(version, notes);
    return notes;
  } catch {
    return null;
  }
}
