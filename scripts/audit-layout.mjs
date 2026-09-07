#!/usr/bin/env node
// The `src/` layout law, made checkable — the engine.
//
// Every rule here encodes a fact that is INVISIBLE when you have one file open —
// an importer count, a layer direction, a runtime-vs-type edge. A type checker,
// a linter and a bundler all pass on every violation below, which is exactly why
// a script has to hold the line instead of a paragraph in a rule file.
//
//   node audit-layout.mjs [--config <path>] [--src <path>]…
//
// Config is `layout.audit.json` at the repo root (override with --config). With
// no config it audits every `apps/*/src`, or `src/` in a single-app repo.
//
// This file is BOTH a CLI and a library: a repo keeps a three-line
// `scripts/audit-layout.mjs` that calls `main()`, so the gate has one
// implementation no matter how many repos run it.
//
// Prints known, accepted exceptions on every run: an exception you cannot see is
// an exception that quietly becomes the norm.
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

/** Defaults chosen so a repo scaffolded by this skill needs no config at all. */
export const DEFAULTS = {
  // Top-level folders, ordered top → bottom. A layer may import layers to its
  // RIGHT at runtime, never to its left. Derive this from your own graph rather
  // than trusting the order: pick the one that makes the fewest existing edges
  // illegal, then fix those.
  layers: [
    "routes",
    "components",
    "hooks",
    "stores",
    "server",
    "content",
    "lib",
  ],
  // Vendored territory — written by a registry CLI or a generator, exempt from
  // every rule, and never allowed to import app code.
  registry: { components: ["components/ui/"], hooks: ["hooks/use-mobile.ts"] },
  // Subtrees that must never reach the browser.
  serverOnly: ["server/core/", "server/db/"],
  // Who may import them at runtime.
  serverOnlyImporters: ["server/", "routes/api/"],
  // The one symbol a route file may export.
  routeExport: "Route",
  // Bare specifiers `lib/` may not import at runtime. `*` suffix = prefix match.
  // `import type` is always exempt: a type is erased and carries no module.
  libForbidden: ["react", "react-dom", "react/jsx-runtime", "node:*", "@tanstack/*"],
  // { "from -> to": "why it is accepted, and when it goes away" }
  exceptions: {},
};

const SRC_RE = /(?:^|\n)\s*(?:import|export)(\s+type)?\s([^;]*?)from\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const EXPORTS_RE = /^export\s+(?:const|function|class|let|var|type|interface)\s+(\w+)/gm;
const RUNTIME_EXPORT_RE = /^export\s+(?:const|function|class|let|var)\s+(\w+)\s*(?:=\s*)?/gm;

const startsWithAny = (f, list) => list.some((p) => f.startsWith(p));

/** `["react", "node:*"]` → does `spec` match any of them? */
function matchesSpec(spec, patterns) {
  return patterns.some((p) =>
    p.endsWith("*") ? spec.startsWith(p.slice(0, -1)) : spec === p,
  );
}

/**
 * Audit ONE source root. Each root gets its own module graph — imports do not
 * cross app boundaries, and merging the graphs would let a file in app A satisfy
 * an importer count with a file in app B that can never reach it.
 *
 * @returns {{ problems: {file:string,msg:string}[], seen: Set<string>, counts: object }}
 */
export function auditRoot(srcDir, config) {
  const cfg = { ...DEFAULTS, ...config };
  const files = globSync("**/*.{ts,tsx}", { cwd: srcDir }).sort();
  const known = new Set(files);
  const problems = [];
  const fail = (file, msg) => problems.push({ file, msg });

  // ── module graph ────────────────────────────────────────────────────────────
  function resolve(spec, from) {
    let p;
    if (spec.startsWith("#/")) p = spec.slice(2);
    else if (spec.startsWith("."))
      p = path.normalize(path.join(path.dirname(from), spec));
    else return null; // a bare package specifier
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`])
      if (known.has(c)) return c;
    return null;
  }

  const text = new Map(
    files.map((f) => [f, readFileSync(path.join(srcDir, f), "utf8")]),
  );
  const importers = new Map(files.map((f) => [f, new Set()]));
  const edges = []; // { from, to, typeOnly }
  const bare = []; // { from, spec, typeOnly }

  for (const f of files) {
    for (const m of text.get(f).matchAll(SRC_RE)) {
      // `import type {…}` — or braces in which EVERY specifier is `type X`
      const clause = m[2] ?? "";
      const inner = clause.match(/\{([^}]*)\}/)?.[1];
      const allInlineType =
        inner !== undefined &&
        inner.split(",").filter((s) => s.trim()).length > 0 &&
        inner.split(",").every((s) => !s.trim() || /^type\s/.test(s.trim()));
      const typeOnly = Boolean(m[1]) || allInlineType;

      const to = resolve(m[3], f);
      if (to === null) {
        bare.push({ from: f, spec: m[3], typeOnly });
        continue;
      }
      if (to === f) continue;
      importers.get(to).add(f);
      edges.push({ from: f, to, typeOnly });
    }
    for (const m of text.get(f).matchAll(DYNAMIC_RE)) {
      const to = resolve(m[1], f);
      if (to && to !== f) importers.get(to).add(f);
    }
  }

  // ── 1 · components/ splits by reuse count ───────────────────────────────────
  const isRegistryComponent = (f) => startsWithAny(f, cfg.registry.components);
  const registryHooks = new Set(cfg.registry.hooks);
  const components = files.filter(
    (f) => f.startsWith("components/") && !isRegistryComponent(f),
  );

  /** A satellite (`x.util.ts` beside `x.tsx`) follows its OWNER, not its count. */
  function ownerOf(f) {
    const parts = path.basename(f).split(".");
    if (parts.length < 3) return null;
    const stem = parts.slice(0, -2).join(".");
    const dir = path.dirname(f);
    return [`${dir}/${stem}.tsx`, `${dir}/${stem}.ts`].find((c) => known.has(c)) ?? null;
  }

  for (const f of components) {
    const n = importers.get(ownerOf(f) ?? f).size;
    if (n === 0 && !ownerOf(f)) {
      fail(f, "imported by NOBODY — delete it or wire it up");
      continue;
    }
    const want = n >= 2 ? "shared" : "features";
    const got = f.split("/")[1];
    if (want !== got) fail(f, `${n} importer(s) → components/${want}/…, not ${got}/`);
  }

  // ── 2 · hooks/ is for hooks that cross domains ──────────────────────────────
  /** Which part of the app an importer belongs to. */
  const areaOf = (f) => {
    if (isRegistryComponent(f)) return "components/ui";
    if (f.startsWith("components/")) return f.split("/").slice(0, 3).join("/");
    if (f.startsWith("routes/")) return "routes";
    return f.split("/")[0];
  };

  for (const f of files.filter((x) => x.startsWith("hooks/"))) {
    if (registryHooks.has(f)) continue;
    if (!/^use-[a-z0-9-]+\.ts$/.test(path.basename(f)))
      fail(f, "a hook file is named `use-<kebab>.ts`");
    const areas = [...new Set([...importers.get(f)].map(areaOf))];
    if (areas.length === 0) {
      fail(f, "imported by NOBODY — delete it or wire it up");
    } else if (areas.length === 1 && areas[0] !== "routes") {
      // `routes/` cannot own a file (nothing may import from a route), so a
      // route-only hook legitimately stays here. Any other single owner colocates.
      fail(f, `used only by ${areas[0]} — colocate it there, not in hooks/`);
    }
  }

  // ── 3 · a route declares a URL and exports exactly one thing ────────────────
  for (const f of files.filter((x) => x.startsWith("routes/"))) {
    const names = [...text.get(f).matchAll(EXPORTS_RE)].map((m) => m[1]);
    if (names.length !== 1 || names[0] !== cfg.routeExport)
      fail(
        f,
        `a route exports exactly one thing, \`${cfg.routeExport}\` — found [${names.join(", ")}]`,
      );
  }

  // ── 4 · a server boundary exports ONLY serverFns and types ──────────────────
  // A framework strips a server function's HANDLER BODY, not the module. Any other
  // runtime export in a boundary file ships to the client with the module's imports.
  for (const f of files.filter((x) => /^server\/[^/]+\.ts$/.test(x))) {
    const t = text.get(f);
    if (!t.includes("createServerFn")) continue; // a facade or a `-core.ts`, not a boundary
    for (const m of t.matchAll(RUNTIME_EXPORT_RE)) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (!after.startsWith("createServerFn"))
        fail(
          f,
          `boundary exports a non-serverFn runtime value \`${m[1]}\` — move it to lib/ or a -core.ts`,
        );
    }
  }

  // ── 5 · lib/ is the floor: isomorphic and framework-free ────────────────────
  // A `lib/` module that imports the framework belongs in hooks/ or beside its
  // component; one that imports a platform builtin is server code, however small.
  for (const f of files.filter((x) => x.startsWith("lib/"))) {
    if (f.endsWith(".tsx"))
      fail(f, "lib/ is framework-free — a .tsx file belongs in components/");
  }
  for (const { from, spec, typeOnly } of bare) {
    if (typeOnly || !from.startsWith("lib/")) continue;
    if (matchesSpec(spec, cfg.libForbidden))
      fail(from, `lib/ must not import \`${spec}\` at runtime — use \`import type\`, or move the module up`);
  }

  // ── 6 · vendored code may not import app code ───────────────────────────────
  // A registry file is overwritten by the next `add`, so an edge pointing INTO the
  // app is a dependency that silently disappears on regeneration.
  const seen = new Set();
  const accept = (from, to) => {
    const key = `${from} -> ${to}`;
    if (!Object.hasOwn(cfg.exceptions, key)) return false;
    seen.add(key);
    return true;
  };

  for (const { from, to, typeOnly } of edges) {
    if (typeOnly || !isRegistryComponent(from)) continue;
    if (isRegistryComponent(to) || to.startsWith("lib/") || registryHooks.has(to))
      continue;
    if (accept(from, to)) continue;
    fail(from, `registry file imports app code \`${to}\` — the next registry sync erases this edge`);
  }

  // ── 7 · dependencies point one way ──────────────────────────────────────────
  // `import type` is always allowed: types are erased, so they carry no module.
  const layerOf = (f) => {
    const i = cfg.layers.indexOf(f.split("/")[0]);
    return i === -1 ? null : { name: f.split("/")[0], rank: i };
  };
  const isServerOnly = (f) => startsWithAny(f, cfg.serverOnly);

  for (const { from, to, typeOnly } of edges) {
    if (typeOnly) continue;
    if (accept(from, to)) continue;
    if (isServerOnly(to) && !startsWithAny(from, cfg.serverOnlyImporters)) {
      fail(
        from,
        `runtime import of server-only \`${to}\` — use \`import type\`, a server fn, or a dynamic import()`,
      );
      continue;
    }
    const a = layerOf(from);
    const b = layerOf(to);
    if (!a || !b || a.name === b.name) continue;
    if (b.rank < a.rank)
      fail(from, `${a.name}/ must not import ${b.name}/ at runtime (\`${to}\`)`);
  }

  const shared = components.filter((f) => f.startsWith("components/shared/")).length;
  return {
    problems,
    seen,
    counts: {
      shared,
      features: components.length - shared,
      registry: files.filter(isRegistryComponent).length,
      hooks: files.filter((f) => f.startsWith("hooks/")).length,
      routes: files.filter((f) => f.startsWith("routes/")).length,
    },
  };
}

/** Where to audit when the repo has no config: every app, or a single `src/`. */
export function discoverRoots(cwd) {
  const apps = globSync("apps/*/src", { cwd }).sort();
  if (apps.length) return apps;
  return existsSync(path.join(cwd, "src")) ? ["src"] : [];
}

export function loadConfig(cwd, configPath) {
  const p = path.join(cwd, configPath ?? "layout.audit.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * CLI entry. Returns the process exit code rather than calling process.exit, so a
 * repo's `scripts/audit-layout.mjs` wrapper stays a one-liner and tests can call it.
 */
export async function main(argv = [], cwd = process.cwd()) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const config = loadConfig(cwd, flag("config"));
  const cfg = { ...DEFAULTS, ...config };

  const cliSrc = [];
  for (const [i, a] of argv.entries())
    if (a === "--src" && argv[i + 1]) cliSrc.push(argv[i + 1]);
  const roots = cliSrc.length
    ? cliSrc
    : config.src
      ? [config.src].flat()
      : discoverRoots(cwd);

  if (!roots.length) {
    console.error(
      "no source root found — pass --src <dir>, or add `src` to layout.audit.json",
    );
    return 1;
  }

  const problems = [];
  const seen = new Set();
  const totals = { shared: 0, features: 0, registry: 0, hooks: 0, routes: 0 };

  for (const root of roots) {
    const abs = path.join(cwd, root);
    if (!existsSync(abs)) {
      console.error(`source root does not exist: ${root}`);
      return 1;
    }
    const r = auditRoot(abs, cfg);
    for (const { file, msg } of r.problems) problems.push({ file: `${root}/${file}`, msg });
    for (const k of r.seen) seen.add(k);
    for (const k of Object.keys(totals)) totals[k] += r.counts[k];
  }

  const exceptions = Object.entries(cfg.exceptions);
  if (exceptions.length) {
    console.log(`${exceptions.length} accepted exception(s):`);
    for (const [k, why] of exceptions) {
      // An entry that no longer matches anything is rot — say so, or the list grows
      // into a permission slip nobody can audit.
      const stale = seen.has(k) ? "" : "   ⚠️ NO LONGER PRESENT — delete this entry";
      console.log(`  ${k}\n      ${why}${stale}`);
    }
    console.log("");
  }

  if (problems.length) {
    console.error(`${problems.length} layout violation(s):\n`);
    for (const { file, msg } of problems) console.error(`  ${file}\n      ${msg}`);
    return 1;
  }

  console.log(
    `layout OK — components ${totals.shared} shared / ${totals.features} features / ` +
      `${totals.registry} registry, ${totals.hooks} app-wide hooks, ${totals.routes} routes` +
      (roots.length > 1 ? ` (${roots.length} roots)` : ""),
  );
  return 0;
}

// Run only when invoked directly, so importing this file costs nothing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
