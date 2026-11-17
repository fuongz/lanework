// The coding-search natives (FE-151): fff's file finder, @parcel/watcher and
// ast-grep. Each loads lazily, on first use, and a missing or broken one
// is `null`, never a throw: the feature that wanted it falls back or says it
// is unavailable, and the app still starts.
//
// None of them is bundled (`scripts/electron-bundle.mjs` lists them as
// externals). `stageNativePackages` copies them into
// `dist/electron/node_modules`, which `electron-builder.yml` unpacks from the
// asar. Unpackaged and never built, Node's lookup climbs on to the
// node_modules bun installed.
//
// NOTE: Main only. The offline MCP server and the plugin bundle never import
// this folder, and fs-kit stays free of it.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { sep } from "node:path";
import type * as AstGrep from "@ast-grep/napi";
import type * as Fff from "@ff-labs/fff-node";
import type * as Watcher from "@parcel/watcher";

export type FffModule = typeof Fff;
export type WatcherModule = typeof Watcher;
export type AstGrepModule = typeof AstGrep;

/** What a lang package (`@ast-grep/lang-*`) exports. */
interface LangPackage {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  metaVarChar?: string;
  expandoChar?: string;
}

/** ast-grep's dynamic languages, by the name a pattern's `lang` takes. */
const DYNAMIC_LANGS: Record<string, string> = {
  go: "@ast-grep/lang-go",
  json: "@ast-grep/lang-json",
  python: "@ast-grep/lang-python",
  rust: "@ast-grep/lang-rust",
};

const nodeRequire = createRequire(__filename);

/**
 * `name`, required from its unpacked copy when there is one.
 *
 * NOTE: Not from inside app.asar. Electron redirects a `.node` require to
 * app.asar.unpacked by itself, but fff opens its dylib, and ast-grep its
 * parsers, by a path computed from their own folder; dlopen() cannot read
 * the asar archive. Required from app.asar.unpacked, every path they build
 * is a real file.
 */
function requireNative<T>(name: string): T {
  const resolved = nodeRequire.resolve(name);
  const unpacked = resolved.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
  return nodeRequire(
    unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved,
  ) as T;
}

const failed = new Set<string>();

/** Logs `name`'s load failure the first time only. */
function logOnce(name: string, error: unknown): void {
  if (failed.has(name)) return;
  failed.add(name);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[native] ${name} is unavailable: ${message}`);
}

/** A lazy, fail-soft loader: tried once, then the answer is kept. */
function lazy<T>(name: string, load: () => T): () => T | null {
  let tried = false;
  let value: T | null = null;
  return () => {
    if (tried) return value;
    tried = true;
    try {
      value = load();
    } catch (error) {
      logOnce(name, error);
      value = null;
    }
    return value;
  };
}

/** fff's fuzzy file finder, or null when it cannot load here. */
export const loadFff = lazy<FffModule>("@ff-labs/fff-node", () => {
  const fff = requireNative<FffModule>("@ff-labs/fff-node");
  // Its dylib is found and opened on first use; fail now instead.
  if (!fff.binaryExists())
    throw new Error(`no fff binary for ${process.platform}-${process.arch}`);
  return fff;
});

/** @parcel/watcher, or null when it cannot load here. */
export const loadWatcher = lazy<WatcherModule>("@parcel/watcher", () =>
  requireNative<WatcherModule>("@parcel/watcher"),
);

let astGrepLangs: readonly string[] = [];

/**
 * ast-grep, or null when it cannot load here, with its dynamic languages
 * (see {@link loadedAstGrepLangs}) registered.
 *
 * A dynamic language that fails to load is left out and logged; ast-grep
 * still loads with the rest.
 */
export const loadAstGrep = lazy<AstGrepModule>("@ast-grep/napi", () => {
  const napi = requireNative<AstGrepModule>("@ast-grep/napi");
  const registrations: Record<string, LangPackage> = {};
  for (const [lang, name] of Object.entries(DYNAMIC_LANGS)) {
    try {
      const pkg = requireNative<LangPackage>(name);
      // A getter that throws when this platform has no prebuild.
      const libraryPath = pkg.libraryPath;
      registrations[lang] = {
        libraryPath,
        extensions: pkg.extensions,
        languageSymbol: pkg.languageSymbol,
        metaVarChar: pkg.metaVarChar,
        expandoChar: pkg.expandoChar,
      };
    } catch (error) {
      logOnce(name, error);
    }
  }
  // NOTE: Once per process, as ast-grep requires.
  napi.registerDynamicLanguage(registrations);
  astGrepLangs = Object.keys(registrations);
  return napi;
});

/**
 * The dynamic languages {@link loadAstGrep} registered (empty before it
 * ran). ts, tsx, js, jsx, css and html are built in and always there.
 */
export function loadedAstGrepLangs(): readonly string[] {
  return astGrepLangs;
}
