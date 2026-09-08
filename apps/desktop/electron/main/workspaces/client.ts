import type { Workspace } from "../../../shared/workspaces";
import { resolveApi } from "../auth/client";
import type { MachineRecord } from "../auth/store";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the whole list: a malformed response must never look like no projects. */
export function parseWorkspaces(value: unknown): Workspace[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    throw new Error(
      "The service returned an invalid workspace list. Try again.",
    );
  const slugs = new Set<string>();
  return value.workspaces.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new Error("The service returned an invalid workspace. Try again.");
    const row = entry as Record<string, unknown>;
    if (
      !text(row.slug) ||
      !text(row.name) ||
      slugs.has(row.slug) ||
      !(row.path === null || text(row.path)) ||
      !(row.baseBranch === null || text(row.baseBranch))
    )
      throw new Error("The service returned an invalid workspace. Try again.");
    slugs.add(row.slug);
    return {
      slug: row.slug,
      name: row.name,
      path: row.path,
      baseBranch: row.baseBranch,
    };
  });
}

export async function fetchWorkspaces(
  record: MachineRecord,
): Promise<Workspace[]> {
  let response: Response;
  try {
    response = await fetch(`${resolveApi(record.apiUrl)}/v1/sync/state`, {
      headers: { authorization: `Bearer ${record.secret}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Could not load your workspaces. Check your connection and try again.",
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "This machine no longer has access. Sign in again to load your workspaces."
        : `Could not load your workspaces (HTTP ${response.status}). Try again.`,
    );
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The service returned an invalid workspace list. Try again.",
    );
  }
  return parseWorkspaces(data);
}
