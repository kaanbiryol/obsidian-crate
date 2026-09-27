import { expect } from '@playwright/test';

export async function checkSettingsMotion(browser, origin) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
	try {
		const page = await context.newPage();
		await page.route('**/reading/session', route => route.fulfill({ json: {
			id: 'settings-motion', folderPath: 'Reading', generation: 'settings-motion', expiresAt: Date.now() + 86400000,
		} }));
		await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
		await page.goto(origin + '/notifications?tab=inbox');
		const gear = page.getByRole('button', { name: 'Open settings', exact: true });
		await gear.waitFor();
		// Lengthen just this entrance so the intermediate state is deterministic
		// even on a loaded CI host. Initialization must follow animation completion.
		const slow = await page.addStyleTag({ content: '.pwa-settings-root .pwa-modal-sheet__container--settings:not([data-starting-style]) { transition-duration: 900ms; }' });
		await gear.click();
		const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect.poll(() => sheet.evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(true);
		await expect(page.locator('[data-crate-section="reading"] .crate-reading-web')).toHaveCount(0);
		await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
		await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
		await expect(page.locator('[data-crate-section="reading"] .crate-reading-web')).toHaveCount(1);
		await slow.evaluate(el => el.remove());
		for (let cycle = 0; cycle < 2; cycle++) {
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).evaluate(el => el.click());
			await expect(sheet).toHaveAttribute('data-ending-style', '');
			await expect(page.locator('[data-crate-section="reminders"]')).toHaveAttribute('inert', '');
			await expect(sheet).toHaveCount(0);
			await expect(gear).toBeFocused();
			await gear.click();
			await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
			await expect(sheet).toHaveCSS('transition-duration', '0.3s');
		}
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await gear.click();
		await expect(sheet).toHaveCSS('transition-duration', '0s');
		await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
	} finally { await context.close(); }
}
