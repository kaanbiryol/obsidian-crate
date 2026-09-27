import { test, expect, chromium, webkit } from '@playwright/test';

for (const browserName of ['chromium', 'webkit'] as const) {
	for (const host of ['pwa', 'plugin']) {
		test(`${browserName} ${host} appearance stays steady across text sizes`, async ({ baseURL }) => {
			const browser = await ({ chromium, webkit })[browserName].launch();
			try {
				const page = await browser.newPage({ baseURL, viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
				await page.route(/^https:\/\//, route => route.abort());
				await page.goto(`/?host=${host}&scene=reading&theme=dark&reader`);
				await page.getByRole('button', { name: 'Reading appearance', exact: true }).click();
				const dialog = page.getByRole('dialog', { name: 'Reading appearance' });
				await expect(dialog).toBeVisible();
				const preview = dialog.locator('.crate-reading-reader__sample-frame');
				const sample = dialog.locator('.crate-reading-reader__sample');
				const decrease = dialog.getByRole('button', { name: 'Decrease text size' });
				const increase = dialog.getByRole('button', { name: 'Increase text size' });
				await expect(increase).toHaveClass(/crate-icon-button/);
				await expect(increase.locator('svg')).toHaveCount(1);
				for (let i = 0; i < 3; i++) await decrease.click();
				await expect(decrease).toBeDisabled();
				const initial = await preview.boundingBox();
				const initialDialog = await dialog.boundingBox();
				for (const name of ['Modern', 'Literary']) {
					await dialog.getByRole('button', { name: new RegExp(name) }).click();
					for (let size = 16; size <= 26; size++) {
						await expect(sample).toHaveCSS('font-size', `${size}px`);
						expect(await preview.boundingBox()).toEqual(initial);
						expect(await dialog.boundingBox()).toEqual(initialDialog);
						if (size < 26) await increase.click();
					}
					await expect(increase).toBeDisabled();
					for (let i = 0; i < 10; i++) await decrease.click();
				}
			} finally { await browser.close(); }
		});
	}
}
