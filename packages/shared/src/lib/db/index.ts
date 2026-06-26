import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Drizzle client bound to the Cloudflare D1 `DB` binding (memoized per isolate). */
export function getDb() {
  if (!_db) {
    _db = drizzle(env.DB, { schema });
  }
  return _db;
}
