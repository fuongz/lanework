import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { MotionConfig } from "motion/react";
import appCss from "@/styles/app.css?url";
import { TooltipProvider } from "@/components/ui/tooltip";

const SITE_URL = "https://lanework.dev";
const DESCRIPTION = "Visualize your AI coding agent's review checklists as a Kanban board.";
const OG_IMAGE = `${SITE_URL}/og.png`;

// Security headers, set on the server for every document request. Defined as a
// server fn so the server-only import is extracted out of the client bundle.
const applySecurityHeaders = createServerFn().handler(() => {
  setResponseHeader("X-Content-Type-Options", "nosniff");
  setResponseHeader("X-Frame-Options", "DENY");
  setResponseHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  setResponseHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  setResponseHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

export const Route = createRootRoute({
  beforeLoad: async () => {
    if (import.meta.env.SSR) await applySecurityHeaders();
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Lanework" },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#059669" },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE_URL },
      { property: "og:title", content: "Lanework" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:image", content: OG_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Lanework — every agent review, in its lane." },
      { property: "og:site_name", content: "Lanework" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Lanework" },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: OG_IMAGE },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" },
      { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <MotionConfig reducedMotion="user">
          <TooltipProvider>{children}</TooltipProvider>
        </MotionConfig>
        <Scripts />
      </body>
    </html>
  );
}
