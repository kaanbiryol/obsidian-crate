import { test, expect, chromium, webkit } from '@playwright/test';

for (const engine of [chromium, webkit]) for (const host of ['plugin', 'pwa']) {
	test(`${engine.name()} ${host} highlight feed and search`, async ({ baseURL }) => {
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
			const rows = page.locator('.crate-reading-highlights__item');
			await expect(rows).toHaveCount(3);
			// Newest first, each naming its article.
			await expect(rows.first().locator('.crate-reading-highlights__source')).toContainText('The pleasure of reading slowly');
			await expect(page.getByRole('button', { name: /Filter by article/ })).toHaveCount(0);
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('Revisit');
			await expect(rows).toHaveCount(1);
			await expect(rows.first()).toContainText('The pleasure of reading slowly');
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('');
			await expect(rows).toHaveCount(3);
			const list = page.locator('.crate-reading-highlights');
			expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
			const source = rows.nth(1).locator('.crate-reading-highlights__source');
			expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `test-results/highlight-library-${engine.name()}-${host}.png` });
			await source.click();
			await expect(page.locator('.crate-reading-reader')).toBeVisible();
			await page.getByRole('button', { name: 'Back to reading' }).click();
			await rows.first().getByRole('button', { name: 'View in article' }).click();
			await expect(page.locator('.crate-reading-reader')).toBeVisible();
		} finally { await browser.close(); }
	});
}
