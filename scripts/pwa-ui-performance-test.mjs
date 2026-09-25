import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
	stdin: {
		resolveDir: process.cwd(), loader: 'tsx', contents: `
			import React, { useState } from 'react';
			import { createRoot } from 'react-dom/client';
			import { flushSync } from 'react-dom';
			import { RichTextInput } from './src/reminders/components/RichTextInput';
			import { useKeyboardHeight } from './src/reminders/ui/hooks/useKeyboardHeight';
			import { PwaPullRefreshIndicator } from './src/pwa/components/PwaChrome';
			export { getPlainText } from './src/reminders/utils/richTextPlainText';
			function Editor() {
				const [value, setValue] = useState('Task #Work !');
				return <><RichTextInput value={value} onChange={setValue} knownProjects={['Work']} ariaLabel="Test editor" autoFocus syncContentBeforePaint /><output id="value">{value}</output></>;
			}
			function Keyboard() {
				const inset = useKeyboardHeight();
				return <><input aria-label="Keyboard input" /><output id="inset">{inset}</output></>;
			}
			function Pull({ reading = false }) {
				const [refreshes, setRefreshes] = useState(0);
				return <div className={reading ? "crate-reading-web" : "pwa-reminders-view"}><div className="pwa-below-header-content"><PwaPullRefreshIndicator enabled scrollSelector={reading ? ".crate-reading-web .crate-reading__list-scroll" : undefined} onRefresh={async () => { setRefreshes(value => value + 1); }} /></div><div id="scroll" className={reading ? "crate-reading__list-scroll" : "ios-scroll"} style={{height: 250, overflow: 'auto'}}><div style={{height: 600}}>Reminders</div></div><output id="refreshes">{refreshes}</output></div>;
			}
			let root;
			export function mount(kind) {
				unmount();
				root = createRoot(document.getElementById('app'));
				flushSync(() => root.render(kind === 'editor' ? <Editor /> : kind === 'keyboard' ? <Keyboard /> : <Pull reading={kind === "reading-pull"} />));
			}
			export function unmount() { root?.unmount(); root = undefined; }
		`,
	},
	bundle: true, format: 'iife', globalName: 'uiTest', write: false,
	define: { 'process.env.NODE_ENV': '"production"' },
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
		await editor.press('ControlOrMeta+z');
		await expect(page.locator('#value')).not.toHaveText('New Task #Work !');
		await editor.press('ControlOrMeta+Shift+z');
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
		await editor.fill('Before composition');
		await editor.evaluate(element => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
			text.textContent = '日本語';
			document.getSelection().setBaseAndExtent(text, 3, text, 3);
			element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日本語', isComposing: true }));
		});
		await expect(page.locator('#value')).toHaveText('Before composition');
		await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' })));
		await expect(page.locator('#value')).toHaveText('日本語');

		for (const kind of ['pull', 'reading-pull']) {
			await page.evaluate(kind => window.uiTest.mount(kind), kind);
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
			for (const blocked of ['short', 'horizontal', 'scrolled', 'modal', 'inactive', 'other-feature']) {
				await page.evaluate(blocked => {
					const list = document.getElementById('scroll');
					const originalClass = list.className;
					if (blocked === 'scrolled') list.scrollTop = 50;
					if (blocked === 'modal') list.classList.add('pwa-modal-sheet');
					if (blocked === 'inactive') list.setAttribute('inert', '');
					if (blocked === 'other-feature') list.className = originalClass === 'ios-scroll' ? 'crate-reading__list-scroll' : 'ios-scroll';
					for (const [type, x, y] of [['touchstart', 30, 0], ['touchmove', blocked === 'horizontal' ? 400 : 30, blocked === 'short' ? 30 : 200], ['touchend', 30, 200]]) {
						const event = new Event(type, { bubbles: true, cancelable: true });
						Object.defineProperty(event, 'touches', { value: { length: 1, item: () => ({ clientX: x, clientY: y }) } });
						list.dispatchEvent(event);
					}
					list.scrollTop = 0; list.className = originalClass; list.removeAttribute('inert');
				}, blocked);
				await expect(page.locator('#refreshes')).toHaveText('1');
				await expect(page.locator('.pwa-pull-refresh')).not.toHaveClass(/is-visible/);
			}
		}


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
		console.log(`${browserType.name()}: typing, undo/redo, paste, composition, pull layout and viewport batching passed`);
	} finally {
		await browser.close();
	}
}
