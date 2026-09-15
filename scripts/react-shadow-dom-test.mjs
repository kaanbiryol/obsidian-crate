import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

// Exercise the shared controls inside a real ShadowRoot, as in Obsidian.
const { outputFiles } = await build({
	stdin: {
		resolveDir: process.cwd(), loader: 'tsx', contents: `
			import React, { useState } from 'react';
			import { createRoot } from 'react-dom/client';
			import { createPortal, flushSync } from 'react-dom';
			import { Button } from './src/ui/shared/Button';
			import { ShadowDOMNativeMotionButton } from './src/reminders/components/ShadowDOMNativeMotionButton';
			import { RichTextInput } from './src/reminders/components/RichTextInput';
			const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
			const mountPoint = document.createElement('div');
			const portalPoint = document.createElement('div');
			shadow.append(mountPoint, portalPoint);
			function Harness() {
				const [title, setTitle] = useState('Original title');
				const [saved, setSaved] = useState(0);
				const [motionClicks, setMotionClicks] = useState(0);
				const [project, setProject] = useState('Inbox');
				const [picker, setPicker] = useState(false);
				return <>
					<RichTextInput value={title} onChange={setTitle} ariaLabel="Reminder title" autoFocus syncContentBeforePaint />
					<output id="title">{title}</output>
					<Button preventFocusOnPress onClick={() => setSaved(saved + 1)}>Save</Button>
					<output id="saved">{saved}</output>
					<ShadowDOMNativeMotionButton onClick={() => setMotionClicks(motionClicks + 1)}>Motion action</ShadowDOMNativeMotionButton>
					<output id="motion-clicks">{motionClicks}</output>
					<input aria-label="Project" value={project} onChange={event => setProject(event.target.value)} />
					<output id="project">{project}</output>
					<Button onClick={() => setPicker(true)}>Open picker</Button>
					{picker && createPortal(<div role="dialog" aria-label="Picker">
						<Button onClick={() => setPicker(false)}>Close picker</Button>
					</div>, portalPoint)}
				</>;
			}
			let root;
			window.mount = () => {
				root = createRoot(mountPoint);
				flushSync(() => root.render(<Harness />));
			};
			window.unmount = () => root.unmount();
		`,
	},
	bundle: true, write: false, format: 'iife', platform: 'browser',
	define: { 'process.env.NODE_ENV': '"production"' },
});

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.setContent('<div id="host"></div>');
		await page.addScriptTag({ content: outputFiles[0].text });
		for (let mount = 0; mount < 2; mount++) {
			await page.evaluate(() => window.mount());
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			await expect(title).toBeFocused();
			await title.click();
			await title.press('ControlOrMeta+A');
			await title.pressSequentially('Edited in the shadow root');
			await expect(page.locator('#title')).toHaveText('Edited in the shadow root');
			await title.press('ArrowLeft');
			await title.pressSequentially('X');
			await expect(page.locator('#title')).toHaveText('Edited in the shadow rooXt');
			await title.press('ControlOrMeta+z');
			await expect(page.locator('#title')).toHaveText('Edited in the shadow root');
			await title.press('ControlOrMeta+A');
			await title.evaluate(element => {
				const data = new DataTransfer();
				data.setData('text/plain', 'Pasted title\nSecond line');
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
			});
			await expect(page.locator('#title')).toHaveText('Pasted title\nSecond line');
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.locator('#saved')).toHaveText('1');
			await expect(title).toBeFocused();
			await page.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(page.locator('#saved')).toHaveText('2');
			const motion = page.getByRole('button', { name: 'Motion action', exact: true });
			await motion.tap();
			await expect(page.locator('#motion-clicks')).toHaveText('1');
			await motion.focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('#motion-clicks')).toHaveText('2');
			await page.getByRole('textbox', { name: 'Project', exact: true }).fill('Work');
			await expect(page.locator('#project')).toHaveText('Work');
			await page.getByRole('button', { name: 'Open picker', exact: true }).tap();
			await expect(page.getByRole('dialog', { name: 'Picker' })).toBeVisible();
			await page.getByRole('button', { name: 'Close picker', exact: true }).tap();
			await expect(page.getByRole('dialog', { name: 'Picker' })).toHaveCount(0);
			await page.getByRole('button', { name: 'Open picker', exact: true }).tap();
			await expect(page.getByRole('dialog', { name: 'Picker' })).toBeVisible();
			await page.evaluate(() => window.unmount());
			await expect(page.getByRole('dialog', { name: 'Picker' })).toHaveCount(0);
			await expect(title).toHaveCount(0);
		}
		assert.deepEqual(errors, [], 'Shadow DOM controls must not throw browser errors');
		console.log(`${browserType.name()}: React shadow-root editing, focus, single activation, portals, and remount passed`);
	} finally {
		await browser.close();
	}
}
