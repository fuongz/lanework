import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "../../.agents/artifacts/test-results",
  workers: 1,
  projects: [
    { name: "production", testIgnore: ["dev.spec.ts", "packaged.spec.ts"] },
    { name: "development", testMatch: "dev.spec.ts" },
    { name: "packaged", testMatch: "packaged.spec.ts" },
  ],
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
});
