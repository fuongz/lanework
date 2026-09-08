/**
 * Turning a name a human typed into a slug the service will accept.
 *
 * ⚠️ The slug is minted HERE, on purpose. The control plane deliberately does
 * not derive one from the name (`lib/workspace-input.ts` says why: it never
 * sees a folder, and a second derivation would produce a second, disagreeing
 * answer for the same project), so a client that wants to create a project has
 * to supply one that matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
 *
 * ⚠️ Diacritics are folded rather than dropped, which for this app's own users
 * is the difference between a usable slug and none: "Dự án của tôi" has to
 * become `du-an-cua-toi`, not `d-n-c-a-t-i`. `đ`/`Đ` need naming separately —
 * NFD does not decompose them into `d` plus a mark.
 */
const MAX_SLUG = 64;

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

  // ⚠️ A name with nothing latin in it — 日本語, an emoji, punctuation — cannot
  // produce a slug, and refusing the project would be the wrong answer to a
  // name the service is perfectly happy to store. A random suffix is ugly and
  // it is honest: it says "this key was not derived from your name".
  if (!slug) return `project-${Math.random().toString(36).slice(2, 8)}`;
  return slug;
}
