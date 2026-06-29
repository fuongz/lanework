import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Github01Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { signIn } from "@/lib/auth-client";
import { CtaButton } from "./cta-button";

/**
 * "Continue with GitHub" CTA. Fetching the OAuth redirect URL takes a moment, so we
 * show a spinner in place of the GitHub mark and lock the button until the browser
 * navigates away (pending intentionally stays true on success).
 */
export function GitHubLoginButton({
  callbackURL = "/dashboard",
  size = "lg",
  variant,
  className,
  children,
}: {
  callbackURL?: string;
  size?: "sm" | "lg";
  variant?: "primary" | "invert";
  className?: string;
  children?: React.ReactNode;
}) {
  const [pending, setPending] = useState(false);

  function login() {
    if (pending) return;
    setPending(true);
    // Resolves after the redirect URL is fetched; the page then navigates to GitHub.
    signIn.social({ provider: "github", callbackURL }).catch(() => setPending(false));
  }

  return (
    <CtaButton size={size} variant={variant} className={className} onClick={login} pending={pending}>
      {pending ? (
        <Spinner className="size-4" />
      ) : (
        <HugeiconsIcon icon={Github01Icon} className="size-4" />
      )}
      {children}
    </CtaButton>
  );
}
