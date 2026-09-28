import { test, expect, chromium, webkit } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) test.describe(browserName, () => {
for (const host of ['plugin', 'pwa']) for (const width of [390, 1280]) {
	test(`${host} article tags at ${width}px`, async ({ baseURL }) => {
		const browser = await ({ chromium, webkit })[browserName].launch();
		try {
		const page = await browser.newPage({ baseURL, reducedMotion: 'reduce' });
		await page.route(/^https:\/\/[^/]+\/favicon\.ico(?:\?.*)?$/, route => route.abort());
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`/?host=${host}&scene=reading&theme=light`);
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		const article = page.locator('.crate-reading-reader');
		const edit = article.getByRole('button', { name: 'Edit article tags' });

		await edit.click();
		const input = page.getByRole('textbox', { name: 'Tags' });
		const dialog = page.getByRole('dialog', { name: 'Article tags' });
		await expect(dialog.locator('.crate-dialog-actions')).toHaveCount(0);
		await expect(dialog.locator('.reminder-modal-header').getByRole('button', { name: 'Save tags' })).toHaveText('Save');
		await input.fill('discarded');
		await dialog.getByRole('button', { name: 'Close article tags' }).click();
		await edit.click();
		await expect(input).toHaveValue('');
		const chips = page.getByRole('button', { name: /^Remove tag / });
		await expect(chips).toHaveText(['#essays', '#reading']);
		await expect(input).toHaveValue('');
		while (await chips.count()) await chips.first().click();
		await input.pressSequentially('#design ');
		await expect(chips).toHaveText(['#design']);
		await input.pressSequentially('design later ');
		await expect(chips).toHaveText(['#design', '#later']);
		await input.press('Backspace');
		await expect(input).toHaveValue('later');
		await input.press('Enter');
		await expect(input).toHaveValue('');
		await expect(chips).toHaveText(['#design', '#later']);
		await input.fill('topics/books');
		await page.screenshot({ animations: 'disabled', path: `/tmp/crate-tags-input-${browserName}-${host}-${width}.png` });
		await page.getByRole('button', { name: 'Save tags', exact: true }).click();
		await expect(article.locator('.crate-reading-reader__tags span')).toHaveText(['#design', '#later', '#topics/books']);
		expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await page.screenshot({ animations: 'disabled', path: `/tmp/crate-tags-reader-${host}-${width}.png` });
		await article.getByRole('button', { name: 'Back to reading' }).click();
		await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
		const filter = page.getByRole('combobox', { name: 'Filter by tag' });
		if (await filter.isVisible()) {
			expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await filter.selectOption('later');
		}
		else await page.locator('.crate-reading__tag-nav').getByRole('button', { name: 'later', exact: true }).click();
		await expect(page.locator('.crate-reading__open')).toHaveCount(1);
		await page.screenshot({ animations: 'disabled', path: `/tmp/crate-tags-filter-${host}-${width}.png` });
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		await edit.click();
		await expect(chips).toHaveText(['#design', '#later', '#topics/books']);
		while (await chips.count()) await chips.first().click();
		await page.getByRole('button', { name: 'Save tags', exact: true }).click();
		await expect(article.locator('.crate-reading-reader__tags')).toHaveCount(0);
		await article.getByRole('button', { name: 'Back to reading' }).click();
		await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
		// Removing the final use of a selected tag must not leave an empty, stuck filter.
		await expect(page.locator('.crate-reading__open')).toHaveCount(6);
		await expect(page.locator('.crate-reading__tag-filter')).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Filter by tag' })).toHaveValue('');
		} finally { await browser.close(); }
	});
}

});
