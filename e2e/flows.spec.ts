import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Browser-test-only-2026!");
  await page.getByRole("button", { name: "Enter workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Catalog", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".loading")).toHaveCount(0);
}
test("researcher and reviewer: access, export, assistant, revocation, and evaluation", async ({
  browser,
  page,
}) => {
  await mkdir("reports", { recursive: true });
  await login(page, "researcher@bioaccess.test");
  await page.screenshot({
    path: "reports/catalog-desktop.png",
    fullPage: true,
  });
  const card = page.locator(".dataset-card").filter({
    has: page.getByRole("heading", { name: "Comparison measurements" }),
  });
  await card.getByRole("button", { name: "Request access" }).click();
  await page
    .getByLabel("Purpose of access")
    .fill("Compare fictional measurements to test the access workflow.");
  await page.getByLabel("Export (requires additional approval)").check();
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Request submitted");
  const reviewerContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  await login(reviewer, "reviewer@bioaccess.test");
  await reviewer.getByRole("button", { name: /Requests/ }).click();
  let section = reviewer.locator("section").filter({
    has: reviewer.getByRole("heading", {
      name: "Dataset access",
      exact: true,
    }),
  });
  await section
    .getByRole("row")
    .filter({ hasText: "Comparison measurements" })
    .getByRole("button", { name: "Approve for 7 days" })
    .click();
  await expect(section.getByText("Approved")).toBeVisible();
  await page.getByRole("button", { name: /Requests/ }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".loading")).toHaveCount(0);
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Dataset", exact: true })
    .selectOption("d2");
  await page.getByLabel("Limit", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Query →", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Request export", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Export requested");
  await reviewer.getByRole("button", { name: "Refresh", exact: true }).click();
  section = reviewer.locator("section").filter({
    has: reviewer.getByRole("heading", {
      name: "Exports · single-use approval",
    }),
  });
  await section.getByRole("button", { name: "Approve for 15 min" }).click();
  await expect(section.getByText("Approved")).toBeVisible();
  await page.getByRole("button", { name: /Requests/ }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download JSON", exact: true })
    .click();
  const file = await download;
  const exported = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(exported.records).toHaveLength(2);
  expect(exported.records.every((r: any) => r.id.startsWith("d2-"))).toBe(true);
  await expect(page.getByText("Consumed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Summarize the records");
  await page.getByRole("button", { name: "Send →", exact: true }).click();
  await expect(page.locator(".message.agent")).toContainText(
    "records · average",
  );
  section = reviewer.locator("section").filter({
    has: reviewer.getByRole("heading", {
      name: "Granted permissions",
      exact: true,
    }),
  });
  await section
    .getByRole("row")
    .filter({ hasText: "Comparison measurements" })
    .getByRole("button", { name: "Revoke access" })
    .click();
  await expect(section.getByText("Revoked", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Query records");
  await page.getByRole("button", { name: "Send →", exact: true }).click();
  await expect(page.locator(".message.agent").last()).toContainText("revoked");
  await reviewer
    .getByRole("button", { name: "Audit log", exact: true })
    .click();
  await reviewer
    .getByRole("combobox", { name: "Result", exact: true })
    .selectOption("deny");
  await reviewer.getByRole("button", { name: "Filter events" }).click();
  await expect(reviewer.locator("tbody")).toContainText("grant_revoked");
  await reviewer
    .getByRole("button", { name: "Evaluation", exact: true })
    .click();
  await expect(reviewer.locator("tbody tr")).toHaveCount(11);
  await reviewer.screenshot({
    path: "reports/evaluation-desktop.png",
    fullPage: true,
  });
  await reviewerContext.close();
});
test("mobile layout and administration controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "admin@bioaccess.test");
  await expect(page.locator("body")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "reports/catalog-mobile.png", fullPage: true });
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Create user", exact: true }),
  });
  await form.getByLabel("Name", { exact: true }).fill("Test researcher");
  await form.getByLabel("Email", { exact: true }).fill("new@bioaccess.test");
  await form
    .getByLabel("Initial password (12+ characters)")
    .fill("Synthetic-browser-password!");
  await form.getByRole("button", { name: "Create user", exact: true }).click();
  await expect(page.locator("tbody")).toContainText("new@bioaccess.test");
});
