import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "cloudflare:workers";
import { getDb } from "./db";
import { schema } from "./db/schema";

function buildAuth() {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    rateLimit: { enabled: true },
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema,
    }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // `repo` grants read access to private repos so we can list & read
        // `.agents/reviews`. Drop to `public_repo` if you only need public repos.
        scope: ["read:user", "user:email", "repo"],
      },
    },
    account: {
      accountLinking: { enabled: true },
    },
    // Must be the last plugin: wires Better Auth cookies into TanStack Start.
    plugins: [tanstackStartCookies()],
  });
}

let _auth: ReturnType<typeof buildAuth> | null = null;

/**
 * Lazily constructed Better Auth instance. Built per isolate because it needs
 * the Cloudflare `env` (D1 binding + secrets), which is only reliably available
 * once the worker is running.
 */
export function getAuth() {
  return (_auth ??= buildAuth());
}
