import { checkDisabledReading } from './pwa-reading-disabled-checks.mjs';
import { checkTabSettings } from './pwa-tab-settings-checks.mjs';
import { checkCompoundFocus, checkSettingsFocus } from './pwa-compound-focus-checks.mjs';
import { checkSettingsMotion } from './pwa-settings-motion-checks.mjs';
import { checkSettingsNavigation } from './pwa-settings-navigation-checks.mjs';
import { checkInstallSettings } from './pwa-settings-install-checks.mjs';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { switchFeature, installFeatureNavigation } from './pwa-feature-navigation.mjs';

async function expectTheme(page, scheme, preference) {
	await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', scheme);
	await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
	await expect(page.locator('#pwa-theme-color')).toHaveAttribute('content', scheme === 'light' ? '#f7f7f8' : '#0d0d0f');
	await expect(page.locator('#pwa-light-theme')).toHaveAttribute('media', preference === 'system' ? '(prefers-color-scheme: light)' : preference === 'light' ? 'all' : 'not all');
}

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = 'http://127.0.0.1:' + server.address().port;
await mkdir('test-results/settings', { recursive: true });
try {
	for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
		const browser = await engine.launch();
		try {
			await checkInstallSettings(browser, origin, name);
			await checkSettingsMotion(browser, origin);
			const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
			const page = await context.newPage();
			await installFeatureNavigation(page);
			const errors = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.route('**/reading/session', route => route.fulfill({ json: {
				id: 'settings-test', folderPath: 'Reading', generation: 'settings-generation', expiresAt: Date.now() + 86400000,
			} }));
			await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
			await page.goto(origin + '/notifications?tab=inbox');
			const gear = page.getByRole('button', { name: 'Open settings', exact: true });
			await gear.click();
			const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
			await expect(sheet).toBeVisible();
			await checkSettingsNavigation(page);
			await expect(sheet.getByRole('button', { name: 'Export Reading data', exact: true })).toHaveCount(0);
			await expect(sheet.getByText('Up to date.', { exact: true })).toHaveCount(0);
			await expect(sheet.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeVisible();
			await expect(sheet.getByRole('button', { name: 'Update app', exact: true })).toHaveCount(0);
			for (const colorScheme of ['light', 'dark']) {
				await page.emulateMedia({ colorScheme });
				await sheet.locator('.settings-main').evaluate(element => { element.scrollTop = 0; });
				await page.screenshot({ path: 'test-results/settings/' + name + '-overview-' + colorScheme + '.png' });
				await sheet.getByRole('button', { name: 'Log out', exact: true }).scrollIntoViewIfNeeded();
				await page.screenshot({ path: 'test-results/settings/' + name + '-maintenance-' + colorScheme + '.png' });
			}
			await checkSettingsFocus(page, sheet);
			const listStyle = sheet.getByRole('combobox', { name: 'List style', exact: true });
			const reminderRow = page.locator('.premium-reminder-card').first();
			await expect(listStyle).toHaveValue('flat');
			await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'flat');
			await listStyle.selectOption('cards');
			await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'cards');
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
			await page.reload();
			await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'cards');
			await gear.click();
			await expect(listStyle).toHaveValue('cards');
			await listStyle.selectOption('flat');
			await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'flat');
			await checkTabSettings(page, name);
			// Page presentation fills tall and short phones, rather than stopping
			// at the desktop height cap. Resizing also exercises the layout lock.
			for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }, { width: 320, height: 568 }]) {
				await page.setViewportSize(viewport);
				await expect.poll(() => sheet.locator('.settings-main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
				for (const action of await sheet.locator('.settings-action-row:visible').all()) {
					const box = await action.boundingBox();
					expect(box.height).toBeGreaterThanOrEqual(44);
				}
				await expect.poll(async () => {
					const box = await sheet.boundingBox();
					return box && Math.abs(box.y - 10) + Math.abs(box.height - (viewport.height - 10)) + Math.abs(box.width - viewport.width);
				}).toBeLessThan(2);
			}
			await page.setViewportSize({ width: 390, height: 844 });
			// Model keyboard space inside the shared surface. The sheet keeps
			// painting to the bottom while its scrollable contents shrink.
			const keyboardStyles = await page.addStyleTag({ content: '.settings-keyboard-test .pwa-sheet-surface { padding-bottom: 300px !important; }' });
			await sheet.evaluate(element => element.classList.add('settings-keyboard-test'));
			await expect.poll(async () => {
				const box = await sheet.boundingBox();
				return box && Math.abs(box.y - 10) + Math.abs(box.height - 834);
			}).toBeLessThan(2);
			await expect(sheet.locator('.settings-sheet')).toHaveCSS('height', '534px');
			await sheet.evaluate(element => element.classList.remove('settings-keyboard-test'));
			await keyboardStyles.evaluate(element => element.remove());
			for (const title of ['General', 'Reminders', 'Reading']) await expect(sheet.getByRole('heading', { name: title, exact: true })).toBeVisible();
			await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
			await expect(page.getByRole('dialog')).toHaveCount(1);
			await expect(page.locator('[data-crate-section="reminders"]')).toHaveAttribute('inert', '');
			const days = sheet.getByRole('spinbutton', { name: 'Upcoming range (days)' });
			await days.fill('17'); await days.press('Tab');
			await expectTheme(page, 'dark', 'system');
			// Retained features and the settings consumer must share one document owner.
			await page.evaluate(() => {
				window.__themeWrites = 0;
				const observer = new MutationObserver(records => { window.__themeWrites += records.length; });
				observer.observe(document.getElementById('pwa-theme-color'), { attributes: true, attributeFilter: ['content'] });
				window.__stopThemeObserver = () => observer.disconnect();
			});
			await sheet.getByRole('button', { name: 'Light', exact: true }).click();
			await expectTheme(page, 'light', 'light');
			expect(await page.evaluate(() => window.__themeWrites)).toBe(1);
			await page.evaluate(() => window.__stopThemeObserver());
			await expect(sheet.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
			await expect(sheet.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'false');
			await sheet.getByRole('button', { name: 'System', exact: true }).click();
			await expectTheme(page, 'dark', 'system');
			await page.emulateMedia({ colorScheme: 'light' });
			await expectTheme(page, 'light', 'system');
			await page.emulateMedia({ colorScheme: 'dark' });
			await expectTheme(page, 'dark', 'system');
			await sheet.getByRole('button', { name: 'Light', exact: true }).click();
			await sheet.getByRole('combobox', { name: 'Open app to' }).selectOption('favorites');
			await checkSettingsFocus(page, sheet);
			await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-preferences')))).toEqual({ defaultScreen: 'favorites', upcomingDays: 17, dockTabs: ['inbox', 'today', 'browse', 'reading'], reminderListStyle: 'flat' });
			await page.screenshot({ path: 'test-results/settings/' + name + '-light.png' });
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
			await expect(sheet).toHaveCount(0);
			await expect(gear).toBeFocused();
			await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title')).toHaveText('Inbox');

			await switchFeature(page, 'Reading');
			const readingLibrary = page.locator('.crate-reading-workspace');
			await expect(readingLibrary).toHaveAttribute('data-list-style', 'flat');
			await page.getByRole('searchbox', { name: 'Search reading' }).fill('retained query');
			await checkCompoundFocus(page, page.getByRole('searchbox', { name: 'Search reading' }), page.locator('.crate-feature-panel[data-active="true"] .crate-field--search .crate-field__control'));
			await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('retained query');
			await gear.click();
			await checkSettingsFocus(page, sheet);
			await expect(sheet.getByRole('spinbutton', { name: 'Upcoming range (days)' })).toHaveValue('17');
			await listStyle.selectOption('cards');
			await expect(readingLibrary).toHaveAttribute('data-list-style', 'cards');
			await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'cards');
			await listStyle.selectOption('flat');
			await expect(readingLibrary).toHaveAttribute('data-list-style', 'flat');

			await expect(sheet.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute('aria-pressed', 'true');
			await sheet.getByRole('button', { name: 'Set up iPhone shortcut' }).click();
			const shortcut = page.getByRole('dialog', { name: 'Set up iPhone shortcut', exact: true });
			await expect(shortcut.getByRole('link', { name: 'Download Save to Crate' })).toBeVisible();
			await expect(shortcut.getByRole('button', { name: 'Close shortcut setup', exact: true })).toHaveCount(1);
			await expect(shortcut.getByRole('button', { name: 'Back to settings' })).toHaveCount(0);
			await expect(page.locator('.settings-page-stack')).toHaveAttribute('inert', '');
			await page.screenshot({ path: 'test-results/settings/' + name + '-shortcut.png' });
			await shortcut.getByRole('button', { name: 'Close shortcut setup', exact: true }).click();
			await expect(shortcut).toHaveCount(0);
			await expect(sheet).toBeVisible();
			await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeFocused();
			// Exercise sheet dismissal too, keeping the parent panel and scroll intact.
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await sheet.getByRole('button', { name: 'Set up iPhone shortcut' }).click();
			const retainedScroll = await page.locator('.settings-main').evaluate(element => element.scrollTop);
			await expect(shortcut).toHaveCSS('transform', 'none');
			await page.keyboard.press('Escape');
			await expect(shortcut).toHaveCount(0);
			await expect(sheet).toBeVisible();
			await expect.poll(() => sheet.locator('.settings-main').evaluate(element => Math.abs(new DOMMatrixReadOnly(getComputedStyle(element).transform).m41))).toBeLessThan(1);
			expect(await sheet.locator('.settings-main').evaluate(element => element.scrollTop)).toBe(retainedScroll);
			await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeFocused();
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await expect(sheet.getByText('Device storage', { exact: true })).toBeVisible();
			// Hold refresh open so unrelated controls are checked during real pending work.
			let releaseRefresh;
			const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
			const delayedList = async route => { await refreshGate; await route.fulfill({ json: { items: [], issues: [], cursor: null } }); };
			await page.route('**/reading/list*', delayedList);
			await sheet.getByRole('button', { name: 'Refresh all', exact: true }).click();
			await expect(sheet.getByRole('button', { name: 'Refresh all', exact: true })).toBeDisabled();
			for (const label of ['Copy diagnostics', 'Close settings', 'Log out']) {
				await expect(sheet.getByRole('button', { name: label, exact: true })).toBeEnabled();
				await expect(sheet.getByRole('button', { name: label, exact: true })).toHaveCSS('opacity', '1');
			}
			await sheet.getByRole('button', { name: 'Log out', exact: true }).click();
			const pendingLogout = page.getByRole('dialog', { name: 'Log out of Crate?', exact: true });
			await expect(pendingLogout.getByRole('button', { name: 'Log out and clear device data', exact: true })).toHaveAttribute('aria-disabled', 'true');
			await expect(pendingLogout.getByRole('button', { name: 'Logging out…', exact: true })).toHaveCount(0);
			await pendingLogout.getByRole('button', { name: 'Cancel', exact: true }).click();
			releaseRefresh();
			await expect(sheet.getByRole('button', { name: 'Refresh all', exact: true })).toBeEnabled();
			await page.unroute('**/reading/list*', delayedList);
			await expect(sheet.getByRole('button', { name: 'Close settings', exact: true })).toBeEnabled();
			await sheet.getByRole('button', { name: 'Dark', exact: true }).click();
			await expect(sheet.getByRole('button', { name: 'Dark', exact: true })).toHaveClass(/is-active/);
			await expect(sheet.getByRole('button', { name: 'Light', exact: true })).not.toHaveClass(/is-active/);
			await page.screenshot({ path: 'test-results/settings/' + name + '-dark-sync.png' });
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
			await expect(gear).toBeFocused();
			await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('retained query');
			await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', 'dark');
			// Theme subscriptions survive settings unmounts and ignore system changes
			// while an explicit override is selected. Cross-tab updates are native events.
			await page.emulateMedia({ colorScheme: 'light' });
			await expectTheme(page, 'dark', 'dark');
			const peer = await context.newPage();
			try {
				await peer.goto(origin + '/notifications?tab=inbox');
				await peer.evaluate(() => {
					const preferences = JSON.parse(localStorage.getItem('crate-reminders-preferences'));
					localStorage.setItem('crate-reminders-preferences', JSON.stringify({ ...preferences, reminderListStyle: 'cards' }));
				});
				await expect(readingLibrary).toHaveAttribute('data-list-style', 'cards');
				await expect(reminderRow).toHaveAttribute('data-reminder-list-style', 'cards');
				await peer.evaluate(() => localStorage.setItem('crate-reminders-theme', 'system'));
				await expectTheme(page, 'light', 'system');
				await gear.click();
				await expect(sheet.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true');
				await peer.evaluate(() => localStorage.setItem('crate-reminders-theme', 'dark'));
				await expectTheme(page, 'dark', 'dark');
				await expect(sheet.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
				await peer.evaluate(() => localStorage.setItem('crate-reminders-theme', 'invalid-theme'));
				await expectTheme(page, 'light', 'system');
				await sheet.getByRole('button', { name: 'Dark', exact: true }).click();
				await expectTheme(peer, 'dark', 'dark');
				await peer.evaluate(() => localStorage.removeItem('crate-reminders-theme'));
				await expectTheme(page, 'light', 'system');
				await sheet.getByRole('button', { name: 'Dark', exact: true }).click();
				await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
			} finally { await peer.close(); }
			await switchFeature(page, 'Reminders');
			await expectTheme(page, 'dark', 'dark');
			await switchFeature(page, 'Reading');
			await expectTheme(page, 'dark', 'dark');

			// The saved opening preference must select Reading before its first mount.
			await page.waitForLoadState('networkidle');
			const readingLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/reading/list');
			await page.goto(origin + '/notifications');
			await expect(page.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reading');
			await expect(page.getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
			// Let the mounted Reading session finish loading before unloading this document.
			await (await readingLoaded).finished();
			await page.waitForLoadState('networkidle');
			// Explicit notification and tab targets still win over the preference.
			await page.goto(origin + '/notifications?tab=inbox');
			await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title')).toHaveText('Inbox');
			await gear.click();
			await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();

			// An inactive feature's saved work must be visible before a shared logout.
			await page.evaluate(async () => {
				const session = JSON.parse(localStorage.getItem('crate-reading-session-v1'));
				const db = await new Promise((resolve, reject) => {
					const request = indexedDB.open('crate-reading-v1', 1);
					request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
				});
				const tx = db.transaction('values', 'readwrite');
				tx.objectStore('values').put([{ id: 'settings-pending', sessionId: session.id, action: 'capture',
					intent: { url: 'https://example.com/pending', title: 'Keep this pending link' }, review: true, error: 'Saved Reading change needs review.' }], 'pending:' + session.id);
				await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
				db.close(); window.dispatchEvent(new Event('crate-reading-change'));
			});
			await gear.click();
			await expect(sheet.getByRole('status').filter({ hasText: 'Reading: 1 change needs attention' })).toBeVisible();
			await sheet.getByRole('button', { name: 'Log out', exact: true }).click();
			const logout = page.getByRole('dialog', { name: 'Log out of Crate?', exact: true });
			await expect(logout.getByText(/unsynced or unverified changes/)).toBeVisible();
			await expect(logout.getByRole('button', { name: 'Export Reading data', exact: true })).toBeEnabled();
			await logout.getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(sheet.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
			await page.setViewportSize({ width: 320, height: 568 });
			await expect(sheet.getByRole('combobox', { name: 'Open app to' })).toBeVisible();
			expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.screenshot({ path: 'test-results/settings/' + name + '-compact.png' });
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.screenshot({ path: 'test-results/settings/' + name + '-desktop.png' });
			await sheet.getByRole('button', { name: 'Log out', exact: true }).click();
			await logout.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => [localStorage.getItem('crate-reminders-auth-token'), localStorage.getItem('crate-reading-session-v1')])).toEqual([null, null]);
			expect(errors).toEqual([]);
			await context.close();
			await checkDisabledReading(browser, origin, name);
			const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
			const offlinePage = await offlineContext.newPage();
			await offlinePage.goto(origin + '/notifications?tab=inbox');
			await offlinePage.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
			await offlineContext.setOffline(true);
			await offlinePage.getByRole('button', { name: 'Open settings', exact: true }).click();
			const offlineSheet = offlinePage.getByRole('dialog', { name: 'Settings', exact: true });
			await expect(offlineSheet.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
			await expect(offlineSheet.getByRole('button', { name: 'Close settings', exact: true })).toBeEnabled();
			await offlineSheet.getByRole('button', { name: 'Close settings', exact: true }).click();
			await expect(offlineSheet).toHaveCount(0);
			await expect(offlinePage.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
			await offlineContext.close();
			console.log(name + ': unified settings, retained views, theme, launch preferences, pending-change warnings, and shared logout passed');
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
