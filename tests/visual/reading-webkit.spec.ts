import { test, expect } from '@playwright/test';

test.use({ browserName: 'webkit' });
test('reading works on a narrow screen and sanitizes clipped content', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/?host=plugin&scene=reading&theme=dark');
	await page.getByRole('searchbox', { name: 'Search reading' }).fill('pleasure');
	await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
	await expect(page.getByRole('heading', { name: 'The pleasure of reading slowly' })).toBeVisible();
	await expect(page.locator('.crate-reading-reader__body img, .crate-reading-reader__body iframe')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'relative link' })).toHaveAttribute('rel', 'noopener noreferrer');
	await page.getByRole('button', { name: 'Back to reading' }).click();
	await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('pleasure');
	await expect(page.getByText('1 saved link', { exact: true })).toBeVisible();
});
