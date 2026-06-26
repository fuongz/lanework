// Node shim for the `cloudflare:workers` virtual module.
//
// In the Cloudflare build this module is provided by `@cloudflare/vite-plugin`
// and exposes the Worker bindings (D1, KV, secrets) via `env`. In the local
// Node build there is no Workers runtime, so we expose `env` backed by
// `process.env`. Local mode never touches the Cloudflare-only bindings (DB/KV
// are gated behind `LANEWORK_LOCAL`), so a plain string map is enough — the
// values that ARE read locally (e.g. BETTER_AUTH_URL) come from env vars.
export const env: Record<string, string | undefined> = new Proxy(
  {},
  {
    get(_t, key: string) {
      return process.env[key];
    },
    has(_t, key: string) {
      return key in process.env;
    },
  },
) as Record<string, string | undefined>;

// Some TanStack/Cloudflare code paths reference these; provide harmless no-ops
// so imports resolve in the Node bundle even if never called locally.
export class WorkerEntrypoint {}
export class DurableObject {}
export default { env };
