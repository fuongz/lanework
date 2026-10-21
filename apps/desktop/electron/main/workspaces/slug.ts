// Turns a name a human typed into a slug the service accepts.
//
// The slug is minted here. The control plane does not derive one from the name
// (`lib/workspace-input.ts` says why: it never sees a folder, and a second
// derivation would give a second, disagreeing answer for the same project). A
// client that creates a project must supply one that matches
// `^[a-z0-9]+(-[a-z0-9]+)*$`.

/** The longest slug the service accepts. */
const MAX_SLUG = 64;

/**
 * Turn a project name into a slug that matches the service's slug pattern.
 *
 * NOTE: Diacritics are folded, not dropped. For this app's users that is the
 * difference between a usable slug and none: "Dự án của tôi" must become
 * `du-an-cua-toi`, not `d-n-c-a-t-i`. `đ` and `Đ` are replaced by name, since
 * NFD does not split them into `d` plus a mark.
 *
 * @returns A random `project-…` slug when the name has no latin letters or
 *   digits to keep.
 */
export function slugify(name: string): string {
  const folded = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase();

  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    // A trim to the cap can leave the hyphen the cap landed on.
    .replace(/-+$/g, "");

  // A name with nothing latin in it (日本語, an emoji, punctuation) gives no
  // slug. Refusing the project would be wrong: the service stores that name
  // fine. A random suffix is ugly but honest: it says "this key was not
  // derived from your name".
  if (!slug) return `project-${Math.random().toString(36).slice(2, 8)}`;
  return slug;
}
