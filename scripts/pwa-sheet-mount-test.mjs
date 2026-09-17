import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

// Use the production React runtime and real sheet portal. A notification can
// open the sheet in the same render that replaces the splash with the app root.
const { outputFiles } = await build({
	stdin: { contents: `
		import React from 'react';
		import { createRoot } from 'react-dom/client';
		import { PwaModalSheet } from './src/pwa/components/PwaModalSheet';
		function Harness() {
			const [open, setOpen] = React.useState(true);
			const [dismissible, setDismissible] = React.useState(true);
			window.setSheetDismissible = setDismissible;
			return <div className="crate-reminders-ui pwa-shadow-root">
				<button id="open" onClick={() => setOpen(true)}>Open</button>
				{open && <PwaModalSheet isOpen onClose={() => setOpen(false)}
					onCloseEnd={() => {}} variant="reminder" label="Edit reminder" dismissible={dismissible}>
					<h2 id="title">Edit reminder</h2>
					<button id="close" onClick={() => setOpen(false)}>Close</button>
				</PwaModalSheet>}
			</div>;
		}
		createRoot(document.getElementById('root')).render(<Harness />);
	`, resolveDir: process.cwd(), loader: 'tsx' },
	bundle: true, write: false, format: 'iife', platform: 'browser',
	define: { 'process.env.NODE_ENV': '"production"' },
});
for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.setContent('<style>.crate-reminders-ui #title { font-size: 17px; }</style><div id="root"></div>');
		await page.addScriptTag({ content: outputFiles[0].text });
		for (let opening = 0; opening < 2; opening++) {
			await expect(page.locator('.pwa-shadow-root .pwa-modal-sheet #title')).toHaveCount(1);
			await expect(page.locator('#title')).toHaveCSS('font-size', '17px');
			assert.equal(await page.locator('body > .pwa-modal-sheet').count(), 0);
			await page.evaluate(() => window.setSheetDismissible(false));
			await expect(page.getByRole('dialog')).toHaveAttribute('data-base-ui-swipe-ignore', '');
			await page.getByRole('dialog').focus();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(1);
			await page.evaluate(() => window.setSheetDismissible(true));
			await expect(page.getByRole('dialog')).not.toHaveAttribute('data-base-ui-swipe-ignore');
			if (opening === 0) await page.locator('#close').click();
			else await page.keyboard.press('Escape');
			await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
			await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
			if (opening === 0) await page.locator('#open').click();
		}
		console.log(`${browserType.name()}: startup/reopened portals retain scoped styles and busy sheets reject dismissal`);
	} finally {
		await browser.close();
	}
}
