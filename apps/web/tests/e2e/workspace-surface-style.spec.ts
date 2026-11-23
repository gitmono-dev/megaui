import { expect, test, type Locator } from '@playwright/test';
import { mintSessionCookies } from './helpers/session';
import { stubSurfaceApis, SURFACE_ROUTES } from './helpers/surface-fixture';

async function titleStyle(locator: Locator) {
  return locator.evaluate(element => {
    const s = getComputedStyle(element);
    return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, color: s.color };
  });
}

for (const mode of ['light', 'dark'] as const) {
  test(`all workspace surfaces follow the document baseline (${mode})`, async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    await context.addCookies(mintSessionCookies().cookies);
    await page.addInitScript(mode => localStorage.setItem('mega-settings', JSON.stringify({ mode, density: 'comfortable', accent: 'default' })), mode);
    await stubSurfaceApis(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/en/workspace/docs/surface-doc');
    await expect(page.locator('[data-mega-docs="detail-title"]')).toBeVisible();
    const baseline = await titleStyle(page.locator('[data-mega-docs="detail-title"]'));
    const canvas = mode === 'light' ? 'rgb(249, 250, 251)' : 'rgb(17, 22, 28)';
    for (const [path, selector] of SURFACE_ROUTES) {
      await test.step(path || 'home', async () => {
        await page.goto(`/en/workspace${path}`);
        const surface = page.locator(selector);
        await expect(surface).toBeVisible();
        await expect(surface).toHaveCSS('background-color', canvas);
        const heading = surface.locator('h1:not([data-mega-content] h1, [data-mega-code="readme"] h1)').first();
        if (await heading.count()) await expect.poll(() => titleStyle(heading)).toEqual(baseline);
      });
    }
    expect(errors).toEqual([]);
    await page.goto('/en/workspace/settings?section=appearance');
    const selected = page.locator(`[data-mega-settings="mode-${mode}"]`);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await expect(selected).toHaveCSS('border-radius', '7px');
    await expect(page.locator('[data-mega-settings="card"]')).toHaveCSS('border-radius', '10px');
    await page.screenshot({ path: testInfo.outputPath(`${mode}-settings.png`) });
  });
}

for (const width of [320, 768, 1024, 1440]) {
  test(`page controls fit the available width (${width}px)`, async ({ page, context }, testInfo) => {
    test.setTimeout(90_000);
    await context.addCookies(mintSessionCookies().cookies);
    await page.setViewportSize({ width, height: 900 });
    await stubSurfaceApis(page);
    for (const path of ['/issues', '/cls', '/tags', '/settings?section=appearance', '/channels/new']) {
      await page.goto(`/en/workspace${path}`);
      const surface = page.locator('[data-mega-shell="workspace-content"]');
      await expect(surface.locator('h1').first()).toBeVisible();
      await expect.poll(() => surface.evaluate(el => el.scrollWidth - el.clientWidth), { message: `Overflow on ${path} at ${width}px` }).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`) });
  });
}

test('public and auth routes share document surfaces and controls', async ({ page }) => {
  for (const locale of ['en', 'zh-CN']) {
    for (const route of ['', '/signin', '/signup', '/forgot-password', '/reset-password']) {
      await page.goto(`/${locale}${route}`);
      const surface = page.locator('[data-mega-surface]');
      await expect(surface).toBeVisible();
      await expect(surface).toHaveCSS('background-color', 'rgb(249, 250, 251)');
      const card = surface.locator('[data-slot="card"]');
      if (await card.count()) await expect(card).toHaveCSS('border-radius', '10px');
      const button = surface.locator('[data-slot="button"][data-variant="default"]').first();
      if (await button.count()) {
        await expect(button).toHaveCSS('background-color', 'rgb(37, 99, 235)');
        await expect(button).toHaveCSS('border-radius', '7px');
      }
    }
  }
});

test('keyboard focus, selection and density remain visible', async ({ page, context }) => {
  await context.addCookies(mintSessionCookies().cookies);
  await stubSurfaceApis(page);
  await page.goto('/en/workspace/settings?section=appearance');
  await page.locator('[data-mega-settings="density-compact"]').click();
  await expect(page.locator('[data-mega-settings="density-compact"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/en/workspace/issues');
  const filter = page.locator('[data-mega-issues="filter"]');
  await filter.focus();
  await page.keyboard.press('Tab');
  const open = page.locator('[data-mega-issues="tab-active"]');
  await expect(open).toBeFocused();
  await expect(open).toHaveCSS('outline-style', 'solid');
  await expect(open).toHaveCSS('font-size', '11.5px');
  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(page.locator('[data-mega-issues="tab-active"]')).toHaveText('Closed');
});
