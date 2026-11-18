import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
    headless: true,
    trace: "retain-on-failure",
  },
  outputDir: "reports/browser",
  webServer: {
    command: "node --import tsx server/demo.ts",
    url: "http://localhost:3100",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      PORT: "3100",
      APP_ORIGIN: "http://localhost:3100",
      ALLOW_DEV_SEED: "true",
      DEMO_PASSWORD: "Browser-test-only-2026!",
      NODE_ENV: "development",
    },
  },
});
