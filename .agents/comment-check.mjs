// Proves a comment-only edit: every file given (or every changed .ts/.tsx/
// .mjs/.css file when none is) compiles to the same JavaScript at HEAD and now.
// Whitespace is minified so esbuild drops EVERY comment — it keeps the ones
// inside object literals and calls otherwise — and any difference left is a
// code change.
//
//   node .agents/comment-check.mjs [files…]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transformSync } = require(
  require.resolve("esbuild", { paths: ["apps/desktop", "."] }),
);

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

let files = process.argv.slice(2);
if (files.length === 0)
  files = git("diff", "--name-only", "HEAD")
    .split("\n")
    .filter((file) => /\.(ts|tsx|mjs|css)$/.test(file));

const LOADERS = { ".tsx": "tsx", ".mjs": "js", ".css": "css" };
const loaderOf = (file) => LOADERS[file.slice(file.lastIndexOf("."))] ?? "ts";

const compile = (source, file) =>
  transformSync(source, {
    loader: loaderOf(file),
    jsx: "preserve",
    legalComments: "none",
    minifyWhitespace: true,
    format: "esm",
  }).code;

let bad = 0;
for (const file of files) {
  let before;
  try {
    before = git("show", `HEAD:${file}`);
  } catch {
    continue; // A new file has nothing to compare with.
  }
  try {
    if (compile(before, file) !== compile(readFileSync(file, "utf8"), file)) {
      bad++;
      console.log(`CODE CHANGED  ${file}`);
    }
  } catch (error) {
    bad++;
    console.log(`DOES NOT PARSE  ${file}: ${error.message.split("\n")[0]}`);
  }
}
console.log(bad ? `${bad} of ${files.length} files differ` : `ok — ${files.length} files, comments only`);
process.exit(bad ? 1 : 0);
