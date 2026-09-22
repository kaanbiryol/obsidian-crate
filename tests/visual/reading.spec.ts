import { test, expect } from '@playwright/test';

for (const host of ['plugin', 'pwa']) for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
	test(`reading ${host} ${theme} ${width}`, async ({ page }) => {
		await page.clock.setFixedTime(new Date('2026-09-21T12:00:00Z'));
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`/?host=${host}&scene=reading&theme=${theme}`);
		const surface = page.getByTestId('visual-surface');
		await expect(page.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
		await expect(surface).toHaveScreenshot(`reading-${host}-${theme}-${width}.png`, { animations: 'disabled' });
		expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		const article = page.locator('article.crate-reading-reader');
		await expect(article.getByRole('heading', { name: 'The pleasure of reading slowly' })).toBeVisible();
		await expect(surface).toHaveScreenshot(`reading-reader-${host}-${theme}-${width}.png`, { animations: 'disabled' });
		await article.getByRole('button', { name: 'Favorite article', exact: true }).click();
		await article.getByRole('button', { name: 'Archive article', exact: true }).click();
		await article.getByRole('button', { name: 'Edit article tags' }).click();
		await page.getByRole('textbox', { name: 'Tags, separated by commas' }).fill('essays, saved');
		await page.getByRole('button', { name: 'Save tags', exact: true }).click();
		await expect(article.getByText('#saved', { exact: true })).toBeVisible();
		await article.getByRole('button', { name: 'Back to reading' }).click();
		await page.getByRole('button', { name: 'Archive', exact: true }).click();
		await expect(page.getByText('1 saved link', { exact: true })).toBeVisible();
		await page.getByRole('searchbox', { name: 'Search reading' }).fill('essays');
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		await article.getByRole('button', { name: 'Back to reading' }).click();
		await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveAttribute(width < 1100 ? 'aria-current' : 'aria-pressed', width < 1100 ? 'page' : 'true');
		await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('essays');
	});
}

for (const host of ['plugin', 'pwa']) test(`reader appearance, capture, keyboard and safe content in ${host}`, async ({ page }) => {
	const remote: string[] = [];
	page.on('request', request => { if (new URL(request.url()).hostname === 'tracking.invalid') remote.push(request.url()); });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/?host=${host}&scene=reading&theme=light`);
	await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
	const body = page.locator('.crate-reading-reader__body');
	await expect(body.locator('img,script,iframe,svg,form,input,video,audio,style')).toHaveCount(0);
	await expect(body.locator('[onerror],[onload],[autofocus]')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'relative link' })).toHaveAttribute('href', 'https://example.com/more');
	await expect(body.locator('a[href^="javascript:"],a[href*="password"]')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__readingAttack)).toBeUndefined();
	expect(remote).toEqual([]);
	await page.getByRole('button', { name: 'Reading appearance' }).click();
	const sheet = page.getByRole('dialog', { name: 'Reading appearance' });
	await expect.poll(async () => { const bounds = await sheet.boundingBox(); return bounds && Math.round(bounds.y + bounds.height); }).toBe(844);
	await expect(page.getByTestId('visual-surface')).toHaveScreenshot(`reading-appearance-${host}.png`, { animations: 'disabled' });
	await page.getByRole('button', { name: 'Literary Serif' }).click();
	await page.getByRole('button', { name: 'Increase text size' }).click();
	await expect(page.getByRole('status', { name: 'Text size' })).toHaveText('20');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(body).toHaveCSS('font-size', '20px');
	await expect(body).toHaveCSS('font-family', /Georgia/);
	await page.getByRole('button', { name: 'Back to reading' }).click();
	await expect(page.getByRole('button', { name: /The pleasure of reading slowly/ })).toBeFocused();
	await page.getByRole('button', { name: 'Save a link', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Save a link' })).toBeVisible();
	await page.getByLabel('Link', { exact: true }).fill('https://example.com/later');
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('button', { name: 'Save a link', exact: true }).click();
	await expect(page.getByLabel('Link', { exact: true })).toHaveValue('https://example.com/later');
	await page.getByLabel('Link', { exact: true }).focus();
	await page.evaluate(() => { Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 484 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
	await expect.poll(async () => page.getByRole('dialog', { name: 'Save a link' }).evaluate(element => {
		const bounds = element.getBoundingClientRect();
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return { bottom: Math.round(bounds.bottom), inset: element.closest<HTMLElement>('.base-modal-container')?.style.bottom, active: active?.tagName };
	})).toEqual({ bottom: 484, inset: '360px', active: 'INPUT' });
});

test('a narrow Obsidian pane uses phone navigation and preserves a long list position', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/?host=plugin&scene=reading&theme=dark&many=1');
	await page.locator('.crate-reading-workspace').evaluate(element => { element.classList.add('reading-narrow-test'); });
	await expect(page.locator('.crate-reading__open')).toHaveCount(100);
	const list = page.locator('.crate-reading__list-scroll');
	await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await page.getByRole('button', { name: 'Show more' }).click();
	await expect(page.locator('.crate-reading__open')).toHaveCount(200);
	const target = page.locator('.crate-reading__open').nth(98);
	await target.scrollIntoViewIfNeeded();
	const position = await list.evaluate(element => element.scrollTop);
	await target.click();
	await expect(page.locator('.crate-reading__library')).toBeHidden();
	await expect(page.locator('.crate-reading-reader')).toBeVisible();
	await page.getByRole('button', { name: 'Back to reading' }).click();
	await expect(target).toBeFocused();
	expect(await list.evaluate(element => element.scrollTop)).toBe(position);
});
