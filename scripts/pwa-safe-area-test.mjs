import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;

async function checkNavigation(page, inset, height = page.viewportSize().height) {
	await expect(page.locator('.view-header-title').first()).toHaveCSS('font-size', '24px');
	const geometry = await page.evaluate(() => {
		const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
		return {
			app: bounds('#app'),
			bar: bounds('.pwa-dock'),
			items: bounds('.pwa-dock__bar'),
			fab: bounds('.pwa-dock__add'),
			selection: bounds('.pwa-dock__tab.is-active'),
			activeContent: bounds('.pwa-dock__tab.is-active'),
			buttons: [...document.querySelectorAll('.pwa-dock__tab')].map(button => button.getBoundingClientRect().toJSON()),
			header: bounds('.view-header'),
			title: bounds('.view-header-title'),
			meta: bounds('.view-header-meta'),
			settings: bounds('.pwa-header-settings-button'),
			sync: bounds('.pwa-sync-indicator__button'),
			topInset: parseFloat(getComputedStyle(document.querySelector('.view-header')).paddingTop) - parseFloat(getComputedStyle(document.querySelector('.view-header')).getPropertyValue('--pwa-header-top-gap')),
		};
	});
	assert.ok(Math.abs(geometry.app.bottom - height) < 1, 'app fills the visible viewport');
	assert.ok(Math.abs(geometry.bar.bottom - height) < 1, 'bar background fills the bottom edge');
	const bottomGap = Math.max(10, inset);
	assert.ok(Math.abs(geometry.bar.height - 66 - bottomGap) < 1, `safe area is reserved exactly once: expected ${bottomGap}px, got ${geometry.bar.height - 66}px`);
	assert.ok(Math.abs(geometry.items.bottom - (height - bottomGap)) < 1, `dock sits above the ${inset}px safe area without extra padding`);
	for (const button of geometry.buttons) {
		assert.ok(button.bottom <= height - inset + 1, 'entire tab touch target stays outside the safe area');
		assert.ok(button.height >= 44, 'tab retains its touch target');
	}
	assert.ok(geometry.selection.height >= 44, 'selected background covers the icon and label with padding');
	assert.ok(Math.abs((geometry.selection.left + geometry.selection.width / 2) - (geometry.activeContent.left + geometry.activeContent.width / 2)) < 1, 'selected background is centered on its tab');
	assert.ok(Math.abs(geometry.fab.bottom - geometry.items.bottom) < 1, 'add button aligns with the dock');
	assert.ok(geometry.fab.left >= geometry.items.right + 8, 'add button stays separate from navigation');
	for (const button of [geometry.settings, geometry.sync]) {
		assert.ok(button.height >= 44 && button.width >= 44, 'compact headers preserve touch targets');
		assert.ok(button.top >= geometry.topInset, 'header actions remain below the status-bar safe area');
	}
	if (page.viewportSize().width < 760) {
		assert.ok(geometry.header.height - geometry.topInset <= 78, 'phone header leaves more room for content');
		assert.ok(geometry.title.bottom <= geometry.meta.top + 1, 'title and count remain separate and readable');
	}
}

async function checkIos27(browser, colorScheme, retainedTranslucent = false, shortLayoutViewport = false) {
	// Existing installs can keep the full translucent canvas despite new metadata.
	const height = retainedTranslucent ? 852 : 790;
	const layoutHeight = shortLayoutViewport ? 790 : height;
	const page = await browser.newPage({ viewport: { width: 393, height: layoutHeight }, hasTouch: true, colorScheme,
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1' });
	await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
	await page.route('**/notifications?*', async route => {
		const response = await route.fetch();
		const body = (await response.text()).replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, style => style
			.replaceAll('(display-mode:standalone)', '(min-width:0px)')
			.replaceAll(retainedTranslucent && !shortLayoutViewport ? '100dvh' : '100vh', retainedTranslucent && !shortLayoutViewport ? 'calc(100vh - 62px)' : 'calc(100dvh + 62px)')
			.replaceAll('env(safe-area-inset-top)', retainedTranslucent ? '62px' : '0px')
			.replaceAll('env(safe-area-max-inset-top,0px)', '62px')
			.replaceAll('env(safe-area-inset-bottom)', '34px')
			.replaceAll('env(safe-area-max-inset-bottom,0px)', '34px'));
		await route.fulfill({ response, body });
	});
	await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
	await expect(page.locator('html')).toHaveAttribute('data-pwa-ios27-standalone', 'true');
	await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default');
	await page.locator('.pwa-dock [data-dock-active]').waitFor();
	const header = page.locator('.pwa-reminders-view .view-header').first();
	await expect(header).toHaveCSS('position', 'sticky');
	await expect(header).toHaveCSS('padding-top', retainedTranslucent ? '66px' : '4px');
	await expect(header).toHaveCSS('background-color', colorScheme === 'light' ? 'rgb(247, 247, 248)' : 'rgb(13, 13, 15)');
	await checkNavigation(page, 34, height);
	const top = (await header.boundingBox()).y;
	await page.addStyleTag({ content: '.ios27-scroll-fixture { height:2000px }' });
	await page.locator('.reminders-view-scroll').first().evaluate(el => {
		const spacer = document.createElement('div'); spacer.className = 'ios27-scroll-fixture'; el.append(spacer); el.scrollTop = 400;
	});
	assert.equal((await header.boundingBox()).y, top, 'opaque header stays at the top while content scrolls');
	await page.getByRole('button', { name: 'Open settings', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Copy diagnostics', exact: true })).toBeVisible();
	const backdrop = await page.locator('.pwa-modal-sheet__backdrop').boundingBox();
	assert.ok(backdrop.y === 0 && backdrop.height === height, 'sheet covers the actual installed viewport');
	await page.keyboard.press('Escape');
	await page.locator('.pwa-modal-sheet').waitFor({ state: 'detached' });
	await checkNavigation(page, 34, height);
	// Landscape no longer reserves the portrait status bar.
	if (shortLayoutViewport) await page.addStyleTag({ content: 'html[data-pwa-ios27-standalone="true"]{--pwa-safe-area-top:0px}' });
	await page.setViewportSize({ width: 852, height: 393 });
	await checkNavigation(page, 34);
	await page.close();
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			for (const { standalone, colorScheme, bottomInset, maxBottomInset = bottomInset } of [
				{ standalone: false, colorScheme: 'light', bottomInset: 0 },
				{ standalone: true, colorScheme: 'light', bottomInset: 21, maxBottomInset: 34 },
				{ standalone: true, colorScheme: 'dark', bottomInset: 34 },
				{ standalone: true, colorScheme: 'light', bottomInset: 0 },
				{ standalone: true, colorScheme: 'dark', bottomInset: 0, maxBottomInset: 34 },
			]) {
				// Current and maximum insets can differ; reserve only the current one.
				const reservedInset = bottomInset;
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
							.replaceAll('100dvh', 'calc(100vh - 62px)')
							// Replace browser-owned env values, not the app's token:
							// overriding that token would hide a hard-coded inset floor.
							.replaceAll('env(safe-area-inset-bottom)', `${bottomInset}px`)
							.replaceAll('env(safe-area-max-inset-bottom,0px)', `${maxBottomInset}px`));
						await route.fulfill({ response, body });
					});
				}
				await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
				await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
				if (standalone) await page.addStyleTag({ content: '@media(orientation:portrait){:root{--pwa-safe-area-top:62px}}' });
				await page.locator('.pwa-dock [data-dock-active]').waitFor();
				if (standalone) await page.evaluate(() => {
					// Layout/visual viewport APIs may report the same shorter height.
					// The sheet lock must retain the rendered full-screen canvas.
					const reportedHeight = () => window.innerWidth === 393 ? 790 : 393;
					Object.defineProperty(window, 'innerHeight', { configurable: true, get: reportedHeight });
					Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: reportedHeight });
					Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: reportedHeight });
				});
				if (standalone) await expect(page.locator('.view-header').first()).toHaveCSS('padding-top', '66px');
				await checkNavigation(page, reservedInset);
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
				await checkNavigation(page, reservedInset);
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
				await expect(fallback).toHaveCSS('min-height', '160px');
				assert.equal(JSON.parse(await fallback.inputValue()).format, 'crate-version-diagnostics');
				await page.close();
			}
			for (const colorScheme of ['light', 'dark']) {
				await checkIos27(browser, colorScheme);
				await checkIos27(browser, colorScheme, true);
				// Fixed insets and percentages can end at 790px even though vh can paint 852px.
				await checkIos27(browser, colorScheme, true, true);
			}
			console.log(`${browserType.name()}: navigation safe areas, standalone viewport, rotation, and sheet dismissal passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise(resolve => server.close(resolve));
}
