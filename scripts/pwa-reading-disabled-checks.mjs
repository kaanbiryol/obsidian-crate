import { expect } from '@playwright/test';
import { switchFeature } from './pwa-feature-navigation.mjs';

export async function checkDisabledReading(browser, origin, name) {
	// A missing Reading folder is setup state, not an unsynced error.
	const disabledContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
	const disabledPage = await disabledContext.newPage();
	let releaseReadingCheck;
	let holdReadingCheck = false;
	let readingEnabled = false;
	await disabledPage.route('**/reading/session', async route => {
		if (holdReadingCheck) await new Promise(resolve => { releaseReadingCheck = resolve; });
		await route.fulfill(readingEnabled ? { json: { id: 'enabled-reading', folderPath: 'Reading', generation: 'enabled-generation', expiresAt: Date.now() + 86400000 } } : { status: 403, json: { error: 'Choose a Reading folder in Obsidian’s Crate settings first.' } });
	});
	await disabledPage.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
	await disabledPage.goto(origin + '/notifications?tab=inbox');
	await disabledPage.getByRole('button', { name: 'Open settings', exact: true }).click();
	const disabledSheet = disabledPage.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(disabledSheet.getByRole('button', { name: 'Update app', exact: true })).toHaveCount(0);
	await expect(disabledSheet.locator('.settings-attention')).toHaveCount(0);
	await expect(disabledSheet.getByRole('button', { name: 'Set up iPhone shortcut', exact: true })).toBeDisabled();
	await disabledSheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await switchFeature(disabledPage, 'Reading');
	await expect(disabledPage.getByRole('heading', { name: 'Connect your Reading folder', exact: true })).toBeVisible();
	await expect(disabledPage.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
	await expect(disabledPage.getByRole('alert')).toHaveCount(0);
	await expect(disabledPage.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
	const readingDock = disabledPage.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
	await expect(readingDock).toBeVisible();
	await disabledPage.getByRole('button', { name: 'Save a link', exact: true }).filter({ visible: true }).click();
	await expect(disabledPage.getByRole('dialog', { name: 'Save a link' })).toHaveCount(0);
	await switchFeature(disabledPage, 'Reminders');
	await expect(disabledPage.locator('.crate-feature-panel[data-crate-section="reminders"]')).toHaveAttribute('data-active', 'true');
	await switchFeature(disabledPage, 'Reading');
	await expect(readingDock).toBeVisible();
	for (const theme of ['light', 'dark']) {
		await disabledPage.emulateMedia({ colorScheme: theme });
		for (const [width, height] of [[390, 844], [320, 568], [844, 320], [1280, 900]]) {
			await disabledPage.setViewportSize({ width, height });
			await disabledPage.getByRole('button', { name: 'Check again', exact: true }).scrollIntoViewIfNeeded();
			await expect(disabledPage.getByRole('button', { name: 'Check again', exact: true })).toBeInViewport();
			await disabledPage.screenshot({ path: `test-results/settings/${name}-reading-disabled-${theme}-${width}.png` });
		}
	}
	holdReadingCheck = true;
	await disabledPage.getByRole('button', { name: 'Check again', exact: true }).click();
	await expect(disabledPage.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
	await expect(disabledPage.getByRole('heading', { name: 'Connect your Reading folder', exact: true })).toBeVisible();
	await expect(disabledPage.getByRole('button', { name: 'Open settings', exact: true })).toBeEnabled();
	await expect.poll(() => Boolean(releaseReadingCheck)).toBe(true);
	releaseReadingCheck();
	await expect(disabledPage.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
	holdReadingCheck = false;
	readingEnabled = true;
	await disabledPage.getByRole('button', { name: 'Check again', exact: true }).click();
	await expect(disabledPage.getByRole('heading', { name: 'Save something worth your time', exact: true })).toBeVisible();
	await disabledContext.close();
}
