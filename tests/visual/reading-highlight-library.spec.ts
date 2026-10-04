import { test, expect, chromium, webkit } from '@playwright/test';

for (const engine of [chromium, webkit]) for (const host of ['plugin', 'pwa']) {
	test(`${engine.name()} ${host} highlight groups and article picker`, async ({ baseURL }) => {
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
			const filter = page.getByRole('button', { name: 'Filter by article: All articles', exact: true });
			expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await filter.click();
			const dialog = page.getByRole('dialog', { name: 'Filter by article', exact: true });
			await expect(dialog).toBeVisible();
			if (host === 'plugin') {
				const pane = (await page.locator('.crate-reading-workspace').boundingBox())!;
				await expect.poll(async () => Math.abs((await dialog.boundingBox())!.y - pane.y - 20)).toBeLessThanOrEqual(1);
				const sheet = (await dialog.boundingBox())!;
				expect(pane.width).toBe(340);
				expect(pane.x).toBeGreaterThan(500);
				expect(sheet.x).toBeGreaterThanOrEqual(pane.x - 1);
				expect(sheet.x + sheet.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
				expect(Math.abs(sheet.y - pane.y - 20)).toBeLessThanOrEqual(1);
				expect(Math.abs(sheet.height - pane.height + 20)).toBeLessThanOrEqual(1);
				await expect(dialog.locator('.base-modal-drag-region')).toHaveCount(1);
				await expect(dialog.getByRole('button', { name: 'Close filter by article' })).toBeVisible();
				expect(sheet.y + sheet.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
				expect(await page.evaluate(({ x, y }) => { let hit = document.elementFromPoint(x, y); while (hit?.shadowRoot) { const child = hit.shadowRoot.elementFromPoint(x, y); if (!child || child === hit) break; hit = child; } return Boolean(hit?.closest('.crate-reading-pane-overlay')); }, { x: pane.x + pane.width / 2, y: pane.y + pane.height - 8 })).toBe(true);
				expect(await page.evaluate(() => Boolean(document.elementFromPoint(20, 100)?.closest('.crate-reading-pane-overlay')))).toBe(false);
				await page.screenshot({ path: `test-results/highlight-sidebar-picker-${engine.name()}.png` });
			}
			await dialog.getByRole('searchbox', { name: 'Search articles' }).fill('field guide');
			await expect(dialog.locator('.crate-highlight-picker__option')).toHaveCount(2);
			await dialog.getByRole('button', { name: /A field guide/ }).click();
			await expect(dialog).toHaveCount(0);
			await expect(groups).toHaveCount(1);
			await expect(groups.first()).toContainText('A field guide');
			await page.getByRole('button', { name: 'Clear article filter' }).click();
			await expect(groups).toHaveCount(3);
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('Revisit');
			await expect(groups).toHaveCount(1);
			await expect(groups.first()).toContainText('The pleasure of reading slowly');
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('');
			await expect(groups).toHaveCount(3);
			expect(await groups.first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
			await page.screenshot({ path: `test-results/highlight-library-${engine.name()}-${host}.png` });
			if (host === 'plugin') {
				await page.emulateMedia({ reducedMotion: 'no-preference' });
				await filter.click();
				await expect(dialog).toBeVisible();
				const opening = await dialog.evaluate(async element => {
					const values: number[] = [];
					for (let i = 0; i < 35; i++) { values.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).m42); await new Promise(requestAnimationFrame); }
					return values;
				});
				expect(Math.max(...opening)).toBeGreaterThan(1);
				expect(Math.abs(opening.at(-1)!)).toBeLessThan(1);
				const closing = await dialog.evaluate(async element => {
					(element.querySelector('.reminder-modal-header-close') as HTMLButtonElement).click();
					const values: number[] = [];
					for (let i = 0; i < 35 && element.isConnected; i++) { values.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).m42); await new Promise(requestAnimationFrame); }
					return values;
				});
				expect(Math.max(...closing)).toBeGreaterThan(1);
				await expect(dialog).toHaveCount(0);
			}
			await groups.first().getByRole('button', { name: 'View in article' }).click();
			await expect(page.locator('.crate-reading-reader')).toBeVisible();
		} finally { await browser.close(); }
	});
}
