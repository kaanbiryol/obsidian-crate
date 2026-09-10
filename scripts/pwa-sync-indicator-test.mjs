import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
	stdin: { contents: `
		import React from 'react';
		import { createRoot } from 'react-dom/client';
		import { PwaSyncIndicator } from './src/pwa/components/PwaSyncIndicator';
		function Harness() {
			const [props, setProps] = React.useState({});
			window.setSyncProps = setProps;
			return React.createElement(PwaSyncIndicator, {
				changes: [], isOffline: false, refreshing: false, dataMode: 'live',
				error: null, storageError: null, ...props,
			});
		}
		window.root = createRoot(document.getElementById('root'));
		window.root.render(React.createElement(Harness));
	`, resolveDir: process.cwd(), loader: 'js' },
	bundle: true, write: false, format: 'iife', platform: 'browser',
});
const css = compileString(`
	@use 'src/pwa/styles/reminder-sync-notices' as indicator;
	@include indicator.styles;
`, { loadPaths: [process.cwd()] }).css;

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage();
		await page.clock.install();
		await page.setContent('<div id="root"></div>');
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: outputFiles[0].text });
		const indicator = page.locator('.pwa-sync-indicator');
		const setState = props => page.evaluate(value => window.setSyncProps(value), props);
		await expect(indicator).toHaveAttribute('data-visual-state', 'synced');
		assert.equal(await indicator.locator('.pwa-sync-indicator__dot').evaluate(el => getComputedStyle(el).animationName), 'none', 'Initial idle mount must not celebrate');

		await setState({ refreshing: true });
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(50);
		await setState({});
		await expect(indicator).toHaveAttribute('data-sync-state', 'synced');
		await expect(indicator).toHaveAttribute('title', 'All changes synced');
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(250);
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(400);
		await expect(indicator).toHaveAttribute('data-visual-state', 'settling');
		assert.equal(await indicator.locator('.pwa-sync-indicator__ripple').evaluate(el => getComputedStyle(el).animationName), 'pwa-sync-ripple');
		await page.clock.runFor(850);
		await expect(indicator).toHaveAttribute('data-visual-state', 'synced');

		// Failure/offline must interrupt a pending success, including its timers.
		for (const [props, state] of [[{ error: 'Refresh failed' }, 'error'], [{ isOffline: true }, 'offline']]) {
			await setState({ refreshing: true });
			await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
			await page.clock.runFor(50);
			await setState({});
			await expect(indicator).toHaveAttribute('data-sync-state', 'synced');
			await setState(props);
			await expect(indicator).toHaveAttribute('data-visual-state', state);
			await page.clock.runFor(1600);
			await expect(indicator).toHaveAttribute('data-visual-state', state);
		}

		await setState({ refreshing: true });
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(700);
		await setState({});
		await page.clock.runFor(30);
		await expect(indicator).toHaveAttribute('data-visual-state', 'settling');
		await setState({ refreshing: true });
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(1000);
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setState({});
		await expect(indicator).toHaveAttribute('data-visual-state', 'synced');
		await setState({ refreshing: true });
		await expect(indicator).toHaveAttribute('data-visual-state', 'syncing');
		assert.equal(await indicator.locator('.pwa-sync-indicator__halo').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
		await setState({});
		await expect(indicator).toHaveAttribute('data-visual-state', 'synced');
		await page.evaluate(() => window.root.unmount());
		await page.clock.runFor(1600);
		console.log(`${browserType.name()}: sync motion, interruptions, and reduced motion passed`);
	} finally {
		await browser.close();
	}
}
