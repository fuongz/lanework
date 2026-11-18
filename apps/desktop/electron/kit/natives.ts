// Which natives the kit may use (FE-152), and where they load from.
//
// - `appNatives`: `../main/native`'s loaders. They resolve from the bundle's
//   own folder, so any bundle emitted under `dist/electron/<name>/` (main,
//   mcp-kit, lwk) finds `dist/electron/node_modules`, unpacked from the asar
//   when packaged. fff goes through `../main/file-finder/finder.ts`'s pool:
//   in main, that is the app's warm index.
// - `nativesFrom(dir)`: ast-grep from an explicit node_modules folder, for a
//   bundle that runs from somewhere else. fff stays off: a cold index per
//   process costs as much as `rg --files`, and a warm one is the app's,
//   reached through its socket (`../main/kit-socket.ts`).
// - `noNatives`: ripgrep and fdir only.
//
// Without fff, `find_files` ranks fs-kit's file list; without ast-grep,
// `search_structural` says it is unavailable.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import {
  type AstGrepModule,
  loadAstGrep,
  loadedAstGrepLangs,
} from "../main/native";

export interface KitNatives {
  /** Use fff's finder pool for `find_files`. */
  fff: boolean;
  /** ast-grep, with its dynamic languages registered; null when missing. */
  astGrep: () => AstGrepModule | null;
  /** The dynamic languages {@link KitNatives.astGrep} registered. */
  astGrepLangs: () => readonly string[];
}

export const appNatives: KitNatives = {
  fff: true,
  astGrep: loadAstGrep,
  astGrepLangs: loadedAstGrepLangs,
};

export const noNatives: KitNatives = {
  fff: false,
  astGrep: () => null,
  astGrepLangs: () => [],
};

/** ast-grep's dynamic languages, by the name a pattern's `lang` takes. */
const DYNAMIC_LANGS: Record<string, string> = {
  go: "@ast-grep/lang-go",
  json: "@ast-grep/lang-json",
  python: "@ast-grep/lang-python",
  rust: "@ast-grep/lang-rust",
};

/**
 * ast-grep required from `nodeModules` (an absolute `node_modules` folder,
 * e.g. the app's `dist/electron/node_modules`, unpacked), fff off.
 *
 * NOTE: ast-grep registers dynamic languages once per process: a process
 * uses this or {@link appNatives}, never both.
 */
export function nativesFrom(nodeModules: string): KitNatives {
  // A require rooted inside the folder resolves its packages first.
  const nodeRequire = createRequire(join(nodeModules, "kit-natives.cjs"));
  const load = <T>(name: string): T => {
    const resolved = nodeRequire.resolve(name);
    const unpacked = resolved.replace(
      `${sep}app.asar${sep}`,
      `${sep}app.asar.unpacked${sep}`,
    );
    return nodeRequire(
      unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved,
    ) as T;
  };
  let tried = false;
  let napi: AstGrepModule | null = null;
  let langs: string[] = [];
  return {
    fff: false,
    astGrep: () => {
      if (tried) return napi;
      tried = true;
      try {
        const loaded = load<AstGrepModule>("@ast-grep/napi");
        const registrations: Parameters<
          AstGrepModule["registerDynamicLanguage"]
        >[0] = {};
        for (const [lang, name] of Object.entries(DYNAMIC_LANGS)) {
          try {
            const pkg =
              load<
                Parameters<AstGrepModule["registerDynamicLanguage"]>[0][string]
              >(name);
            registrations[lang] = {
              // A getter that throws when this platform has no prebuild.
              libraryPath: pkg.libraryPath,
              extensions: pkg.extensions,
              languageSymbol: pkg.languageSymbol,
              metaVarChar: pkg.metaVarChar,
              expandoChar: pkg.expandoChar,
            };
          } catch {
            // That language is left out; the rest still load.
          }
        }
        loaded.registerDynamicLanguage(registrations);
        langs = Object.keys(registrations);
        napi = loaded;
      } catch {
        napi = null;
      }
      return napi;
    },
    astGrepLangs: () => langs,
  };
}
