import { expect } from '@playwright/test';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36';

export async function checkInstallSettings(browser, origin, name) {
	for (const [platform, userAgent] of [['ios', iphone], ['android', android]]) {
		const context = await browser.newContext({ userAgent, hasTouch: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
		try {
			const page = await context.newPage();
			await page.route('**/reading/session', route => route.fulfill({ json: {
				id: 'settings-install', folderPath: 'Reading', generation: 'settings-install', expiresAt: Date.now() + 86400000,
			} }));
			await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
			await page.goto(origin + '/notifications?tab=inbox');
			await page.getByRole('button', { name: 'Open settings', exact: true }).click();
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			const install = page.getByRole('dialog', { name: 'Add to home screen', exact: true });
			const open = settings.getByRole('button', { name: 'Add to home screen', exact: true });
			await expect(settings.locator('.pwa-home-screen-instructions')).toHaveCount(0);
			const encryption = settings.getByRole('region', { name: 'Encryption', exact: true });
			await expect(encryption.getByText('Not enabled', { exact: true })).toHaveCount(2);
			await expect(encryption.getByText('Set up encryption in Crate in Obsidian.', { exact: true })).toHaveCount(1);
			const storage = settings.getByRole('region', { name: 'Device storage', exact: true });
			await expect(storage.getByText('Offline data', { exact: true })).toBeVisible();
			await expect(settings.getByRole('region', { name: 'Sync', exact: true }).getByText('Offline data', { exact: true })).toHaveCount(0);
			for (const method of ['button', 'native', 'escape']) {
				await open.click();
				const scroll = await page.locator('.settings-main').evaluate(el => el.scrollTop);
				await expect(install).toBeVisible();
				await expect(install.locator('.settings-main')).toHaveAttribute('inert', '');
				await expect(install.locator('.settings-install-instructions li')).toHaveCount(3);
				await expect(install.getByText(platform === 'ios' ? 'Open as Web App' : 'Install app', { exact: true })).toBeVisible();
				if (method === 'native') await page.goBack();
				else if (method === 'escape') await page.keyboard.press('Escape');
				else await install.getByRole('button', { name: 'Back to settings', exact: true }).click();
				await expect(settings).toBeVisible();
				await expect.poll(() => page.evaluate(() => !!history.state?.cratePushedPage)).toBe(false);
				await expect(open).toBeFocused();
				expect(await page.locator('.settings-main').evaluate(el => el.scrollTop)).toBe(scroll);
			}
			// Forward must reopen installation even after the settings sheet has closed.
			await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
			await expect(settings).toHaveCount(0);
			await page.goForward();
			await expect(install).toBeVisible();
			for (const colorScheme of ['light', 'dark']) {
				await page.emulateMedia({ colorScheme });
				await page.setViewportSize({ width: 320, height: 568 });
				expect(await install.locator('.settings-detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
				await install.locator('.settings-install-instructions li').last().scrollIntoViewIfNeeded();
				await expect(install.locator('.settings-install-instructions li').last()).toBeInViewport();
				await page.screenshot({ path: `test-results/settings/${name}-install-${platform}-${colorScheme}.png` });
			}
			await page.goBack();
			await expect(settings).toBeVisible();
			// A completed browser installation removes the entry immediately.
			await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
			await expect(open).toHaveCount(0);
		} finally { await context.close(); }
	}
	const installed = await browser.newContext({ userAgent: iphone, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
	try {
		await installed.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
		const page = await installed.newPage();
		await page.goto(origin + '/notifications?tab=inbox');
		await page.getByRole('button', { name: 'Open settings', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Add to home screen', exact: true })).toHaveCount(0);
	} finally { await installed.close(); }
}
