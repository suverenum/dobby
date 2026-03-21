import { expect, test } from "@playwright/test";

test("app loads and renders landing page", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("h1")).toHaveText("Template App");
	await expect(page.locator("button")).toHaveText("Get Started");
});

test("no console errors on page load", async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(msg.text());
		}
	});
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	expect(errors).toEqual([]);
});
