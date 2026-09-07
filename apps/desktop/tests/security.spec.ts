import { expect, test } from "@playwright/test";
import { assetPath, isTrustedUrl } from "../electron/main/security";

test("only the app origin or exact dev origin is trusted", () => {
  expect(isTrustedUrl("app://lanework/settings")).toBe(true);
  for (const url of [
    "app://evil/settings",
    "https://lanework/",
    "file:///tmp/index.html",
    "app://user@lanework",
    "app://lanework:99/",
  ])
    expect(isTrustedUrl(url)).toBe(false);
  expect(
    isTrustedUrl("http://127.0.0.1:5175/settings", "http://127.0.0.1:5175"),
  ).toBe(true);
  expect(isTrustedUrl("http://127.0.0.1:5174", "http://127.0.0.1:5175")).toBe(
    false,
  );
});

test("asset resolution cannot escape the client directory", () => {
  expect(assetPath("/app/client", "/assets/main.js")).toBe(
    "/app/client/assets/main.js",
  );
  for (const path of [
    "/../secret",
    "/%2e%2e/secret",
    "/%2e%2e%2fsecret",
    "/bad%00.js",
    "/..%5csecret",
    "/%zz",
    "relative",
  ])
    expect(assetPath("/app/client", path)).toBeUndefined();
});
