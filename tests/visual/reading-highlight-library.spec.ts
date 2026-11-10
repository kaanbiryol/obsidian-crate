import { test, expect, chromium, webkit } from '@playwright/test';

for (const engine of [chromium, webkit]) for (const host of ['plugin', 'pwa']) {
	test(`${engine.name()} ${host} highlight groups and search`, async ({ baseURL }) => {
		const browser = await engine.launch();
		try {
			const page = await browser.newPage({ baseURL, viewport: { width: 320, height: 900 }, reducedMotion: 'reduce' });
			await page.route('**/favicon.ico', route => route.abort());
			await page.goto(`/?host=${host}&scene=reading&theme=dark&highlight-library=1`);
			if (host === 'plugin') {
				await page.setViewportSize({ width: 1280, height: 900 });
				// Test-only sidebar geometry must be installed inside the fixture's shadow root.
				await page.locator('.crate-reading-workspace').evaluate(element => { const sheet = new CSSStyleSheet(); sheet.replaceSync('.crate-reminders-ui .crate-reading-workspace { width: 340px; height: 700px; margin-left: auto; }'); const root = element.getRootNode() as ShadowRoot; root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; });
			}
			await page.getByRole('button', { name: 'Highlights', exact: true }).click();
			const groups = page.locator('.crate-highlight-group');
			await expect(groups).toHaveCount(3);
			await expect(groups.nth(1).locator('.crate-highlight-group__body')).toBeHidden();
			const header = groups.first().locator('.crate-highlight-group__header');
			await header.click();
			await expect(groups.first().locator('.crate-highlight-group__body')).toBeHidden();
			await header.press('Enter');
			await expect(groups.first().locator('.crate-highlight-group__body')).toBeVisible();
			await expect(page.getByRole('button', { name: /Filter by article/ })).toHaveCount(0);
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('Revisit');
			await expect(groups).toHaveCount(1);
			await expect(groups.first()).toContainText('The pleasure of reading slowly');
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('');
			await expect(groups).toHaveCount(3);
			expect(await groups.first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
			await page.screenshot({ path: `test-results/highlight-library-${engine.name()}-${host}.png` });
			await groups.first().getByRole('button', { name: 'View in article' }).click();
			await expect(page.locator('.crate-reading-reader')).toBeVisible();
		} finally { await browser.close(); }
	});
}
