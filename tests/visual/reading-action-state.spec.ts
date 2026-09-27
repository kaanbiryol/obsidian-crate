import { test, expect, chromium, webkit } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) {
	test.describe(browserName, () => {
		for (const host of ['pwa', 'plugin']) {
			test(`${host} keeps the reader stable throughout native sharing`, async ({ baseURL }) => {
				const browser = await ({ chromium, webkit })[browserName].launch();
				try {
					const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
					await page.route(/^https:\/\//, route => route.abort());
					await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: () => {
						document.documentElement.dataset.shareCalls = String(Number(document.documentElement.dataset.shareCalls ?? 0) + 1);
						return new Promise<void>((resolve, reject) => window.addEventListener('settle-share', event => {
							const outcome = (event as CustomEvent<string>).detail;
							if (outcome === 'cancel') reject(new DOMException('Share cancelled', 'AbortError'));
							else if (outcome === 'fail') reject(new Error('Could not share article.'));
							else resolve();
						}, { once: true }));
					} }));
					await page.goto(`/?host=${host}&scene=reading&theme=dark&reader`);
					const article = page.locator('article.crate-reading-reader');
					const share = article.getByRole('button', { name: 'Share article', exact: true });
					const controls = article.locator('.crate-reading-reader__nav button, .crate-reading-reader__tools button');
					const appearance = () => controls.evaluateAll(buttons => buttons.map(button => {
						const style = getComputedStyle(button), rect = button.getBoundingClientRect();
						return { opacity: style.opacity, color: style.color, background: style.background, shadow: style.boxShadow,
							disabled: (button as HTMLButtonElement).disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					}));
					await expect(share).toBeVisible();
					const before = await appearance();
					let calls = 0;
					for (const outcome of ['cancel', 'success', 'fail']) {
						await share.click();
						await page.mouse.move(0, 0);
						await expect(share).toHaveAttribute('aria-disabled', 'true');
						expect(await appearance()).toEqual(before);
						// The OS normally covers the reader; simulate repeated activation
						// while its promise is held to verify the app's own duplicate guard.
						await share.evaluate(button => (button as HTMLButtonElement).click());
						await share.press('Enter');
						await expect(page.locator('html')).toHaveAttribute('data-share-calls', String(++calls));
						await expect(article.getByRole('button', { name: 'Favorite article', exact: true })).toBeEnabled();
						await article.getByRole('button', { name: 'Reading appearance' }).click();
						await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toBeVisible();
						await page.keyboard.press('Escape');
						await page.evaluate(outcome => window.dispatchEvent(new CustomEvent('settle-share', { detail: outcome })), outcome);
						await expect(share).toHaveAttribute('aria-disabled', 'false');
						await page.mouse.move(0, 0);
						expect(await appearance()).toEqual(before);
						if (outcome === 'fail') await expect(article.getByRole('alert')).toHaveText('Could not share article.');
						else await expect(article.getByRole('alert')).toHaveCount(0);
					}
				} finally { await browser.close(); }
			});

			test(`${host} keeps other library items usable while a favorite saves`, async ({ baseURL }) => {
				const browser = await ({ chromium, webkit })[browserName].launch();
				try {
					const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
					await page.route(/^https:\/\//, route => route.abort());
					await page.goto(`/?host=${host}&scene=reading&theme=dark&reader-delayed-update`);
					const rows = page.locator('.crate-reading__item');
					const first = rows.filter({ hasText: 'The pleasure of reading slowly' });
					const other = rows.filter({ hasText: 'Good design is as little design as possible' });
					await first.getByRole('button', { name: 'Favorite', exact: true }).click();
					await expect(first.getByRole('button', { name: 'Favorite', exact: true })).toHaveAttribute('aria-disabled', 'true');
					await expect(other.getByRole('button', { name: 'Favorite', exact: true })).toBeEnabled();
					await other.hover();
					await expect(other.getByRole('button', { name: 'Favorite', exact: true })).toHaveCSS('opacity', '1');
					await expect(page.getByRole('button', { name: 'Save a link', exact: true }).filter({ visible: true })).toBeEnabled();
					await other.getByRole('button', { name: 'Favorite', exact: true }).click();
					await expect(other.getByRole('button', { name: 'Favorite', exact: true })).toHaveAttribute('aria-disabled', 'true');
					await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update')));
					await expect(first.getByRole('button', { name: 'Remove favorite', exact: true })).toBeEnabled();
					await expect(other.getByRole('button', { name: 'Remove favorite', exact: true })).toBeEnabled();
				} finally { await browser.close(); }
			});

			for (const action of ['Archive article', 'Favorite article']) {
				test(`${host} keeps toolbar controls stable while ${action} saves`, async ({ baseURL }) => {
					const browser = await ({ chromium, webkit })[browserName].launch();
					try {
					const page = await browser.newPage({ baseURL, reducedMotion: 'reduce' });
					await page.setViewportSize({ width: 390, height: 844 });
					await page.route(/^https:\/\//, route => route.abort());
					await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: async () => {
						document.documentElement.dataset.shared = 'true';
					} }));
					await page.goto(`/?host=${host}&scene=reading&theme=dark&reader&reader-delayed-update`);
					const article = page.locator('article.crate-reading-reader');
					const tools = article.locator('.crate-reading-reader__tools');
					const appearance = () => tools.locator('button').evaluateAll(buttons => buttons.map(button => {
						const style = getComputedStyle(button);
						return { opacity: style.opacity, background: style.background, shadow: style.boxShadow, disabled: (button as HTMLButtonElement).disabled };
					}));
					await expect(article.getByRole('button', { name: action, exact: true })).toBeVisible();
					const before = await appearance();
					await article.getByRole('button', { name: action, exact: true }).click();
					await expect(article.getByRole('button', { name: action, exact: true })).toHaveAttribute('aria-disabled', 'true');
					expect(await appearance()).toEqual(before);
					await article.getByRole('button', { name: 'Share article', exact: true }).click();
					await expect(page.locator('html')).toHaveAttribute('data-shared', 'true');
					await article.getByRole('button', { name: 'Reading appearance' }).click();
					await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toBeVisible();
					await page.keyboard.press('Escape');
					await article.getByRole('button', { name: 'Edit article tags' }).click();
					await expect(page.getByRole('button', { name: 'Save tags', exact: true })).toBeDisabled();
					await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update')));
					await expect(page.getByRole('button', { name: 'Save tags', exact: true })).toBeEnabled();
					await page.getByRole('button', { name: 'Cancel', exact: true }).click();
					const undo = action === 'Archive article' ? 'Move to inbox' : 'Remove favorite';
					await expect(article.getByRole('button', { name: undo, exact: true })).toBeVisible();
					await article.getByRole('button', { name: undo, exact: true }).click();
					await expect(article.getByRole('button', { name: undo, exact: true })).toHaveAttribute('aria-disabled', 'true');
					await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update', { detail: 'fail' })));
					await expect(article.getByRole('alert')).toHaveText('Could not save article.');
					await expect(article.getByRole('button', { name: undo, exact: true })).toHaveAttribute('aria-disabled', 'false');
					expect(await appearance()).toEqual(before);
					} finally { await browser.close(); }
				});
			}
		}
	});
}
