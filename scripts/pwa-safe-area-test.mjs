import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;

async function checkNavigation(page, inset) {
	const height = page.viewportSize().height;
	const geometry = await page.evaluate(() => {
		const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
		return {
			app: bounds('#app'),
			bar: bounds('.bottom-tab-bar'),
			items: bounds('.bottom-tab-items'),
			fab: bounds('.reminders-fab'),
			selection: bounds('.bottom-tab-slider'),
			activeContent: bounds('.bottom-tab-button.is-active .bottom-tab-content'),
			buttons: [...document.querySelectorAll('[data-action="switch-tab"]')].map(button => button.getBoundingClientRect().toJSON()),
		};
	});
	assert.ok(Math.abs(geometry.app.bottom - height) < 1, 'app fills the visible viewport');
	assert.ok(Math.abs(geometry.bar.bottom - height) < 1, 'bar background fills the bottom edge');
	assert.ok(Math.abs(geometry.bar.height - 64 - inset) < 1, 'safe area is reserved exactly once');
	assert.ok(geometry.items.bottom <= height - inset + 1, 'tab content stays above the home indicator');
	for (const button of geometry.buttons) {
		assert.ok(button.bottom <= height - inset + 1, 'entire tab touch target stays outside the safe area');
		assert.ok(button.height >= 44, 'tab retains its touch target');
	}
	assert.ok(geometry.selection.height >= 56, 'selected background covers the icon and label with padding');
	assert.ok(Math.abs((geometry.selection.left + geometry.selection.width / 2) - (geometry.activeContent.left + geometry.activeContent.width / 2)) < 1, 'selected background is centered on its tab');
	assert.ok(geometry.fab.bottom <= geometry.bar.top - 15, 'add button clears the tab bar');
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			for (const { standalone, colorScheme } of [
				{ standalone: false, colorScheme: 'light' },
				{ standalone: true, colorScheme: 'light' },
				{ standalone: true, colorScheme: 'dark' },
			]) {
				const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true, colorScheme });
				if (standalone) {
					// Model iOS's shorter dynamic viewport under translucent chrome:
					// 100dvh excludes the 62px status bar even though the app can paint
					// across the full 100vh surface. Desktop engines normally equate
					// these units, which previously hid the bottom-gap regression.
					await page.route('**/notifications?*', async route => {
						const response = await route.fetch();
						const body = (await response.text()).replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, style => style
							.replaceAll('(display-mode:standalone)', '(min-width:0px)')
							.replaceAll('100dvh', 'calc(100vh - 62px)'));
						await route.fulfill({ response, body });
					});
				}
				await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
				await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
				if (standalone) await page.addStyleTag({ content: '@media(orientation:portrait){:root{--pwa-safe-area-top:62px}}' });
				await page.locator('.bottom-tab-bar').waitFor();
				if (standalone) await page.evaluate(() => {
					// Layout/visual viewport APIs may report the same shorter height.
					// The sheet lock must retain the rendered full-screen canvas.
					const reportedHeight = () => window.innerWidth === 393 ? 790 : 393;
					Object.defineProperty(window, 'innerHeight', { configurable: true, get: reportedHeight });
					Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: reportedHeight });
					Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: reportedHeight });
				});
				if (standalone) await expect(page.locator('.view-header').first()).toHaveCSS('padding-top', '79px');
				await checkNavigation(page, standalone ? 34 : 0);
				// Check resize/rotation and inset changes without reloading the app.
				await page.setViewportSize({ width: 852, height: 393 });
				const landscapeInset = await page.addStyleTag({ content: ':root{--pwa-safe-area-bottom:21px}' });
				await checkNavigation(page, 21);
				await page.setViewportSize({ width: 393, height: 852 });
				await landscapeInset.evaluate(element => element.remove());
				const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
				await card.tap();
				const backdrop = page.locator('.pwa-modal-sheet__backdrop');
				await expect(backdrop).toHaveCSS('opacity', '1');
				const backdropBounds = await backdrop.boundingBox();
				assert.ok(backdropBounds.y <= 0 && backdropBounds.y + backdropBounds.height >= 852,
					'one continuous backdrop covers the status-bar safe area and the rest of the screen');
				await expect(backdrop).toHaveCSS('background-color', colorScheme === 'light' ? 'rgba(24, 24, 27, 0.18)' : 'rgba(0, 0, 0, 0.32)');
				await expect(backdrop).toHaveCSS('backdrop-filter', 'none');
				await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
				await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
				await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
				await checkNavigation(page, standalone ? 34 : 0);
				await page.getByRole('button', { name: 'Open settings', exact: true }).click();
				const copyButton = page.getByRole('button', { name: 'Copy diagnostics', exact: true });
				await expect(copyButton).toBeVisible();
				assert.ok(await copyButton.evaluate(button => button.scrollWidth <= button.clientWidth), 'diagnostics label fits inside its button');
				await page.evaluate(() => {
					Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
						writeText: async text => { window.copiedDiagnostics = text; },
					} });
				});
				await copyButton.tap();
				await expect(page.getByRole('status').filter({ hasText: 'Version details copied.' })).toBeVisible();
				assert.equal(await page.evaluate(() => JSON.parse(window.copiedDiagnostics).format), 'crate-version-diagnostics');
				await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); }; });
				await copyButton.tap();
				const fallback = page.getByRole('textbox', { name: 'Version diagnostics', exact: true });
				await expect(fallback).toBeVisible();
				assert.equal(JSON.parse(await fallback.inputValue()).format, 'crate-version-diagnostics');
				await page.close();
			}
			console.log(`${browserType.name()}: navigation safe areas, standalone viewport, rotation, and sheet dismissal passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise(resolve => server.close(resolve));
}
