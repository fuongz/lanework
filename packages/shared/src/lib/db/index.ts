import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Drizzle client bound to the Cloudflare D1 `DB` binding (memoized per isolate). */
export function getDb() {
  if (!_db) {
    // The `DB` binding is commented out in wrangler.jsonc while the hosted webapp is
    // paused, so it's absent from the generated `Env` type. This path is hosted-only
    // (dead-code in the local CLI build); cast so it still typechecks. Re-enable the
    // binding in wrangler.jsonc to restore it.
    _db = drizzle((env as unknown as { DB: D1Database }).DB, { schema });
  }
  return _db;
}
