import { useState } from "react";
import { cn } from "@/lib/utils";

// Deterministic string hash → stable per login, so the same person always
// gets the same colors instead of flickering between renders.
function hashString(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function gradientFor(login: string) {
  const hash = hashString(login);
  const hue = hash % 360;
  const hue2 = (hue + 45 + (hash % 40)) % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${hue2} 70% 42%))`;
}

/**
 * A GitHub avatar for `login`, falling back to a deterministic gradient +
 * initial (Slack/Linear-style) if the image 404s (e.g. the login isn't a
 * real GitHub user) instead of showing a broken-image icon.
 */
export function AssigneeAvatar({ login, className }: { login: string; className?: string }) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <span
        role="img"
        aria-label={login}
        title={login}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white select-none",
          className,
        )}
        style={{ background: gradientFor(login) }}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={`https://github.com/${login}.png?size=40`}
      alt={login}
      title={login}
      onError={() => setErrored(true)}
      className={cn("rounded-full", className)}
    />
  );
}
