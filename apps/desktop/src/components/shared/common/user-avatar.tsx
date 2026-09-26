import { useState } from "react";
import { AccountOrb } from "#/components/shared/common/account-orb";
import { cn } from "#/lib/utils";

/**
 * A person's picture, or their orb when there is no picture to draw.
 *
 * ⚠️ The orb stands in for a FAILED image too, not only a missing one. This
 * window's CSP is `img-src 'self' data:` (see `protocol.ts`), so most remote
 * avatar URLs never load — without the `onError` swap every one of them drew
 * the browser's broken-image glyph.
 *
 * ⚠️ The failure is remembered per URL, not as a flag. A row reused for another
 * person gets a new `src`, and a stale `true` would hide a picture that loads.
 */
export function UserAvatar({
  src,
  seed,
  title,
  className,
}: {
  src?: string | null;
  /** What the orb is generated from — a user id, a login, a name. */
  seed: string;
  /** Hover text; these are often drawn with no name beside them. */
  title?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (!src || failed === src) {
    return (
      <span
        title={title}
        className={cn("inline-flex shrink-0 rounded-full", className)}
      >
        <AccountOrb seed={seed} className="size-full" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      title={title}
      onError={() => setFailed(src)}
      className={cn("shrink-0 rounded-full object-cover", className)}
    />
  );
}
