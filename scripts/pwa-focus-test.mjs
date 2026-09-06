import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
			await page.goto(`${origin}/notifications?folder=Reminders`);
			const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
			await card.waitFor();
			// Observe focus before the card click finishes, not after an async load.
			await page.evaluate(() => {
				window.editorFocusedDuringClick = [];
				document.addEventListener('click', (event) => {
					if (!event.target.closest('.sidebar-reminder-card-wrapper')) return;
					window.editorFocusedDuringClick.push(document.activeElement?.getAttribute('aria-label') === 'Reminder title');
				});
			});
			for (let opening = 0; opening < 2; opening++) {
				await card.tap();
				assert.equal(await page.evaluate(() => window.editorFocusedDuringClick.at(-1)), true,
					`${browserType.name()}: opening ${opening + 1} must focus during the tap`);
				const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
				await expect(title).toHaveText('Check this article');
				await title.fill('Discard this draft');
				await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
				await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
			}
			await card.tap();
			await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Updated article');
			await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
			await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
			await page.getByRole('group', { name: 'Updated article. Press Enter to edit reminder.', exact: true }).waitFor();
			await page.request.post(`${origin}/preview/reset`);
			console.log(`${browserType.name()}: synchronous focus, discarded drafts and saving local edits passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
