# Security Policy

## Supported versions

This project is pre-1.0; only the latest `main` is supported with security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

- GitHub's [private vulnerability reporting](https://github.com/fuongz/lanework/security/advisories/new)
- Email: **phuong.phung@hiip.asia**

Please include a description, reproduction steps, affected files/routes, and the
potential impact. We aim to acknowledge reports within a few business days and
will keep you updated on the fix and disclosure timeline.

## Scope & handling notes

This app handles a user's GitHub OAuth token and session. Keep in mind when
reporting or contributing:

- **Secrets** (`BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID/SECRET`) live in `.dev.vars`
  (local, gitignored) and `wrangler secret` (production). Never commit them; never
  log them.
- **GitHub tokens stay server-side.** All GitHub calls go through `src/lib/github.ts`
  on the server; the token must never be sent to the client.
- **OAuth scope** defaults to `repo` (read private repos). Reduce to `public_repo`
  in `src/lib/auth.ts` if you don't need private access.
- Sessions are stored in Cloudflare D1 via Better Auth; cookies are managed by the
  `tanstackStartCookies()` plugin.

If you find a misconfiguration that could leak tokens, secrets, or another user's
data, treat it as a vulnerability and report it privately.
