import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
	stdin: { contents: `
		import React from 'react';
		import { createRoot } from 'react-dom/client';
		import { PwaSyncIndicator } from './src/pwa/components/PwaSyncIndicator';
		import { ViewHeader } from './src/reminders/components/ViewHeader';
		import { ProjectDetailHeader } from './src/reminders/ui/views/ProjectDetailHeader';
		function Harness() {
			const [props, setProps] = React.useState({});
			window.setSyncProps = setProps;
			const [header, setHeader] = React.useState({title:'Upcoming',project:false});
			window.setHeaderProps = setHeader;
			const indicator = React.createElement(PwaSyncIndicator, {
				changes: [], isOffline: false, refreshing: false, dataMode: 'live',
				error: null, storageError: null, onShowStatus: label => { window.lastSyncStatus = label; }, ...props,
			});
			return header.project
				? React.createElement(ProjectDetailHeader, {project:header.title,header:{total:0},titleContent:indicator})
				: React.createElement(ViewHeader, {title:header.title,count:3,titleContent:indicator});
		}
		window.root = createRoot(document.getElementById('root'));
		window.root.render(React.createElement(Harness));
	`, resolveDir: process.cwd(), loader: 'js' },
	bundle: true, write: false, format: 'iife', platform: 'browser',
});
const css = compileString(`
	@use 'src/pwa/styles/reminder-sync-notices' as indicator;
	@use 'src/reminders/ui/shared/styles/shell';
	@use 'src/reminders/ui/shared/styles/project-detail';
	body { margin:0; font-family:Arial,sans-serif; }
	#root { --reminder-font-title:32px; --text-normal:#eee; --text-muted:#999; background:#202020;
		@include shell.styles; @include project-detail.styles; @include indicator.styles;
	}
`, { loadPaths: [process.cwd()] }).css;

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage({viewport:{width:390,height:844}});
		await page.clock.install();
		await page.setContent('<div id="root"></div>');
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: outputFiles[0].text });
		const indicator = page.locator('.pwa-sync-indicator');
		const visual = indicator.locator('.crate-sync-indicator');
		const setState = props => page.evaluate(value => window.setSyncProps(value), props);
		await expect(visual).toHaveAttribute('data-visual-state', 'synced');
		assert.equal(await indicator.locator('.crate-sync-indicator__dot').evaluate(el => getComputedStyle(el).animationName), 'none', 'Initial idle mount must not celebrate');

		for (const project of [false, true]) {
			for (const title of ['Today', 'Upcoming', 'Équipe à Berlin', 'A long project title that must truncate']) {
				await page.evaluate(value => window.setHeaderProps(value), {title,project});
				await expect(page.getByRole('heading',{level:1})).toHaveText(title);
				const heading = await page.getByRole('heading',{level:1}).boundingBox();
				const dot = await visual.locator('.crate-sync-indicator__dot').boundingBox();
				const button = await indicator.getByRole('button').boundingBox();
				assert.ok(Math.abs(heading.y + heading.height/2 - dot.y - dot.height/2) < 1, 'Dot must center vertically with title');
				assert.equal(button.height,44); assert.equal(button.width,44);
				assert.ok(button.x + button.width <= 390, 'Long titles must leave the indicator on screen');
			}
		}
		await page.evaluate(() => window.setHeaderProps({title:'Upcoming',project:false}));
		await page.screenshot({path:'/tmp/crate-sync-alignment-' + browserType.name() + '.png'});
		await indicator.getByRole('button').click();
		assert.equal(await page.evaluate(() => window.lastSyncStatus), 'All changes synced');

		await setState({ refreshing: true });
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(50);
		await setState({});
		await expect(indicator).toHaveAttribute('data-sync-state', 'synced');
		await expect(indicator).toHaveAttribute('title', 'All changes synced');
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(250);
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(400);
		await expect(visual).toHaveAttribute('data-visual-state', 'settling');
		assert.equal(await indicator.locator('.crate-sync-indicator__ripple').evaluate(el => getComputedStyle(el).animationName), 'pwa-sync-ripple');
		await page.clock.runFor(2900);
		await expect(visual).toHaveAttribute('data-visual-state', 'synced');

		// Failure/offline must interrupt a pending success, including its timers.
		for (const [props, state] of [[{ error: 'Refresh failed' }, 'error'], [{ isOffline: true }, 'offline']]) {
			await setState({ refreshing: true });
			await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
			await page.clock.runFor(50);
			await setState({});
			await expect(indicator).toHaveAttribute('data-sync-state', 'synced');
			await setState(props);
			await expect(visual).toHaveAttribute('data-visual-state', state);
			await page.clock.runFor(1600);
			await expect(visual).toHaveAttribute('data-visual-state', state);
		}

		await setState({ refreshing: true });
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(700);
		await setState({});
		await page.clock.runFor(30);
		await expect(visual).toHaveAttribute('data-visual-state', 'settling');
		await setState({ refreshing: true });
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		await page.clock.runFor(1000);
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');

		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setState({});
		await expect(visual).toHaveAttribute('data-visual-state', 'synced');
		await setState({ refreshing: true });
		await expect(visual).toHaveAttribute('data-visual-state', 'syncing');
		assert.equal(await indicator.locator('.crate-sync-indicator__halo').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
		await setState({});
		await expect(visual).toHaveAttribute('data-visual-state', 'synced');
		await page.evaluate(() => window.root.unmount());
		await page.clock.runFor(1600);
		console.log(`${browserType.name()}: sync motion, interruptions, and reduced motion passed`);
	} finally {
		await browser.close();
	}
}
