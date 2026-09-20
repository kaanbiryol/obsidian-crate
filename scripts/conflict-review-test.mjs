import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const { outputFiles } = await build({
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
        import { ConflictReviewModal } from './src/ui/activity/conflict-review-modal';
        HTMLElement.prototype.createEl = function(tag, options = {}) {
            const el = document.createElement(tag);
            el.className = options.cls ?? ''; el.textContent = options.text ?? '';
            for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
            this.append(el); return el;
        };
        HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
        HTMLElement.prototype.createSpan = function(options) { return this.createEl('span', options); };
        HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
        HTMLElement.prototype.toggleClass = function(name, value) { this.classList.toggle(name, value); };
        HTMLElement.prototype.toggle = function(value) { this.style.display = value ? '' : 'none'; };
        HTMLElement.prototype.setText = function(text) { this.textContent = text; };
        HTMLElement.prototype.empty = function() { this.replaceChildren(); };
        Object.defineProperty(HTMLElement.prototype, 'win', { get: () => window });
        window.current = 'Title\\nCurrent change'; window.saved = 'Title\\nSaved change';
        window.writes = []; window.opened = [];
        window.mount = () => {
            window.modal = new ConflictReviewModal({}, { originalPath: 'Note.md', conflictPath: 'Note.conflict.md' }, async () => ({
                currentText: window.current, savedText: window.saved, currentSize: 20, savedSize: 18,
                openVersion: async version => { window.opened.push(version); },
                resolve: async (choice, text) => { window.writes.push({ choice, text }); },
            }), () => {});
            window.modal.open();
        };
        window.mount();
    ` },
    plugins: [{ name: 'host-fixture', setup(builder) {
        builder.onResolve({ filter: /^(obsidian|\.\.\/shared\/SharedModal|\.\/file-actions)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'obsidian' ? `
            export const Platform = { isMobile: innerWidth < 600, isDesktopApp: true };
            export class Notice {}
            export function setIcon() {}
        ` : args.path === './file-actions' ? 'export const getPendingFileActions = () => [];' : `
            export class SharedModal {
                constructor() {
                    this.modalEl = document.createElement('div'); this.modalEl.className = 'modal crate-shared-modal';
                    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content crate-reminders-ui' });
                }
                openLayout() { this.bodyEl = this.contentEl.createDiv({ cls: 'crate-modal-body' }); }
                open() { document.body.append(this.modalEl); this.onOpen(); }
                close() { this.onClose(); this.modalEl.remove(); }
                onClose() { this.contentEl.empty(); }
            }
        ` }));
    } }], bundle: true, write: false, format: 'iife', platform: 'browser',
});
const css = compileString("@use 'src/styles/plugin/activity';", { loadPaths: [process.cwd()] }).css;
await mkdir('.generated/conflict-review', { recursive: true });
for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.setContent(`<style>
                :root { --background-primary: white; --text-normal: #222; --text-muted: #666; --text-faint: #888; --font-ui-small: 13px; --font-ui-smaller: 12px; --font-monospace: monospace; }
                * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; } .modal { margin: auto; } textarea { color: inherit; background: inherit; }
            </style>`);
            await page.addStyleTag({ content: css });
            await page.addScriptTag({ content: outputFiles[0].text });
            const custom = page.getByRole('radio', { name: 'Custom result', exact: true });
            const result = page.getByRole('textbox', { name: 'Result text' });
            const resolve = page.getByRole('button', { name: 'Resolve conflict' });
            await expect(resolve).toBeDisabled();
            const initialBounds = await page.locator('.modal').boundingBox();
            await custom.check();
            const editingBounds = await page.locator('.modal').boundingBox();
            assert.equal(editingBounds.width, initialBounds.width);
            assert.equal(editingBounds.height, initialBounds.height);
            await expect(result).toHaveValue('Title\nCurrent change');
            await expect(result).toBeFocused();
            await result.fill('Title\nCurrent change\nSaved change');
            assert.deepEqual(await page.evaluate(() => window.writes), []);
            assert.deepEqual(await page.evaluate(() => window.opened), []);
            await page.getByRole('radio', { name: 'Keep current', exact: true }).check();
            await expect(result).toBeHidden();
            await custom.check();
            await expect(result).toHaveValue('Title\nCurrent change\nSaved change');
            await page.getByRole('button', { name: 'Current file', exact: true }).click();
            await page.evaluate(() => { window.current = 'New current text'; window.dispatchEvent(new Event('focus')); });
            await expect(page.getByRole('status')).toContainText('Versions refreshed');
            await expect(custom).toBeChecked();
            await expect(result).toHaveValue('Title\nCurrent change\nSaved change');
            await expect(page.locator('.crate-conflict-code').first()).toContainText('New current text');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const source = await page.locator('.crate-conflict-compare').boundingBox();
            const draft = await page.locator('.crate-conflict-manual').boundingBox();
            assert.ok(draft.y >= source.y + source.height - 1);
            await result.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `.generated/conflict-review/${browserType.name()}-${width}.png` });
            await resolve.click();
            assert.deepEqual(await page.evaluate(() => window.writes), [{ choice: 'manual', text: 'Title\nCurrent change\nSaved change' }]);
            await page.evaluate(() => window.mount());
            await custom.check();
            await result.fill('Discard this draft');
            await page.evaluate(() => window.modal.close());
            assert.equal(await page.evaluate(() => window.writes.length), 1);
            assert.deepEqual(errors, []);
            await page.close();
        }
        console.log(`${browserType.name()}: conflict draft isolation, refresh, resolution and cancellation passed`);
    } finally { await browser.close(); }
}
