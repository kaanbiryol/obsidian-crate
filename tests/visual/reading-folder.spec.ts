import { test, expect } from '@playwright/test';

for (const host of ['plugin', 'pwa']) {
	test.describe(`${host} folder notes`, () => {
		test('reads and updates a note without a source link', async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(`/?host=${host}&scene=reading&theme=light&vault-note=1`);
			await page.getByRole('button', { name: 'Vault note A vault note' }).click();
			const article = page.locator('.crate-reading-reader');
			await expect(article.getByRole('heading', { name: 'A vault note' })).toBeVisible();
			await expect(article.getByRole('link', { name: 'Original' })).toHaveCount(0);
			await expect(article.getByRole('button', { name: 'Share article' })).toHaveCount(0);
			await expect(article.getByRole('link', { name: 'relative link', exact: true })).toHaveCount(0);
			await expect(article.getByRole('link', { name: 'absolute link', exact: true })).toHaveAttribute('href', 'https://example.com/more');
			await article.getByRole('button', { name: 'Favorite article', exact: true }).click();
			await expect(article.getByRole('button', { name: 'Remove favorite', exact: true })).toHaveAttribute('aria-pressed', 'true');
			await article.getByRole('button', { name: 'Archive article', exact: true }).click();
			await expect(article.getByRole('button', { name: 'Move to inbox', exact: true })).toBeVisible();
			await article.getByRole('button', { name: 'Back to reading' }).click();
			await page.getByRole('button', { name: 'Archive', exact: true }).click();
			await expect(page.getByRole('button', { name: 'Vault note A vault note' })).toBeVisible();
		});
	});
}
