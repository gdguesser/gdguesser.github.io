import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

const publicPages = ["/", "/writing/", "/writing/reliable-webhook-delivery/"];

for (const path of publicPages) {
  test(`${path} has no automated accessibility violations`, async ({
    page,
  }) => {
    const response = await page.goto(path);

    expect(response?.ok()).toBe(true);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

test("all internal page links and fragment targets resolve", async ({
  page,
  request,
  baseURL,
}) => {
  const links = new Set<string>();

  for (const path of publicPages) {
    await page.goto(path);
    const pageLinks = await page
      .locator("a[href]")
      .evaluateAll((anchors) =>
        anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
      );
    pageLinks.forEach((href) => links.add(href));
  }

  for (const href of links) {
    const url = new URL(href);
    if (url.origin !== new URL(baseURL ?? "").origin) continue;

    const response = await request.get(`${url.pathname}${url.search}`);
    expect.soft(response.status(), `${href} should resolve`).toBeLessThan(400);

    if (url.hash) {
      await page.goto(href);
      const targetExists = await page.evaluate(
        (id) => document.getElementById(id) !== null,
        decodeURIComponent(url.hash.slice(1)),
      );
      expect.soft(targetExists, `${href} should target an element`).toBe(true);
    }
  }
});

test("metadata and generated social image are complete", async ({
  page,
  request,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Gabriel Dietrich Guesser");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /backend engineer/i,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://guesser.dev/",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://guesser.dev/og/guesser-dev.png",
  );

  const html = await page.content();
  expect(html).not.toMatch(/placeholder|your-domain|example\.com/i);
  expect(html).toContain(`© ${new Date().getFullYear()}`);

  const imageResponse = await request.get("/og/guesser-dev.png");
  expect(imageResponse.ok()).toBe(true);
  expect(imageResponse.headers()["content-type"]).toContain("image/png");

  const metadata = await sharp("dist/og/guesser-dev.png").metadata();
  expect(metadata.width).toBe(1200);
  expect(metadata.height).toBe(630);
  expect(metadata.format).toBe("png");
});

test("theme preference works from the keyboard and persists", async ({
  page,
}) => {
  await page.goto("/");

  const toggle = page.locator(".theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Use dark theme");
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Use light theme");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("custom 404 is useful and excluded from indexing", async ({ page }) => {
  const response = await page.goto("/missing-page-for-smoke-test/");

  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "This path ends here." }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  await expect(page.getByRole("link", { name: "Go home" })).toBeVisible();
});
