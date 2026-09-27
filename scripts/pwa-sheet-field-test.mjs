import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { checkSaveLinkKeyboard } from './pwa-sheet-field-checks.mjs';
import { checkSheetDragPosition } from './pwa-sheet-drag-checks.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
			await page.route('**/reading/session', route => route.fulfill({ json: {
				id: 'sheet-focus-test', folderPath: 'Reading', generation: 'sheet-focus-generation', expiresAt: Date.now() + 86400000,
			} }));
			await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
			await page.goto(`http://127.0.0.1:${server.address().port}/notifications?section=reading`);
			await page.evaluate(() => {
				window.caretFrames = [];
				const sample = () => {
					const field = document.querySelector('input[data-initial-focus]');
					const popup = field?.closest('.pwa-modal-sheet__container');
					const surface = field?.closest('.pwa-sheet-surface');
					if (popup && surface) window.caretFrames.push({
						caret: getComputedStyle(field).caretColor,
						focused: document.activeElement === field,
						drawer: popup.hasAttribute('data-swiping') || popup.getAnimations().some(animation => animation.playState === 'running'),
						keyboard: surface.getAnimations().some(animation => animation.playState === 'running'),
					});
					window.caretFrame = requestAnimationFrame(sample);
				};
				sample();
				document.addEventListener('click', event => {
					if (event.target.closest('button[aria-label="Save a link"]')) {
						window.captureFocusedDuringClick = document.activeElement?.matches('input[data-initial-focus]');
					}
				});
			});
			await page.getByRole('button', { name: 'Save a link', exact: true }).tap();
			await expect.poll(() => page.evaluate(() => window.captureFocusedDuringClick)).toBe(true);
			await checkSaveLinkKeyboard(page);
			const popup = page.getByRole('dialog', { name: 'Save a link', exact: true });
			const field = page.getByLabel('Link', { exact: true });
			await expect(popup).toHaveCSS('transform', 'none');
			await checkSheetDragPosition(page, popup);
			await expect(field).toBeFocused();
			await expect(field).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
			// Retarget the keyboard before either displacement finishes. A cancelled
			// animation must not reveal the caret while its replacement is moving.
			const interrupted = await popup.evaluate(async element => {
				const original = window.visualViewport;
				const surface = element.querySelector('.pwa-sheet-surface');
				const input = element.querySelector('input');
				const viewport = new EventTarget();
				Object.defineProperties(viewport, {
					height: { value: window.innerHeight, writable: true }, width: { value: window.innerWidth },
					offsetTop: { value: 0 }, offsetLeft: { value: 0 }, scale: { value: 1 },
				});
				Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
				const samples = [];
				try {
					for (const inset of [300, 120, 260]) {
						viewport.height = window.innerHeight - inset;
						window.dispatchEvent(new Event('resize'));
						for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
						samples.push({ moving: surface.getAnimations().some(animation => animation.playState === 'running'),
							focused: document.activeElement === input, caret: getComputedStyle(input).caretColor });
					}
				} finally {
					Object.defineProperty(window, 'visualViewport', { configurable: true, value: original });
					window.dispatchEvent(new Event('resize'));
				}
				return samples;
			});
			for (const sample of interrupted) expect(sample).toEqual({ moving: true, focused: true, caret: 'rgba(0, 0, 0, 0)' });
			await expect(field).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
			await page.getByLabel('Link', { exact: true }).fill('https://example.com/keep-draft');
			await page.getByRole('button', { name: 'Close save a link', exact: true }).click();
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await page.getByRole('button', { name: 'Save a link', exact: true }).tap();
			await expect(page.getByLabel('Link', { exact: true })).toBeFocused();
			await expect(page.getByLabel('Link', { exact: true })).toHaveValue('https://example.com/keep-draft');
			await expect(popup).toHaveCSS('transform', 'none');
			await expect(field).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
			const frames = await page.evaluate(() => { cancelAnimationFrame(window.caretFrame); return window.caretFrames; });
			expect(frames.some(frame => frame.focused && frame.drawer)).toBe(true);
			expect(frames.some(frame => frame.focused && frame.keyboard)).toBe(true);
			for (const frame of frames.filter(frame => frame.focused && (frame.drawer || frame.keyboard))) {
				expect(frame.caret, JSON.stringify(frame)).toBe('rgba(0, 0, 0, 0)');
			}
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.getByRole('button', { name: 'Close save a link', exact: true }).click();
			await expect(popup).toHaveCount(0);
			await page.getByRole('button', { name: 'Save a link', exact: true }).tap();
			await expect(field).toBeFocused();
			await expect(field).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
			console.log(`${engine.name()}: sheet autofocus, caret motion, touch focus, keyboard geometry, drag interruption, reduced motion and draft preservation passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
