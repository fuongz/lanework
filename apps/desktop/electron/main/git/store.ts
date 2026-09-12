import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import {
  formatRepoRef,
  type PullStatus,
  type PullsView,
  parseRepoRef,
  type RepoRef,
} from "../../../shared/git";
import type { MachineRecord } from "../auth/store";
import { appHomeDir } from "../paths";
import { accountKey, writeAtomic } from "../workspaces/store";

/**
 * Everything this machine remembers about GitHub, on disk.
 *
 * ⚠️ Filed per Lanework ACCOUNT, like the folder links next door. Two accounts
 * on one machine must not share a GitHub connection: the second one would be
 * reading pull requests as the first one's user, with no screen anywhere saying
 * so. `accountKey` is imported rather than recomputed for exactly that reason.
 *
 * ⚠️ A separate file from `auth.json`, not another field in it. Two credentials
 * with two lifetimes: signing out of Lanework should not silently revoke a
 * GitHub connection, and a GitHub token that expires must not be able to look
 * like a machine credential that did.
 */

function gitDir(): string {
  return join(appHomeDir(), "git");
}

function tokenFile(record: MachineRecord): string {
  return join(gitDir(), `token-${accountKey(record)}.json`);
}

/** The GitHub credential, plus who it belongs to. `token` is never returned to a window. */
export interface GitTokenRecord {
  token: string;
  /**
   * Present only when GitHub issues expiring user tokens.
   *
   * ⚠️ Both shapes are real and the app cannot choose which it gets: a classic
   * OAuth App hands out a token that never expires and no refresh token, while
   * a GitHub App hands out one that dies in 8 hours plus a refresh token good
   * for 6 months. Storing both and refreshing only when `expiresAt` says so
   * handles either without asking which kind of app is on the other end.
   */
  refreshToken: string | null;
  /** Epoch ms, or null when this token does not expire. */
  expiresAt: number | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

type StoredToken = {
  v: 1;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  expiresAt: number | null;
} & (
  | { enc: true; tokenEnc: string; refreshEnc: string | null }
  | { enc: false; token: string; refresh: string | null }
);

function decrypt(value: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
}

/**
 * The stored GitHub credential, or null when there is none we can use.
 *
 * Anything unreadable — missing, malformed, undecryptable — reads as null, the
 * same rule `auth/store.ts` applies to the machine credential: a token we
 * cannot use is indistinguishable from one we do not have.
 */
export async function readToken(
  record: MachineRecord,
): Promise<GitTokenRecord | null> {
  const raw = await readFile(tokenFile(record), "utf8").catch(() => null);
  if (raw === null) return null;

  let data: StoredToken;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data?.v !== 1 || typeof data.login !== "string" || !data.login)
    return null;

  let token: string | null;
  let refreshToken: string | null;
  if (data.enc) {
    if (typeof data.tokenEnc !== "string") return null;
    token = decrypt(data.tokenEnc);
    refreshToken = data.refreshEnc ? decrypt(data.refreshEnc) : null;
  } else {
    token = typeof data.token === "string" ? data.token : null;
    refreshToken = typeof data.refresh === "string" ? data.refresh : null;
  }
  if (!token) return null;

  return {
    token,
    refreshToken,
    expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : null,
    login: data.login,
    name: data.name ?? null,
    avatarUrl: data.avatarUrl ?? null,
  };
}

export async function writeToken(
  record: MachineRecord,
  value: GitTokenRecord,
): Promise<void> {
  const base = {
    v: 1 as const,
    login: value.login,
    name: value.name,
    avatarUrl: value.avatarUrl,
    expiresAt: value.expiresAt,
  };
  const stored: StoredToken = safeStorage.isEncryptionAvailable()
    ? {
        ...base,
        enc: true,
        tokenEnc: safeStorage.encryptString(value.token).toString("base64"),
        refreshEnc: value.refreshToken
          ? safeStorage.encryptString(value.refreshToken).toString("base64")
          : null,
      }
    : {
        ...base,
        enc: false,
        token: value.token,
        refresh: value.refreshToken,
      };
  await writeAtomic(tokenFile(record), JSON.stringify(stored, null, 2));
}

/**
 * Forget the GitHub credential on this machine.
 *
 * ⚠️ Local only. Revoking the grant is the user's to do on GitHub, and the
 * screen that calls this says so rather than implying the app did it.
 */
export async function clearToken(record: MachineRecord): Promise<void> {
  await rm(tokenFile(record), { force: true }).catch(() => {});
}

function reposFile(record: MachineRecord): string {
  return join(gitDir(), `repos-${accountKey(record)}.json`);
}

/**
 * Which repo each project is pointed at, by SLUG.
 *
 * ⚠️ ONE repo per project — a string, not a list. That is the shape the product
 * asked for, and a map of lists would have every reader picking `[0]` and
 * calling it the repo anyway, while the type kept promising something the UI
 * cannot express.
 *
 * ⚠️ Keyed by slug for the same reason folder links are: the cloud workspace id
 * is absent on a service that predates it, and no route can change a slug, so a
 * rename cannot strand what is written here.
 */
export async function readRepos(
  record: MachineRecord,
): Promise<Record<string, RepoRef>> {
  try {
    const data = JSON.parse(await readFile(reposFile(record), "utf8")) as {
      v?: unknown;
      repos?: unknown;
    };
    if (data?.v !== 1 || !data.repos || typeof data.repos !== "object")
      return {};
    const out: Record<string, RepoRef> = {};
    for (const [slug, value] of Object.entries(
      data.repos as Record<string, unknown>,
    )) {
      // Re-parsed on the way out, not trusted. This file is on a disk a user
      // can edit, and it names a host this app then fetches from.
      const ref = typeof value === "string" ? parseRepoRef(value) : null;
      if (ref) out[slug] = ref;
    }
    return out;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return {};
    throw new Error("Could not read your linked repositories. Try again.");
  }
}

export async function readRepo(
  record: MachineRecord,
  slug: string,
): Promise<RepoRef | null> {
  return (await readRepos(record))[slug] ?? null;
}

/** Point a project at a repo, or unlink it with `null`. */
export async function writeRepo(
  record: MachineRecord,
  slug: string,
  ref: RepoRef | null,
): Promise<void> {
  const repos = await readRepos(record);
  if (ref) repos[slug] = ref;
  else delete repos[slug];
  await writeAtomic(
    reposFile(record),
    JSON.stringify({
      v: 1,
      repos: Object.fromEntries(
        Object.entries(repos).map(([key, value]) => [
          key,
          formatRepoRef(value),
        ]),
      ),
    }),
  );
}

/**
 * ⚠️ The STATUS is part of the key. Open and merged pull requests are different
 * lists, and one cache file for both would serve whichever was read last —
 * "merged" would briefly show open work, which is the one thing that view
 * exists to tell apart.
 */
function pullsFile(
  record: MachineRecord,
  ref: RepoRef,
  status: PullStatus,
): string {
  // The repo is hashed for the same reason the workspace id is next door: it
  // contains a slash, and a value with a slash in it must not choose a path.
  const key = createHash("sha256")
    .update(`${accountKey(record)}:${formatRepoRef(ref)}:${status}`)
    .digest("hex");
  return join(gitDir(), `pulls-${key}.json`);
}

/**
 * The last pull-request read that succeeded, or null.
 *
 * ⚠️ Exists for one reason: so a failed read shows the last good copy WITH a
 * label rather than an empty list. This is the same bargain `readBoardCache`
 * makes — "no open pull requests" and "I could not reach GitHub" are different
 * facts that look identical once the screen is drawn.
 */
export async function readPullsCache(
  record: MachineRecord,
  ref: RepoRef,
  status: PullStatus,
): Promise<PullsView | null> {
  try {
    const data = JSON.parse(
      await readFile(pullsFile(record, ref, status), "utf8"),
    ) as {
      v?: unknown;
      view?: PullsView;
    };
    if (data?.v !== 1 || !data.view) return null;
    if (
      data.view.repo?.owner !== ref.owner ||
      data.view.repo?.repo !== ref.repo ||
      data.view.status !== status
    )
      return null;
    // Whatever it claimed when written, reading it back is serving a copy.
    return { ...data.view, stale: true };
  } catch {
    return null;
  }
}

export async function writePullsCache(
  record: MachineRecord,
  ref: RepoRef,
  status: PullStatus,
  view: PullsView,
): Promise<void> {
  await writeAtomic(
    pullsFile(record, ref, status),
    JSON.stringify({ v: 1, view }),
  ).catch(() => {
    // A list that cannot be cached still works. Failing the read over a
    // housekeeping error would trade a real answer for none.
  });
}
