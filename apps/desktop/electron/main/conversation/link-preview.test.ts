// Run with `bun test apps/desktop/electron/main/conversation`. Link previews
// (FE-62/D4): the second ask — in this run or the next — does not touch the
// network, and private addresses are refused.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

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
    const first = await preview("https://example.com/page#top");
    assert.equal(first.url, "https://example.com/page#top");
    assert.equal(first.title, "Example & Co");
    assert.equal(first.icon, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.deepEqual(calls, [
      "https://example.com/page",
      "https://example.com/icon-32.png",
    ]);

    // Again, twice at once: no network.
    const [again, twice] = await Promise.all([
      preview("https://example.com/page"),
      preview("https://example.com/page"),
    ]);
    assert.equal(again.title, "Example & Co");
    assert.equal(twice.icon, first.icon);
    assert.equal(calls.length, 2);

    // The next run reads the disk.
    const next = fakeFetcher();
    const later = createLinkPreviews({ dir, fetcher: next.fetcher });
    const cached = await later("https://example.com/page");
    assert.deepEqual(cached, {
      url: "https://example.com/page",
      title: "Example & Co",
      icon: first.icon,
    });
    assert.equal(next.calls.length, 0);

    // Another page on the domain: its title is fetched, the icon is not.
    await later("https://example.com/other");
    assert.deepEqual(next.calls, ["https://example.com/other"]);
  });

  test("concurrent asks share one fetch", async () => {
    const { fetcher, calls } = fakeFetcher();
    const preview = createLinkPreviews({ dir: join(dir, "b"), fetcher });
    await Promise.all([
      preview("https://a.example/"),
      preview("https://a.example/"),
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
    await preview("https://b.example/");
    now += 8 * 24 * 60 * 60_000;
    const fresh = createLinkPreviews({
      dir: join(dir, "c"),
      fetcher,
      now: () => now,
    });
    await fresh("https://b.example/");
    assert.equal(calls.length, 4);
  });

  test("refuses what is not http(s)", () => {
    const preview = createLinkPreviews({ dir, fetcher: fakeFetcher().fetcher });
    assert.throws(() => preview("file:///etc/passwd"));
    assert.throws(() => preview("javascript:alert(1)"));
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
});
