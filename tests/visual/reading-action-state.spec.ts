import { test, expect, chromium, webkit } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) {
	test.describe(browserName, () => {
			for (const host of ['pwa', 'plugin']) {
				for (const outcome of ['success', 'fail']) {
					test(`${host} ignores ${outcome} from a replaced article while its new save is pending`, async ({ baseURL }) => {
						const browser = await ({ chromium, webkit })[browserName].launch();
						try {
							const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
							await page.route(/^https:\/\//, route => route.abort());
							await page.goto(`/?host=${host}&scene=reading&theme=dark&reader&reader-delayed-update&reader-action-lifetime`);
							await page.getByRole('button', { name: 'Edit article tags' }).click();
							await page.getByRole('button', { name: 'Save tags', exact: true }).click();
							await expect(page.locator('html')).toHaveAttribute('data-reading-update-calls', '1');
							await page.evaluate(() => window.dispatchEvent(new Event('reading-replace-article')));
							await expect(page.getByRole('heading', { name: 'A newly saved article', exact: true })).toBeVisible();
							await expect(page.getByRole('dialog', { name: 'Article tags' })).toHaveCount(0);
							await page.getByRole('button', { name: 'Edit article tags' }).click();
							const save = page.getByRole('button', { name: 'Save tags', exact: true });
							await expect(save).toBeEnabled();
							await save.click();
							await expect(page.locator('html')).toHaveAttribute('data-reading-update-calls', '2');
							await page.evaluate(async outcome => {
								window.dispatchEvent(new CustomEvent('reading-settle-update', { detail: { request: 1, outcome } }));
								await new Promise(requestAnimationFrame);
							}, outcome);
							await expect(save).toBeDisabled();
							await expect(page.getByRole('alert')).toHaveCount(0);
							await expect(page.locator('html')).not.toHaveAttribute('data-reading-save-completions');
							await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update', { detail: { request: 2, outcome: 'success' } })));
							await expect(page.getByRole('dialog', { name: 'Article tags' })).toHaveCount(0);
							await expect(page.locator('html')).toHaveAttribute('data-reading-save-completions', '1');
						} finally { await browser.close(); }
					});
				}

				test(`${host} does not announce a tag save after its reader unmounts`, async ({ baseURL }) => {
					const browser = await ({ chromium, webkit })[browserName].launch();
					try {
						const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
						await page.route(/^https:\/\//, route => route.abort());
						await page.goto(`/?host=${host}&scene=reading&theme=dark&reader&reader-delayed-update&reader-action-lifetime`);
						await page.getByRole('button', { name: 'Edit article tags' }).click();
						await page.getByRole('button', { name: 'Save tags', exact: true }).click();
						await expect(page.locator('html')).toHaveAttribute('data-reading-update-calls', '1');
						await page.evaluate(() => window.dispatchEvent(new Event('reading-unmount')));
						await expect(page.locator('article.crate-reading-reader')).toHaveCount(0);
						await page.evaluate(async () => {
							window.dispatchEvent(new CustomEvent('reading-settle-update'));
							await new Promise(requestAnimationFrame);
						});
						await expect(page.locator('html')).not.toHaveAttribute('data-reading-save-completions');
					} finally { await browser.close(); }
				});

			test(`${host} keeps less frequent article actions in the More menu`, async ({ baseURL }) => {
				const browser = await ({ chromium, webkit })[browserName].launch();
				try {
					const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
					await page.route(/^https:\/\//, route => route.abort());
					await page.goto(`/?host=${host}&scene=reading&theme=dark&reader`);
					const article = page.locator('article.crate-reading-reader');
					const more = article.getByRole('button', { name: 'More article actions', exact: true });
					// The top bar keeps favorite; archive, share and appearance live in More.
					await expect(article.locator('.crate-reading-reader__quick-actions > button')).toHaveCount(1);
					await more.click();
					const menu = page.getByRole('menu', { name: 'More article actions' });
					const items = ['Archive', 'Share', 'Reading appearance', 'Open note', ...host === 'pwa' ? ['Remove offline copy', 'Delete article'] : []];
					await expect(menu.getByRole('menuitem')).toHaveText(items);
					await expect(menu.getByRole('menuitem').first()).toBeFocused();
					await page.keyboard.press('ArrowUp');
					await expect(menu.getByRole('menuitem').last()).toBeFocused();
					await page.keyboard.press('Escape');
					await expect(menu).toHaveCount(0);
					await expect(more).toBeFocused();
					await more.click();
					await page.mouse.click(195, 700);
					await expect(menu).toHaveCount(0);
					if (host !== 'pwa') return;
					await more.click();
					await menu.getByRole('menuitem', { name: 'Delete article' }).click();
					await expect(page.getByRole('alertdialog', { name: 'Delete article' })).toBeVisible();
				} finally { await browser.close(); }
			});

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
					const more = article.getByRole('button', { name: 'More article actions', exact: true });
					const menuItem = async (name: string) => { await more.click(); return page.getByRole('menu', { name: 'More article actions' }).getByRole('menuitem', { name, exact: true }); };
					// More changes as it opens and closes, so the stable set is the other top-bar controls.
					const controls = article.locator('.crate-reading-reader__nav button:not([aria-haspopup], [role="menuitem"])');
					const appearance = () => controls.evaluateAll(buttons => buttons.map(button => {
						const style = getComputedStyle(button), rect = button.getBoundingClientRect();
						return { opacity: style.opacity, color: style.color, background: style.background, shadow: style.boxShadow,
							disabled: (button as HTMLButtonElement).disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					}));
					await expect(more).toBeVisible();
					const before = await appearance();
					let calls = 0;
					for (const outcome of ['cancel', 'success', 'fail']) {
						await (await menuItem('Share')).click();
						await page.mouse.move(0, 0);
						expect(await appearance()).toEqual(before);
						// While the OS share sheet is open, Share stays unavailable so it cannot start twice.
						await expect(await menuItem('Share')).toBeDisabled();
						await page.keyboard.press('Escape');
						await expect(page.locator('html')).toHaveAttribute('data-share-calls', String(++calls));
						await expect(article.getByRole('button', { name: 'Favorite article', exact: true })).toBeEnabled();
						await (await menuItem('Reading appearance')).click();
						await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toBeVisible();
						await page.keyboard.press('Escape');
						await page.evaluate(outcome => window.dispatchEvent(new CustomEvent('settle-share', { detail: outcome })), outcome);
						await expect(await menuItem('Share')).toBeEnabled();
						await page.keyboard.press('Escape');
						await page.mouse.move(0, 0);
						expect(await appearance()).toEqual(before);
						if (outcome === 'fail') await expect(article.getByRole('alert')).toHaveText('Could not share article.');
						else await expect(article.getByRole('alert')).toHaveCount(0);
					}
				} finally { await browser.close(); }
			});

			test(`${host} favorites articles only inside the reader`, async ({ baseURL }) => {
				const browser = await ({ chromium, webkit })[browserName].launch();
				try {
					const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
					await page.route(/^https:\/\//, route => route.abort());
					await page.goto(`/?host=${host}&scene=reading&theme=dark`);
					const rows = page.locator('.crate-reading__item');
					const first = rows.filter({ hasText: 'The pleasure of reading slowly' });
					await expect(first).toBeVisible();
					await expect(rows.getByRole('button', { name: /^(Favorite|Favorite article|Remove favorite)$/ })).toHaveCount(0);
					await first.getByRole('button').click();
					const article = page.locator('article.crate-reading-reader');
					await article.getByRole('button', { name: 'Favorite article', exact: true }).click();
					await expect(article.getByRole('button', { name: 'Remove favorite', exact: true })).toHaveAttribute('aria-pressed', 'true');
					await article.getByRole('button', { name: 'Back to reading', exact: true }).click();
					await expect(first).toBeVisible();
					await expect(rows.getByRole('button', { name: /^(Favorite|Favorite article|Remove favorite)$/ })).toHaveCount(0);
					await first.getByRole('button').click();
					await article.getByRole('button', { name: 'Remove favorite', exact: true }).click();
					await expect(article.getByRole('button', { name: 'Favorite article', exact: true })).toHaveAttribute('aria-pressed', 'false');
				} finally { await browser.close(); }
			});

			for (const action of ['Archive', 'Favorite article']) {
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
					const more = article.getByRole('button', { name: 'More article actions', exact: true });
					const menuItem = async (name: string) => { await more.click(); return page.getByRole('menu', { name: 'More article actions' }).getByRole('menuitem', { name, exact: true }); };
					const nav = article.locator('.crate-reading-reader__nav');
					const appearance = () => nav.locator('button:not([aria-haspopup], [role="menuitem"])').evaluateAll(buttons => buttons.map(button => {
						const style = getComputedStyle(button);
						return { opacity: style.opacity, background: style.background, shadow: style.boxShadow, disabled: (button as HTMLButtonElement).disabled };
					}));
					// Archive lives in More; favorite stays in the top bar.
					const run = async (name: string) => name === 'Archive' || name === 'Move to inbox'
						? (await menuItem(name)).click() : article.getByRole('button', { name, exact: true }).click();
					await expect(more).toBeVisible();
					const before = await appearance();
					await run(action);
					if (action === 'Favorite article') await expect(article.getByRole('button', { name: action, exact: true })).toHaveAttribute('aria-disabled', 'true');
					await page.mouse.move(0, 0);
					expect(await appearance()).toEqual(before);
					await (await menuItem('Share')).click();
					await expect(page.locator('html')).toHaveAttribute('data-shared', 'true');
					await (await menuItem('Reading appearance')).click();
					await expect(page.getByRole('dialog', { name: 'Reading appearance' })).toBeVisible();
					await page.keyboard.press('Escape');
					await article.getByRole('button', { name: 'Edit article tags' }).click();
					await expect(page.getByRole('button', { name: 'Save tags', exact: true })).toBeDisabled();
					await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update')));
					await expect(page.getByRole('button', { name: 'Save tags', exact: true })).toBeEnabled();
					await page.getByRole('button', { name: 'Close article tags', exact: true }).click();
					const undo = action === 'Archive' ? 'Move to inbox' : 'Remove favorite';
					await run(undo);
					if (action === 'Favorite article') await expect(article.getByRole('button', { name: undo, exact: true })).toHaveAttribute('aria-disabled', 'true');
					await page.evaluate(() => window.dispatchEvent(new CustomEvent('reading-settle-update', { detail: 'fail' })));
					await expect(article.getByRole('alert')).toHaveText('Could not save article.');
					if (action === 'Favorite article') await expect(article.getByRole('button', { name: undo, exact: true })).toHaveAttribute('aria-disabled', 'false');
					await page.mouse.move(0, 0);
					expect(await appearance()).toEqual(before);
					} finally { await browser.close(); }
				});
			}
		}
	});
}
