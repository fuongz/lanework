// Run with `bun test ./electron/main/metrics/log.test.ts` from apps/desktop.
// Written against `node:test`/`node:assert`, as the store's specs are.
//
// FE-115: the resource log's file names, its route templates and its 24-hour
// window.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MetricsSample } from "../../../shared/metrics";
import {
  appendSample,
  hourFile,
  KEEP_HOURS,
  pruneSamples,
  routeTemplate,
} from "./log";

describe("routeTemplate", () => {
  test("keeps the app's own words and hides names and ids", () => {
    assert.equal(routeTemplate("/w/acme/board"), "/w/$/board");
    assert.equal(
      routeTemplate("/w/acme/agents/chat/3f2a-91?tab=x#end"),
      "/w/$/agents/chat/$",
    );
    assert.equal(routeTemplate("/w/acme/pulls/42"), "/w/$/pulls/$");
    assert.equal(routeTemplate("/settings/about"), "/settings/about");
    assert.equal(routeTemplate("/"), "/");
    assert.equal(routeTemplate(null), null);
  });

  test("a slug spelled like a word is still hidden", () => {
    assert.equal(routeTemplate("/w/board/board"), "/w/$/board");
  });
});

describe("hour files", () => {
  test("one file per UTC hour", () => {
    assert.equal(
      hourFile(new Date("2026-10-31T09:41:07Z")),
      "2026-10-31T09.jsonl",
    );
  });

  test("a sample is one JSON line in its hour's file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    const sample = { t: "2026-10-31T09:41:07.000Z" } as MetricsSample;
    await appendSample(dir, sample);
    await appendSample(dir, sample);
    const lines = readFileSync(join(dir, "2026-10-31T09.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ""), sample);
  });

  test(`keeps the newest ${KEEP_HOURS} hours and nothing else it does not own`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    const now = new Date("2026-10-31T09:30:00Z");
    const kept = ["2026-10-31T09.jsonl", "2026-10-30T10.jsonl"];
    const old = ["2026-10-30T09.jsonl", "2026-10-29T23.jsonl"];
    for (const name of [...kept, ...old, "notes.txt"])
      writeFileSync(join(dir, name), "");
    const gone = await pruneSamples(dir, now);
    assert.deepEqual(gone.sort(), [...old].sort());
    assert.deepEqual(readdirSync(dir).sort(), [...kept, "notes.txt"].sort());
  });
});
