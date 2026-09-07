import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
	stdin: {
		resolveDir: process.cwd(), loader: 'tsx', contents: `
			import React, { useState } from 'react';
			import { render } from 'preact';
			import { RichTextInput } from './src/reminders/components/RichTextInput';
			import { useKeyboardHeight } from './src/reminders/ui/hooks/useKeyboardHeight';
			import { PwaPullRefreshIndicator } from './src/pwa/components/PwaChrome';
			export { renderRichText } from './src/reminders/components/richTextInputDom';
			export { getPlainText } from './src/reminders/utils/richTextPlainText';
			function Editor() {
				const [value, setValue] = useState('Task #Work !');
				return <><RichTextInput value={value} onChange={setValue} knownProjects={['Work']} ariaLabel="Test editor" autoFocus syncContentBeforePaint /><output id="value">{value}</output></>;
			}
			function Keyboard() {
				const inset = useKeyboardHeight();
				return <><input aria-label="Keyboard input" /><output id="inset">{inset}</output></>;
			}
			function Pull() {
				const [refreshes, setRefreshes] = useState(0);
				return <div className="pwa-reminders-view"><div className="pwa-below-header-content"><PwaPullRefreshIndicator enabled onRefresh={async () => { setRefreshes(value => value + 1); }} /></div><div id="scroll" className="ios-scroll" style={{height: 250, overflow: 'auto'}}><div style={{height: 600}}>Reminders</div></div><output id="refreshes">{refreshes}</output></div>;
			}
			export function mount(kind) { const root = document.getElementById('app'); render(null, root); render(kind === 'editor' ? <Editor /> : kind === 'keyboard' ? <Keyboard /> : <Pull />, root); }
			export function unmount() { render(null, document.getElementById('app')); }
		`,
	},
	bundle: true, format: 'iife', globalName: 'uiTest', write: false,
	define: { 'process.env.NODE_ENV': '"production"' },
	alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
});
const css = await readFile('src/cloudflare/worker/pwa/styles/reminders-view.css', 'utf8');

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
		await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }));
		await page.goto('http://pwa-ui.test');
		await page.addScriptTag({ content: outputFiles[0].text });
		await page.addStyleTag({ content: css });
		const reuse = await page.evaluate(() => {
			const element = document.createElement('div');
			document.body.append(element);
			window.uiTest.renderRichText(element, 'Task #Work !', ['Work']);
			const first = element.firstChild;
			const chip = element.querySelector('.rich-text-chip-project');
			const priority = element.lastChild;
			chip.classList.add('is-cursor-active');
			window.uiTest.renderRichText(element, 'Updated task #Work !', ['Work']);
			const retained = first === element.firstChild && chip === element.querySelector('.rich-text-chip-project') && priority === element.lastChild;
			const active = chip.classList.contains('is-cursor-active');
			window.uiTest.renderRichText(element, 'Updated task [link](https://example.com) #Work !', ['Work']);
			const inserted = chip === element.querySelector('.rich-text-chip-project') && priority === element.lastChild;
			window.uiTest.renderRichText(element, 'Updated task #Work !', ['Work']);
			const removed = !element.querySelector('a') && chip === element.querySelector('.rich-text-chip-project');
			window.uiTest.renderRichText(element, '<img src=x onerror=alert(1)> #Work', ['Work']);
			const safe = !element.querySelector('img') && element.textContent.includes('<img');
			window.uiTest.renderRichText(element, '');
			const empty = element.childNodes.length === 0;
			element.remove();
			return { retained, active, inserted, removed, safe, empty };
		});
		assert.ok(Object.values(reuse).every(Boolean), JSON.stringify(reuse));

		await page.evaluate(() => window.uiTest.mount('editor'));
		const editor = page.getByRole('textbox', { name: 'Test editor' });
		await expect(editor).toBeFocused();
		await editor.evaluate(element => {
			const range = document.createRange();
			range.setStart(element.firstChild, 0);
			range.collapse(true);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
		await editor.pressSequentially('New ');
		await expect(page.locator('#value')).toHaveText('New Task #Work !');
		await editor.press('Control+z');
		await expect(page.locator('#value')).toHaveText('NewTask #Work !');
		await editor.press('Control+Shift+z');
		await expect(page.locator('#value')).toHaveText('New Task #Work !');
		await editor.evaluate(element => {
			const range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
		await editor.evaluate(element => {
			const data = new DataTransfer();
			data.setData('text/plain', '\nPasted text');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
		});
		await expect(page.locator('#value')).toContainText('Pasted text');
		await editor.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.textContent = '日本語';
			element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日本語', isComposing: true }));
		});
		await expect(page.locator('#value')).toContainText('Pasted text');
		await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' })));
		await expect(page.locator('#value')).toHaveText('日本語');

		await page.evaluate(() => window.uiTest.mount('pull'));
		// Allow passive effects to attach gesture listeners before sending touches.
		await page.waitForTimeout(150);
		const before = await page.locator('#scroll').boundingBox();
		await page.evaluate(() => {
			const target = document.getElementById('scroll');
			// Desktop WebKit does not expose a constructible Touch.
			const dispatch = (type, y) => {
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperty(event, 'touches', { value: { length: 1, item: () => ({ clientY: y, clientX: 20 }) } });
				target.dispatchEvent(event);
			};
			dispatch('touchstart', 0);
			dispatch('touchmove', 200);
		});
		await expect(page.locator('.pwa-pull-refresh')).toHaveClass(/is-ready/);
		const pulled = await page.locator('#scroll').boundingBox();
		const indicator = await page.locator('.pwa-pull-refresh').boundingBox();
		assert.equal(pulled.width, before.width, 'pull must retain list width');
		assert.equal(pulled.height, before.height, 'pull must retain list height');
		assert.ok(Math.abs(pulled.y - before.y - indicator.height) < 1, 'pull should reveal the indicator above the list');
		await page.evaluate(() => document.getElementById('scroll').dispatchEvent(new Event('touchend', { bubbles: true })));
		await expect(page.locator('#refreshes')).toHaveText('1');
		await expect(page.locator('.pwa-pull-refresh')).not.toHaveClass(/is-visible/);
		await expect.poll(async () => (await page.locator('#scroll').boundingBox()).y).toBe(before.y);

		await page.evaluate(() => {
			window.viewportReads = 0;
			window.keyboardViewportHeight = 500;
			const viewport = new EventTarget();
			Object.defineProperties(viewport, {
				height: { get: () => { window.viewportReads++; return window.keyboardViewportHeight; } },
				offsetTop: { value: 0 },
			});
			Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
			window.uiTest.mount('keyboard');
		});
		await page.waitForTimeout(150);
		await page.getByRole('textbox', { name: 'Keyboard input' }).focus();
		await expect(page.locator('#inset')).toHaveText('344');
		await page.getByRole('textbox', { name: 'Keyboard input' }).evaluate(element => element.blur());
		await page.waitForTimeout(50);
		await expect(page.locator('#inset')).toHaveText('344');
		for (const height of [620, 740, 844]) {
			await page.evaluate(height => {
				window.keyboardViewportHeight = height;
				window.visualViewport.dispatchEvent(new Event('resize'));
			}, height);
			await expect(page.locator('#inset')).toHaveText(String(844 - height));
		}
		// Once the keyboard closes, browser chrome changes must not reopen the gap.
		await page.evaluate(() => {
			window.keyboardViewportHeight = 800;
			window.visualViewport.dispatchEvent(new Event('resize'));
		});
		await page.waitForTimeout(50);
		await expect(page.locator('#inset')).toHaveText('0');
		await page.evaluate(() => { window.keyboardViewportHeight = 500; });
		await page.getByRole('textbox', { name: 'Keyboard input' }).focus();
		await expect(page.locator('#inset')).toHaveText('344');
		const batching = await page.evaluate(() => {
			const raf = window.requestAnimationFrame;
			const cancel = window.cancelAnimationFrame;
			const queued = new Map();
			let next = 0;
			window.requestAnimationFrame = callback => { queued.set(++next, callback); return next; };
			window.cancelAnimationFrame = id => queued.delete(id);
			window.viewportReads = 0;
			for (let index = 0; index < 20; index++) {
				window.dispatchEvent(new Event('resize'));
				window.visualViewport.dispatchEvent(new Event('resize'));
				window.visualViewport.dispatchEvent(new Event('scroll'));
			}
			const frames = queued.size;
			const immediateReads = window.viewportReads;
			for (const callback of [...queued.values()]) callback(0);
			queued.clear();
			const reads = window.viewportReads;
			window.dispatchEvent(new Event('resize'));
			window.uiTest.unmount();
			const cancelled = queued.size === 0;
			window.requestAnimationFrame = raf;
			window.cancelAnimationFrame = cancel;
			return { frames, immediateReads, reads, cancelled };
		});
		assert.equal(batching.frames, 1);
		assert.equal(batching.immediateReads, 0);
		assert.ok(batching.reads > 0 && batching.reads < 5);
		assert.ok(batching.cancelled);
		console.log(`${browserType.name()}: node reuse, typing, undo/redo, paste, composition, pull layout and viewport batching passed`);
	} finally {
		await browser.close();
	}
}
