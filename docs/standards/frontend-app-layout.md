# Frontend app layout — a portable standard

A file-placement standard for a single-page or server-rendered app with a client
bundle, a server boundary and a component library. It is written to be **copied into
another repo and applied as-is**: nothing below depends on this project's framework,
router or build tool.

It exists to answer one question mechanically — _where does this file go?_ — so that
question stops being decided by whoever is least tired in code review.

**Applies to:** any app with `components/`, `hooks/`, a client/server split and a
design-system layer. **Does not apply to:** libraries, CLIs, or anything with no
browser bundle. Adapt the names; keep the rules.

---

## Contents

1. [The one idea](#1--the-one-idea)
2. [The tree](#2--the-tree)
3. [Rule A — `components/` splits by reuse count](#3--rule-a--components-splits-by-reuse-count)
4. [Rule B — `hooks/` is for hooks that cross domains](#4--rule-b--hooks-is-for-hooks-that-cross-domains)
5. [Rule C — a route declares a URL and nothing else](#5--rule-c--a-route-declares-a-url-and-nothing-else)
6. [Rule D — the server boundary is thin](#6--rule-d--the-server-boundary-is-thin)
7. [Rule E — `lib/` is the floor](#7--rule-e--lib-is-the-floor)
8. [Rule F — dependencies point one way](#8--rule-f--dependencies-point-one-way)
9. [Vendored territory](#9--vendored-territory)
10. [Naming](#10--naming)
11. [Make it a gate, not a paragraph](#11--make-it-a-gate-not-a-paragraph)
12. [Adopting it in an existing codebase](#12--adopting-it-in-an-existing-codebase)
13. [What this standard deliberately does not say](#13--what-this-standard-deliberately-does-not-say)

---

## 1 · The one idea

**Every folder answers exactly one question about the file inside it.** Not "what
kind of thing is this" — that produces `utils/`, `helpers/`, `common/` and other
folders that mean nothing after month three. A question with a _checkable_ answer.

| Folder        | The question                     | Answered by                            |
| ------------- | -------------------------------- | -------------------------------------- |
| `routes/`     | what URL is this?                | the file's path                        |
| `components/` | how widely is it used?           | its importer count                     |
| `hooks/`      | do its consumers cross domains?  | how many areas import it               |
| `stores/`     | what state outlives a component? | it is a store or it is not             |
| `server/`     | what may the client call?        | it is a boundary function or it is not |
| `content/`    | what static data ships?          | it has no logic                        |
| `lib/`        | is it pure and isomorphic?       | its import list                        |

Every question above is answerable **by a script reading the module graph**, which is
the point. A convention nobody can measure is a convention that decays silently.

---

## 2 · The tree

```
src/
├── routes/            # the ONLY place a URL is declared
├── components/
│   ├── ui/            # design-system primitives — often vendored, see §9
│   ├── shared/        # imported by 2+ modules, grouped by domain
│   │   └── <domain>/
│   └── features/      # imported by exactly 1 module, grouped by feature
│       └── <feature>/
├── hooks/             # hooks whose consumers cross domains
├── stores/            # client state that outlives a component
├── server/
│   ├── <domain>.ts    # THE boundary: client-callable functions and types
│   ├── core/          # cross-domain infra: auth, db, middleware
│   └── <impl>/        # server-only implementation, never reached from the client
├── content/           # static catalogs, copy, seed data
└── lib/               # pure, isomorphic, framework-free
```

`components/` has exactly **three** children. A file directly at its root is the
first symptom of the standard eroding — it is a file whose question nobody asked.

---

## 3 · Rule A — `components/` splits by reuse count

```
imported by 2+ modules   → components/shared/<domain>/
imported by exactly 1    → components/features/<feature>/
imported by nobody       → it is dead; delete it
```

The count is the whole rule. It replaces an argument ("is this reusable?" — a
prediction) with a measurement ("is this reused?" — a fact).

**Three consequences that look like bugs and are not:**

1. **A second importer promotes a file, and losing one demotes it.** This is the
   feature, not overhead: the moment a `features/` component gets a second consumer
   it has become shared API, and _the move is how the rest of the team finds out_.
2. **`shared/` may import `features/`.** The buckets encode reuse count, **not**
   layering. A widely-used composer legitimately imports a menu that only it renders.
   Rewriting such an edge "downward" just relocates an unread file into the wrong
   bucket. Do not let a reviewer "fix" these.
3. **A satellite follows its owner, not its own count.** `x.util.ts` beside `x.tsx`
   stays with `x.tsx` whatever its count, because splitting the pair breaks the
   sibling import that made the pairing readable. Scope this narrowly — to a
   `<owner>.<qualifier>.ts` basename — or it becomes a loophole for every helper.

**Domain grouping inside each bucket** stays whatever your product already calls
things (`kanban/`, `billing/`, `onboarding/`). One `shared/common/` group is allowed
for leaves that genuinely belong to no domain — a spinner, an icon, a colour map.
It is a real group with a real definition, not a landing pad: anything with a domain
goes to that domain.

---

## 4 · Rule B — `hooks/` is for hooks that cross domains

The same question as Rule A, asked one level up: not _how many_ importers, but **how
many parts of the app** they sit in.

| Consumers span | Where it lives                                |
| -------------- | --------------------------------------------- |
| 2+ areas       | `hooks/use-<name>.ts`                         |
| exactly 1 area | that area's folder, then obeying Rule A there |
| only `routes/` | `hooks/` — routes cannot own a file (§5)      |
| nobody         | it is dead; delete it                         |

A hook used five times inside one feature is that feature's private plumbing.
Promoting it to `hooks/` advertises reuse that does not exist, and after a year the
folder is a list of thirty names nobody can place.

The "only routes" row is not a loophole, it is **forced**: since nothing may import
from `routes/`, a route-only hook has nowhere else to live. Expect data-loading
hooks to cluster there permanently, and that is correct.

---

## 5 · Rule C — a route declares a URL and nothing else

**A route file exports exactly one thing: its route object.** Not a helper, not a
type, not a constant — one export.

The moment a route exports a second thing, something imports the route to get it,
and the route stops being a leaf. Now a URL declaration is on the import graph of
your components, and moving a page breaks a component that never rendered it.

- Wanting to reuse something out of a route is the signal to **extract** it: to
  `hooks/` if it needs the route's loader, to `components/` if it is a view.
- Read a route's loader through your router's by-id accessor, never by importing the
  route object itself.
- Prefer **nested directories** over flat dot-notation filenames. Dot-notation makes
  the parent/child relationship invisible in a file tree, and layout nesting is
  exactly the thing you need to see.
- ⚠️ Check how your router treats a file that exports the _wrong_ symbol name. Many
  drop it from the tree with a **warning**, not an error — the page simply 404s in
  production while the build stays green.

---

## 6 · Rule D — the server boundary is thin

Split server code in two, and never let the halves merge:

```
server/<domain>.ts   ← the boundary. Client-callable functions + types. NOTHING else.
server/<impl>/…      ← the implementation. Filesystem, database, secrets.
```

**Why the boundary may export nothing else at runtime:** frameworks that let you
call a server function from client code strip the function's **handler body** — not
the module. Any _other_ runtime export in that file ships to the browser and drags
the module's entire import list with it. One exported constant is enough to put your
database client, your auth middleware or a `node:` builtin into a client chunk.

When a boundary grows a non-function export, place it by **who needs it**:

| Who needs it              | Where it goes                                     |
| ------------------------- | ------------------------------------------------- |
| both client and server    | it is not server code → `lib/`                    |
| only the server           | a `-core.ts` sibling; re-export only its **type** |
| nobody outside the module | drop the `export`                                 |

**Keep boundaries paired with implementations** (`server/orders.ts` ↔
`server/db/orders.ts`). A boundary with logic inside it grows helpers, helpers get
exported, and you are back to the previous paragraph.

**From client code, a server-only module may be reached only by `import type`**, a
boundary call, or a dynamic `import()` inside a server-side handler. A type is erased
at compile time and carries no module into the bundle — that is why the exemption is
safe, and why it must be checked as _runtime vs type_, not as "does this file import
that file".

> ⚠️ **A green local build is not proof.** If your dev setup shims a platform
> builtin (a Node polyfill for an edge runtime, say), the offending edge resolves
> locally and only fails on the real target. Grep the built client bundle for the
> literal strings you never want there — `node:fs`, your ORM's package name, your
> API host — and assert zero.

---

## 7 · Rule E — `lib/` is the floor

`lib/` is what everything else may import. That only works while `lib/` imports
nothing back.

- **Isomorphic.** No `node:*`, no platform builtins, no database client, no
  server-only SDK. A module that imports one of those is server code, however small.
  It stays server code even if every current importer happens to use `import type` —
  that is precisely how such modules hide for months.
- **Framework-free.** No React (or your framework), no hooks, no JSX. A `use*` export
  in `lib/` means it belongs in `hooks/` or beside its component.
- **No upward imports.** Never `components/`, `hooks/`, `stores/`, `routes/`. If a
  `lib/` module needs a value that lives up there, the **value** is misplaced, not
  the import — move the value down.

A `lib/` that obeys these three is the only part of the app you can test without a
DOM, a server, or a router.

### When a `lib/` module becomes a folder

`lib/` is where "let's group the related ones" is most tempting and most wrong. A
folder there is legitimate in exactly one shape:

> **One public entry, several internal parts.** `thing.ts` is a barrel over
> `thing/`. Consumers import `thing` and nothing else. If they would reach past the
> barrel into the folder, it is not one module — it is a topic folder wearing a
> costume.

So the trigger is **one module outgrowing one file**, never *several modules sharing
a subject*. `pricing/`, `format/`, `colors/` are subjects; they tell you what a file
is about, which you already knew from its name, and cost you a directory hop.

**Measure before you group.** Two numbers settle it:

1. **Internal edges** — how often these modules import each other. A real module
   split across files is densely connected. Near-zero edges means they are strangers
   who happen to share a topic.
2. **Consumer overlap** — of everyone importing either module, what fraction imports
   both (Jaccard). One module in pieces sits high; unrelated neighbours sit low.

When this standard's own repo was measured, `lib/` had **5 internal edges across 19
modules** and a **peak overlap of 33%** — including for the pair that looked most
related by name. Every topic folder proposed for it would have been a grouping no
consumer's import list agreed with. The single module that *did* qualify was found
by size, not subject: 1101 lines and six separable concerns behind one filename.

**The honest default for `lib/` is flat.** A flat folder of well-named modules is
searchable, greppable and has no wrong answers. Reach for a subfolder only when one
module has genuinely outgrown one file — and then give it a barrel, so the split
stays invisible to everyone who does not maintain it.

---

## 8 · Rule F — dependencies point one way

```
routes → components → hooks → stores → server → content → lib
```

Each layer may import layers to its **right** at runtime, never to its left.
`import type` is exempt at every step.

Derive the exact order from your own graph rather than copying this line — measure
which direction the edges already run, pick the order that makes the fewest existing
edges illegal, then fix those. An order invented on a whiteboard will disagree with
the code and lose.

---

## 9 · Vendored territory

Any folder written by a **code generator or component-registry CLI** is exempt from
every rule above, and must be marked as such in one place everyone reads.

Typically: `components/ui/`, generated route manifests, generated API clients, icon
sets, database migrations.

Two failure modes, both silent:

- **Moving a generated file.** The generator writes it back at the original path on
  the next run. Now there are two copies and the stale one still compiles.
- **A generated file importing your app code.** The next regeneration erases that
  edge without a word. Dependencies must point _out of_ your app _into_ vendored
  code, never the reverse.

So: vendored code may import other vendored code and `lib/`. Nothing else. If a
registry primitive genuinely needs app behaviour, invert it — pass the behaviour in
as a prop or a render function.

⚠️ **Edits to vendored files, and lint exceptions for them, belong in a config file
the generator cannot overwrite** — a root-level lint config, not an inline ignore
comment inside the generated file.

---

## 10 · Naming

- **One case for hand-authored files** — kebab-case is the usual pick. Generated and
  vendored files keep whatever case their tool emits (see §9); list those exceptions
  explicitly.
- **A filename never repeats its folder**: `kanban/board.tsx`, not
  `kanban/kanban-board.tsx`. The exception is a prefix that _distinguishes among
  siblings_ — `agent-card` earns its prefix in a folder that also holds
  `community-card` and `weapon-card`.
- **Hooks are `use-<kebab>.ts`.** A file in `hooks/` that does not start with `use`
  is not a hook; it is a `lib/` function.
- ⚠️ **Audit case with `basename | LC_ALL=C grep '[A-Z]'`, never `find -name '[A-Z]*'`.**
  macOS and Windows filesystems are case-insensitive, so `find` matches everything
  and reports nothing.

---

## 11 · Make it a gate, not a paragraph

Every rule here encodes a fact that is **invisible when you have one file open** —
an importer count, a layer direction, a runtime-vs-type edge. Your type checker,
linter and bundler pass on every violation above. That is not a gap in your tooling;
those tools answer different questions. It does mean a script has to hold the line.

Write one script that builds the module graph and checks all of it:

```
1. Parse every source file for import/export specifiers, including dynamic import().
2. Resolve each specifier to a real file (handle your path aliases AND relative
   paths; try .ts/.tsx/index.* the way your bundler does).
3. Record each edge as runtime or type-only.
4. Then assert:
   A. every components/ file sits in the bucket its importer count demands
   B. every hooks/ file has consumers in 2+ areas, or only in routes/
   C. every routes/ file has exactly one export, with the expected name
   D. every server boundary exports only boundary functions and types
   E. lib/ imports no framework and nothing upward
   F. no runtime edge points backwards along the layer order
   G. no vendored file imports app code
   H. nothing is imported by nobody
5. Exit non-zero with file, line and the measured number — not just "violation".
```

Three things that decide whether the gate survives its first month:

- **It must pass on day one.** A gate that fails on a fresh checkout gets commented
  out within a week. Land the moves first, the gate second.
- **Accepted exceptions are a named, explained list in the script** — never a silent
  `continue`. Give each one a reason and the condition under which it goes away.
- **Print the exceptions on every successful run.** An exception nobody sees is an
  exception that quietly becomes the norm. Also flag entries that no longer match
  anything, so the list cannot rot.

Report the numbers on success (`43 shared / 54 features / 97 vendored`). People trust
a check that tells them what it counted.

---

## 12 · Adopting it in an existing codebase

Doing this by hand is how it stalls halfway. Script it.

1. **Measure first, decide second.** Print every file with its importer count and the
   areas those importers live in. Read that list before choosing a single
   destination — it usually contradicts what you assumed, and it will find dead files.
2. **Write the move table explicitly.** A literal `old path → new path` map you can
   read in a diff. Do not infer destinations from a clever rule at runtime; you want
   the decision reviewable, and you want it to fail loudly on a typo.
3. **Rewrite specifiers before moving files**, using the graph you already built. For
   each import: resolve it against the _old_ layout, look up the target's _new_ path,
   re-emit as a sibling-relative path if both end up in one folder, otherwise as an
   absolute alias.
4. **Move with `git mv`** so history follows. Handle untracked files separately —
   `git mv` fails on them, and a half-finished move loop is a bad place to be.
5. **Grep for paths that live in config _strings_.** Build configs, package manifests,
   component-registry configs, generator scripts, CI workflows, documentation. None of
   these are type-checked, and a wrong string here fails at runtime or ships a broken
   package.
6. **Prove the routes did not change**: dump every route id/path from your generated
   manifest before and after, and diff. It must be empty.
7. **Gate honestly.** Record which checks were already failing _before_ you started —
   on a worktree of the original commit, not from memory — so you can prove your
   change added nothing. Reformatting caused by longer import paths is yours to fix;
   pre-existing failures are not yours to hide.
8. **Land it alone.** A layout migration mixed into a feature branch is unreviewable,
   and `git log --follow` is the first casualty.

---

## 13 · What this standard deliberately does not say

- **How to group domains.** Use your product's words. A folder taxonomy imported from
  someone else's app is worse than a slightly untidy one that matches how your team
  talks.
- **Barrel files (`index.ts`).** They trade import ergonomics for slower cold builds
  and worse tree-shaking. Pick one answer per repo, write it down, and do not mix.
- **Colocated tests.** Beside the source or in a mirror tree — both work. Whichever
  you pick, exclude test files from importer counts, or every helper looks reused.
- **File size limits.** Split when a file has two reasons to change, not at a line
  count. A 400-line component with one job beats four files with a shared secret.
- **State management.** `stores/` here means "client state that outlives a
  component", whatever library provides it.

The rules above are the ones worth enforcing because they are the ones that fail
**silently**. Everything else is style, and style is cheaper to argue about than to
automate.
