import { test, expect } from '@playwright/test';

for (const host of ['plugin', 'pwa']) {
	test(`${host} shows a placeholder title for every link whose article is being fetched`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/?host=${host}&scene=reading&theme=light&fetching=1`);
		const rows = page.locator('.crate-reading__item');
		await expect(rows).toHaveCount(2);
		await expect(rows.locator('.crate-reading__title-placeholder')).toHaveCount(2);
		await expect(rows.locator('.crate-reading__meta')).toHaveText(['journal.example.org', 'journal.example.org']);
		await expect(page.getByText('A field guide to finding your next favorite place')).toHaveCount(0);
	});
}
