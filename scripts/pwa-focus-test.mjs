import assert from 'node:assert/strict';
import { chromium, webkit } from '@playwright/test';
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
				await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
				await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
			}
			console.log(`${browserType.name()}: first and repeated card taps focus synchronously`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
