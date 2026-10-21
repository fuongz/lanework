#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for `tests/pulls.spec.ts`.
 *
 * The app runs it through `LANEWORK_GH_PATH`. It answers only the commands
 * `electron/main/git/` runs, from files in `$FAKE_GH_STATE`:
 *
 * - `scenario.json` (written by the test): the account, repos, pull requests,
 *   diffs, commits, file contents, and `fail` rules.
 * - `state.json` (written here): what the writes changed — merged pull
 *   requests and posted comments — so a later read sees them.
 * - `calls.jsonl` (appended here): one line per run, `{ argv, stdin, code }`,
 *   so a test can assert what was asked.
 *
 * NOTE: the variable is not `LANEWORK_*`. `gh.ts` strips every `LANEWORK_*`
 * variable from the environment `gh` runs with, so such a name never arrives.
 * The test's wrapper script sets it.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_GH_STATE;
if (!dir) {
  process.stderr.write("fake gh: FAKE_GH_STATE is not set\n");
  process.exit(2);
}

const argv = process.argv.slice(2);
const stdin = argv.includes("--body-file") ? readFileSync(0, "utf8") : null;
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));

function readState() {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return { merged: [], comments: {} };
  }
}

function writeState(state) {
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

/** Thrown to end the run; the bottom of the file prints it. */
class Exit {
  constructor(code, stdout, stderr) {
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * End the run with this answer.
 *
 * NOTE: thrown, not `process.exit`. A pipe on macOS is written
 * asynchronously, and exiting at once can cut a long diff short.
 */
function finish(code, stdout = "", stderr = "") {
  throw new Exit(code, stdout, stderr);
}

function json(value) {
  finish(0, `${JSON.stringify(value)}\n`);
}

/** The value after `flag`, or null. */
function option(flag) {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

/** Only the `--json` fields asked for, as `gh` prints them. */
function pick(row, fields) {
  const out = {};
  for (const field of fields.split(","))
    if (field in row) out[field] = row[field];
  return out;
}

function main() {
  // A `fail` rule whose `args` start this argv answers instead of the scenario.
  for (const rule of scenario.fail ?? []) {
    if (rule.args.every((arg, index) => argv[index] === arg))
      finish(rule.code ?? 1, "", rule.stderr);
  }

  const state = readState();

  /** One pull request with this run's writes laid over it. */
  function pullOf(repo, number) {
    const row = (scenario.pulls?.[repo] ?? []).find(
      (pull) => pull.number === number,
    );
    if (!row) return null;
    const key = `${repo}#${number}`;
    const posted = (state.comments[key] ?? []).map((comment, index) => ({
      id: `IC_posted_${index}`,
      author: { login: scenario.user?.login ?? "tester" },
      body: comment.body,
      createdAt: comment.at,
    }));
    return {
      ...row,
      ...(state.merged.includes(key) ? { state: "MERGED" } : {}),
      comments: [...(row.comments ?? []), ...posted],
    };
  }

  const notFound = (what) =>
    `GraphQL: Could not resolve to a ${what}. (repository)`;

  const [group, command] = argv;

  if (group === "auth" && command === "status") {
    if (scenario.account === "ok")
      finish(
        0,
        "",
        `github.com\n  ✓ Logged in to github.com account ${scenario.user.login} (keyring)`,
      );
    finish(
      1,
      "",
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    );
  }

  if (group === "api") {
    const endpoint = argv[1];
    if (endpoint === "user") json(scenario.user);
    if (endpoint === "graphql")
      json({
        data: {
          rateLimit: scenario.rateLimit ?? {
            remaining: 5000,
            resetAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      });
    const commit = /^repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/i.exec(
      endpoint,
    );
    if (commit) {
      const data = scenario.commits?.[commit[1]];
      if (data) json(data);
      finish(1, "", "gh: No commit found for SHA (HTTP 422)");
    }
    const file = /^repos\/[^/]+\/[^/]+\/contents\/([^?]+)\?ref=(.+)$/.exec(
      endpoint,
    );
    if (file) {
      const path = file[1].split("/").map(decodeURIComponent).join("/");
      const text =
        scenario.contents?.[`${path}@${decodeURIComponent(file[2])}`];
      if (typeof text === "string") finish(0, text);
      finish(1, "", "gh: Not Found (HTTP 404)");
    }
    finish(1, "", "gh: Not Found (HTTP 404)");
  }

  if (group === "repo" && command === "view") {
    const name = argv[2] && !argv[2].startsWith("-") ? argv[2] : null;
    const fields = option("--json") ?? "";
    if (!name)
      finish(
        1,
        "",
        "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
      );
    const repo = scenario.repos?.[name];
    if (!repo) finish(1, "", notFound(`Repository with the name '${name}'`));
    json(pick(repo, fields));
  }

  if (group === "pr") {
    const repo = option("--repo");
    if (command === "list") {
      const wanted = option("--state");
      const unmerged = option("--search") === "is:unmerged";
      const rows = (scenario.pulls?.[repo] ?? [])
        .map((pull) => pullOf(repo, pull.number))
        .filter((pull) => {
          if (wanted === "all") return true;
          if (wanted === "closed")
            return unmerged
              ? pull.state === "CLOSED"
              : pull.state === "CLOSED" || pull.state === "MERGED";
          return pull.state === wanted?.toUpperCase();
        });
      json(rows.map((pull) => pick(pull, option("--json") ?? "")));
    }

    const number = Number(argv[2]);
    const pull = pullOf(repo, number);
    if (!pull)
      finish(
        1,
        "",
        notFound(`PullRequest with the number of ${argv[2]}`).replace(
          "(repository)",
          "(repository.pullRequest)",
        ),
      );

    if (command === "view") json(pick(pull, option("--json") ?? ""));
    if (command === "diff")
      finish(0, scenario.diffs?.[`${repo}#${number}`] ?? "");
    if (command === "merge") {
      state.merged.push(`${repo}#${number}`);
      writeState(state);
      finish(0, "", `✓ Merged pull request ${repo}#${number}`);
    }
    if (command === "review")
      finish(0, "", `✓ Reviewed pull request ${repo}#${number}`);
    if (command === "comment") {
      const key = `${repo}#${number}`;
      state.comments[key] = [
        ...(state.comments[key] ?? []),
        { body: stdin ?? "", at: new Date().toISOString() },
      ];
      writeState(state);
      finish(0, `https://github.com/${repo}/pull/${number}#issuecomment-1\n`);
    }
  }

  finish(1, "", `unknown command "${argv.join(" ")}" for fake gh`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof Exit)) throw error;
  appendFileSync(
    join(dir, "calls.jsonl"),
    `${JSON.stringify({ argv, stdin, code: error.code, at: new Date().toISOString() })}\n`,
  );
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr)
    process.stderr.write(
      error.stderr.endsWith("\n") ? error.stderr : `${error.stderr}\n`,
    );
  process.exitCode = error.code;
}
