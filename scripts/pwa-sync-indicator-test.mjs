import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
	stdin: { contents: `
		import React from 'react';
		import { createRoot } from 'react-dom/client';
		import { PwaSyncStatusIndicator } from './src/pwa/components/PwaSyncStatusIndicator';
		import { reminderSyncStatus } from './src/pwa/sync/reminder-status';
		import { ViewHeader } from './src/reminders/components/ViewHeader';
		import { ProjectDetailHeader } from './src/reminders/ui/views/ProjectDetailHeader';
		function Harness() {
			const [props, setProps] = React.useState({});
			window.setSyncProps = setProps;
			const [header, setHeader] = React.useState({title:'Upcoming',project:false});
			window.setHeaderProps = setHeader;
			const indicator = React.createElement(PwaSyncStatusIndicator, { ...reminderSyncStatus({
				changes: [], isOffline: false, refreshing: false, dataMode: 'live',
				error: null, storageError: null, ...props }), onShowStatus: label => { window.lastSyncStatus = label; },
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
	@use 'src/ui/shared/styles/view-header';
	body { margin:0; font-family:Arial,sans-serif; }
	#root { --reminder-font-title:32px; --text-normal:#eee; --text-muted:#999; background:#202020;
		@include shell.styles; @include view-header.styles; @include project-detail.styles; @include indicator.styles;
	}
`, { loadPaths: [process.cwd()] }).css;

const palettes = await Promise.all(['palette', 'theme-light'].map(name =>
	readFile(`src/cloudflare/worker/pwa/styles/${name}.css`, 'utf8')));
const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3)
	.map(value => Number(value) / 255)
	.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
	.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);

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

		for (const project of process.argv.includes('--motion-only') ? [] : [false, true]) {
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
		assert.equal(await visual.evaluate(el => getComputedStyle(el).getPropertyValue('--sync-indicator-color').trim()), '#f59e0b', 'Fast success keeps the visual indicator orange through its minimum syncing phase');
		await page.clock.runFor(400);
		await expect(visual).toHaveAttribute('data-visual-state', 'settling');
		assert.equal(await indicator.locator('.crate-sync-indicator__ripple').evaluate(el => getComputedStyle(el).animationName), 'pwa-sync-ripple');
		assert.equal(await visual.evaluate(el => getComputedStyle(el).getPropertyValue('--sync-indicator-color').trim()), '#22c55e');
		assert.equal(await indicator.locator('.crate-sync-indicator__ripple').evaluate(el => getComputedStyle(el).animationDelay), '0s', 'The success wave starts with the green transition');
		for (const time of [70, 140, 280, 420, 700, 1100]) {
			const centers = await visual.evaluate((el, time) => {
				el.getAnimations({ subtree: true }).forEach(animation => {
					animation.pause();
					animation.currentTime = time;
				});
				return [...el.querySelectorAll('circle')].map(circle => {
					const bounds = circle.getBoundingClientRect();
					return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
						transform: getComputedStyle(circle).transform };
				});
			}, time);
			for (const center of centers) {
				assert.ok(Math.abs(center.x - centers[0].x) < .01 && Math.abs(center.y - centers[0].y) < .01,
					`Completion circles must stay concentric at ${time}ms`);
				assert.equal(center.transform, 'none', 'Circles must share vector coordinates without separate layer scaling');
			}
		}
		await page.clock.runFor(1450);
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
		assert.equal(await indicator.locator('.crate-sync-indicator__halo').evaluate(el => getComputedStyle(el).animationName), 'none');
		await setState({});
		await expect(visual).toHaveAttribute('data-visual-state', 'synced');
		await page.evaluate(() => window.root.unmount());
		await page.clock.runFor(1600);
		// Exercise the real PWA palettes and the shared geometry without host resets.
		const states = ['synced', 'syncing', 'pending', 'offline', 'cached', 'error'];
		const fixtures = states.map(state => `<svg class="crate-sync-indicator" viewBox="0 0 16 16" data-visual-state="${state}"><circle class="crate-sync-indicator__halo" cx="8" cy="8" r="8"/><circle class="crate-sync-indicator__glow" cx="8" cy="8" r="7"/><circle class="crate-sync-indicator__dot" cx="8" cy="8" r="4"/><circle class="crate-sync-indicator__ripple" cx="8" cy="8" r="5.5"/></svg>`).join('');
		await page.setContent(`<style>${css}
			#root { display:flex; gap:24px; padding:24px; background:var(--background-primary-alt); --text-muted:inherit; --text-normal:inherit; }
		</style><div id="root">${fixtures}</div>`);
		await page.addStyleTag({ content: palettes[0] });
		const theme = await page.addStyleTag({ content: '/* theme */' });
		for (const light of [false, true]) {
			await theme.evaluate((el, content) => el.textContent = content, light ? palettes[1] : '');
			for (const state of states) {
				const fixture = page.locator(`[data-visual-state="${state}"]`);
				const dot = fixture.locator('.crate-sync-indicator__dot');
				const background = await dot.evaluate(el => getComputedStyle(el.parentElement.parentElement).backgroundColor);
				// Verify fixed sync colors across themes; other states follow the host palette.
				const foreground = await dot.evaluate(el => getComputedStyle(el).fill);
				if (state === 'synced' || state === 'syncing') {
					assert.equal(foreground, state === 'synced' ? 'rgb(34, 197, 94)' : 'rgb(245, 158, 11)');
				} else {
					const values = [luminance(foreground), luminance(background)].sort((a,b) => b-a);
					assert.ok((values[0]+.05)/(values[1]+.05) >= 3, `${state} must remain legible in ${light ? 'light' : 'dark'} mode`);
				}
				const frame = await fixture.boundingBox();
				const bounds = await dot.boundingBox();
				assert.ok(Math.abs(bounds.x+bounds.width/2-frame.x-frame.width/2) < .01);
				assert.ok(Math.abs(bounds.y+bounds.height/2-frame.y-frame.height/2) < .01);
			}
			await page.screenshot({path:`/tmp/crate-sync-states-${browserType.name()}-${light ? 'light' : 'dark'}.png`});
		}
		for (const state of states) {
			const dot = page.locator(`[data-visual-state="${state}"] .crate-sync-indicator__dot`);
			await expect(dot).toHaveCSS('r', '4px');
			await expect(dot).toHaveAttribute('cx', '8');
			await expect(dot).toHaveAttribute('cy', '8');
		}

		if (browserType === chromium) {
			await page.emulateMedia({ forcedColors: 'active' });
			for (const state of states) {
				const fixture = page.locator(`[data-visual-state="${state}"]`);
				const colors = await fixture.locator('.crate-sync-indicator__dot').evaluate(el => ({
					foreground: getComputedStyle(el).fill,
					background: getComputedStyle(document.body).backgroundColor,
				}));
				assert.notEqual(colors.foreground, colors.background, `${state} must remain visible in forced colors`);
				await expect(fixture.locator('.crate-sync-indicator__halo')).toBeHidden();
			}
		}
		console.log(`${browserType.name()}: sync motion, interruptions, reduced motion, fixed sync colors, host palette contrast, and state geometry passed`);
	} finally {
		await browser.close();
	}
}
