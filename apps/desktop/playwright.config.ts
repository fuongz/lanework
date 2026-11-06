import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "../../.agents/artifacts/test-results",
  workers: 1,
  projects: [
    // `gallery.spec.ts` is excluded from `production`. It is not a test: it
    // asserts nothing and writes ~30 PNGs. Running it with the suite would slow
    // every run and rewrite artifacts nobody asked for.
    {
      name: "production",
      testIgnore: [
        "dev.spec.ts",
        "packaged.spec.ts",
        "gallery.spec.ts",
        "showcase.spec.ts",
      ],
    },
    { name: "gallery", testMatch: "gallery.spec.ts", timeout: 180_000 },
    // Marketing shots at 2x, raw and framed. Not a test either.
    { name: "showcase", testMatch: "showcase.spec.ts", timeout: 240_000 },
    { name: "development", testMatch: "dev.spec.ts" },
    { name: "packaged", testMatch: "packaged.spec.ts" },
  ],
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
});
