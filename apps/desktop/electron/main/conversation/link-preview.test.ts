// Run with `bun test apps/desktop/electron/main/conversation`.
//
// Link previews (FE-62/D4): the second ask, in this run or the next, does not
// touch the network, and private addresses are refused. FE-79: only the
// previewed hosts on their default port, at most four fetches at once, no raw
// URL on disk, and a hostile head parsed in linear time.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  createLinkPreviews,
  type Fetched,
  type Fetcher,
  isPrivateAddress,
  netFetcher,
  parseHead,
} from "./link-preview";

const dir = mkdtempSync(join(tmpdir(), "lanework-previews-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The first bytes of a PNG: enough for the icon's type to be found. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/**
 * A fetcher that serves one page and its 32px icon, and records each URL it
 * was asked for.
 */
function fakeFetcher(): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url): Promise<Fetched> => {
    calls.push(url);
    if (url.endsWith("/icon-32.png"))
      return {
        status: 200,
        headers: { "content-type": "image/png" },
        body: PNG,
        url,
      };
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(
        `<html><head><title> Example &amp; Co </title>
         <link rel="apple-touch-icon" href="/touch.png">
         <link rel="icon" sizes="32x32" href="/icon-32.png"></head></html>`,
      ),
      url,
    };
  };
  return { fetcher, calls };
}

describe("link previews", () => {
  test("cached in memory and on disk per domain", async () => {
    const { fetcher, calls } = fakeFetcher();
    const preview = createLinkPreviews({ dir, fetcher });
    const first = await preview("https://github.com/page#top");
    assert.equal(first.url, "https://github.com/page#top");
    assert.equal(first.title, "Example & Co");
    assert.equal(first.icon, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.deepEqual(calls, [
      "https://github.com/page",
      "https://github.com/icon-32.png",
    ]);

    // Again, twice at once: no network.
    const [again, twice] = await Promise.all([
      preview("https://github.com/page"),
      preview("https://github.com/page"),
    ]);
    assert.equal(again.title, "Example & Co");
    assert.equal(twice.icon, first.icon);
    assert.equal(calls.length, 2);

    // The next run reads the disk.
    const next = fakeFetcher();
    const later = createLinkPreviews({ dir, fetcher: next.fetcher });
    const cached = await later("https://github.com/page");
    assert.deepEqual(cached, {
      url: "https://github.com/page",
      title: "Example & Co",
      icon: first.icon,
    });
    assert.equal(next.calls.length, 0);

    // Another page on the domain: its title is fetched, the icon is not.
    await later("https://github.com/other");
    assert.deepEqual(next.calls, ["https://github.com/other"]);
  });

  test("concurrent asks share one fetch", async () => {
    const { fetcher, calls } = fakeFetcher();
    const preview = createLinkPreviews({ dir: join(dir, "b"), fetcher });
    await Promise.all([
      preview("https://gist.github.com/"),
      preview("https://gist.github.com/"),
    ]);
    assert.equal(calls.length, 2);
  });

  test("expired after seven days", async () => {
    const { fetcher, calls } = fakeFetcher();
    let now = Date.parse("2026-10-16T00:00:00Z");
    const preview = createLinkPreviews({
      dir: join(dir, "c"),
      fetcher,
      now: () => now,
    });
    await preview("https://www.github.com/");
    now += 8 * 24 * 60 * 60_000;
    const fresh = createLinkPreviews({
      dir: join(dir, "c"),
      fetcher,
      now: () => now,
    });
    await fresh("https://www.github.com/");
    assert.equal(calls.length, 4);
  });

  test("refuses what is not http(s)", () => {
    const preview = createLinkPreviews({ dir, fetcher: fakeFetcher().fetcher });
    assert.throws(() => preview("file:///etc/passwd"));
    assert.throws(() => preview("javascript:alert(1)"));
  });

  test("refuses a host the agent chose, or another port", () => {
    const preview = createLinkPreviews({ dir, fetcher: fakeFetcher().fetcher });
    assert.throws(() => preview("https://attacker.example/?d=secret"));
    assert.throws(() => preview("https://evil.github.com/"));
    assert.throws(() => preview("https://github.com:6379/"));
  });

  test("no raw URL on disk; legacy files removed", async () => {
    const folder = join(dir, "d");
    mkdirSync(folder, { recursive: true });
    const legacy = "0123456789abcdef0123456789abcdef.json";
    writeFileSync(join(folder, legacy), "{}");
    const preview = createLinkPreviews({
      dir: folder,
      fetcher: fakeFetcher().fetcher,
    });
    await preview("https://github.com/a?token=secret");
    const files = readdirSync(folder);
    assert.equal(files.includes(legacy), false);
    for (const file of files)
      assert.equal(
        readFileSync(join(folder, file), "utf8").includes("token=secret"),
        false,
      );
  });

  test("at most four fetches at once", async () => {
    let running = 0;
    let most = 0;
    const fetcher: Fetcher = async (url) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { status: 404, headers: {}, body: Buffer.alloc(0), url };
    };
    const preview = createLinkPreviews({ dir: join(dir, "e"), fetcher });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => preview(`https://github.com/${i}`)),
    );
    assert.equal(most, 4);
  });

  test("private addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ])
      assert.equal(isPrivateAddress(address), true, address);
    for (const address of ["93.184.216.34", "2606:4700::1111", "8.8.8.8"])
      assert.equal(isPrivateAddress(address), false, address);
    await assert.rejects(netFetcher("http://localhost:1/", 10));
    await assert.rejects(netFetcher("http://127.0.0.1:1/", 10));
    await assert.rejects(netFetcher("http://[::1]:1/", 10));
  });

  test("parses a head", () => {
    const head = parseHead(
      `<title>A &#8211; B</title><link href="/fav.svg" rel="icon" type="image/svg+xml">`,
      "https://x.example/a/b",
    );
    assert.deepEqual(head, {
      title: "A – B",
      icon: "https://x.example/fav.svg",
    });
    assert.deepEqual(parseHead("<p>no head</p>", "https://x.example/a"), {
      title: null,
      icon: "https://x.example/favicon.ico",
    });
  });

  test("parses a hostile head in linear time", () => {
    const hostile = [
      "<meta ".repeat(80_000),
      "<link ".repeat(80_000),
      "<title>".repeat(70_000),
      `<head><link rel="icon" ${"a".repeat(64 * 1024)}>`,
    ];
    for (const html of hostile) {
      const start = performance.now();
      parseHead(html, "https://x.example/");
      assert.ok(performance.now() - start < 50, html.slice(0, 12));
    }
  });
});
