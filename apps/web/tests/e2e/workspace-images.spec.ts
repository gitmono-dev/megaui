import { expect, test } from "@playwright/test";
import { mintSessionCookies } from "./helpers/session";

test("shows image repositories and their tags", async ({ page, context }) => {
  await context.addCookies(mintSessionCookies().cookies);
  await page.route("**/api/mega/channels**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/mega/cls**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/mega/images**", route => {
    const url = new URL(route.request().url());
    const isTags = url.pathname.endsWith("/tags");
    const isNext = url.searchParams.has("after");
    return route.fulfill({ json: { data: isTags ? { items: ["v1", "latest"], next: null } : isNext ? { items: ["team/other"], next: null } : { items: ["team/image"], next: "team/image" } } });
  });
  await page.goto("/en/workspace/images");
  await expect(page.getByRole("link", { name: "Images" })).toBeVisible();
  await expect(page.getByRole("button", { name: "team/image" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "team/other" })).toBeVisible();
  await page.getByRole("button", { name: "team/image" }).click();
  await expect(page.getByRole("heading", { name: "team/image" })).toBeVisible();
  await expect(page.getByText("latest", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All repositories" }).click();
  await expect(page.getByRole("button", { name: "team/image" })).toBeVisible();
});

test("shows registry failure without treating it as an empty catalog", async ({ page, context }) => {
  await context.addCookies(mintSessionCookies().cookies);
  await page.route("**/api/mega/images**", route => route.fulfill({ status: 503, json: { error: { message: "unavailable" } } }));
  await page.goto("/en/workspace/images");
  await expect(page.locator('[data-mega-images="page"]').getByRole("alert")).toContainText("registry is unavailable");
  await expect(page.getByText("No image repositories found.")).toHaveCount(0);
});
