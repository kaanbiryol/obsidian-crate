import { test, expect } from '@playwright/test';

for (const host of ['plugin', 'pwa']) for (const width of [390, 1280]) {
	test(`${host} article tags at ${width}px`, async ({ page }) => {
		await page.route(/^https:\/\/[^/]+\/favicon\.ico(?:\?.*)?$/, route => route.abort());
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`/?host=${host}&scene=reading&theme=light`);
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		const article = page.locator('.crate-reading-reader');
		const edit = article.getByRole('button', { name: 'Edit article tags' });
		await expect(edit).toHaveText('Tags');
		await edit.click();
		const input = page.getByRole('textbox', { name: 'Tags, separated by commas' });
		await expect(input).toHaveValue('essays, reading');
		await input.fill('#design, design, later, topics/books');
		await page.getByRole('button', { name: 'Save tags', exact: true }).click();
		await expect(article.locator('.crate-reading-reader__tags span')).toHaveText(['#design', '#later', '#topics/books']);
		expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await page.screenshot({ animations: 'disabled', path: `/tmp/crate-tags-reader-${host}-${width}.png` });
		await article.getByRole('button', { name: 'Back to reading' }).click();
		if (width < 720) await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
		if (width < 1100) {
			const filter = page.getByRole('combobox', { name: 'Filter by tag' });
			expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await filter.selectOption('later');
		}
		else await page.locator('.crate-reading__tag-nav').getByRole('button', { name: 'later', exact: true }).click();
		await expect(page.locator('.crate-reading__open')).toHaveCount(1);
		await page.screenshot({ animations: 'disabled', path: `/tmp/crate-tags-filter-${host}-${width}.png` });
		await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
		await edit.click();
		await expect(input).toHaveValue('design, later, topics/books');
		await input.fill('');
		await page.getByRole('button', { name: 'Save tags', exact: true }).click();
		await expect(article.locator('.crate-reading-reader__tags')).toHaveCount(0);
		await article.getByRole('button', { name: 'Back to reading' }).click();
		if (width < 720) await expect(page.locator('.crate-reading__reader-pane')).toBeHidden();
		// Removing the final use of a selected tag must not leave an empty, stuck filter.
		await expect(page.locator('.crate-reading__open')).toHaveCount(6);
		await expect(page.locator('.crate-reading__tag-filter')).toHaveCount(0);
		if (width < 1100) await expect(page.getByRole('combobox', { name: 'Filter by tag' })).toHaveValue('');
	});
}
