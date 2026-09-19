import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

// Exercise the production renderer with Obsidian's small DOM helper surface.
const { outputFiles } = await build({
    stdin: {
        resolveDir: process.cwd(), loader: 'ts', contents: `
            import { renderPendingPanel } from './src/ui/activity/panels';
            import { PendingDiscardModal } from './src/ui/activity/pending-discard-modal';
            HTMLElement.prototype.createEl = function(tag, options = {}) {
                const el = document.createElement(tag);
                if (options.cls) el.className = options.cls;
                if (options.text) el.textContent = options.text;
                for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
                this.append(el); return el;
            };
            HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
            HTMLElement.prototype.createSpan = function(options) { return this.createEl('span', options); };
            HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
            HTMLElement.prototype.setText = function(text) { this.textContent = text; };
            HTMLElement.prototype.empty = function() { this.replaceChildren(); };
            HTMLElement.prototype.toggleClass = function(name, active) { this.classList.toggle(name, active); };
            window.calls = 0;
            window.syncKeys = []; window.discardKeys = []; window.discarded = 0;
            window.syncFailure = false;
            const actions = {
                fileActions: path => [
                    { title: 'Open in Obsidian', icon: 'file', run: async () => { window.openedPath = path; } },
                    { title: 'Reveal in Finder', icon: 'folder-open', run: async () => { window.revealedPath = path; } },
                ],
                syncSelected: async keys => { if (window.syncFailure) throw new Error('Sync unavailable'); window.syncKeys = keys; },
                discard: keys => {
                    window.discardKeys = keys;
                    new PendingDiscardModal({}, async () => ({
                        items: keys.filter(key => window.allChanged || key.endsWith('appearance.json') || key.startsWith('delete:')).map(key => ({ path: key.replace(/^delete:/, ''), action: 'restore' })),
                        unchangedCount: keys.filter(key => !window.allChanged && !key.endsWith('appearance.json') && !key.startsWith('delete:')).length, discard: async () => { window.discarded++; },
                    }), () => {}).open();
                },
            };
            window.fail = false;
            window.delayed = false;
            const state = {};
            window.paths = ['.obsidian/appearance.json', '.obsidian/core-plugins.json', '.obsidian/types.json', '.obsidian/community-plugins.json', '.obsidian/plugins/omnisearch/data.json', 'delete:Notes/Archive.md'];
            const before = JSON.stringify({
                theme: 'system', accentColor: '#7c3aed', baseFontSize: 16,
                cssTheme: '', enabledCssSnippets: [], showViewHeader: true,
                nativeMenus: false, showRibbon: true, translucency: false,
                noteFont: '', monospaceFont: '', interfaceFont: '',
            }, null, 2);
            const after = JSON.stringify({ ...JSON.parse(before), theme: 'dark', baseFontSize: 17 }, null, 2);
            window.mount = () => {
                state.dispose?.();
                const panel = document.querySelector('.crate-activity-panel');
                panel.replaceChildren();
                renderPendingPanel(panel, window.paths, false, false, null, '', undefined,
                    async (path, deleted) => {
                        window.calls++;
                        if (window.delayed) { window.delayed = false; await new Promise(resolve => { window.release = resolve; }); }
                        if (window.fail) throw new Error('Could not reach the sync server.');
                        return { before, after: deleted ? '' : window.allChanged || path.endsWith('appearance.json') ? after : before, beforeSize: before.length, afterSize: deleted ? 0 : after.length, kind: deleted ? 'deleted' : 'modified' };
                    }, state, actions);
            };
            window.mount();
        `,
    },
    plugins: [{ name: 'obsidian-fixture', setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
            export class Menu {
                constructor() { this.el = document.createElement('div'); this.el.setAttribute('role', 'menu'); }
                addItem(build) {
                    const button = this.el.createEl('button', { attr: { role: 'menuitem' } });
                    const item = { setTitle: title => { button.textContent = title; return item; }, setIcon: () => item, setDisabled: disabled => { button.disabled = disabled; return item; },
                        onClick: action => { button.onclick = () => { this.el.remove(); action(); }; return item; } };
                    build(item); return this;
                }
                addSeparator() { return this; }
                showAtPosition() { this.showAtMouseEvent(); }
                showAtMouseEvent() { this.el.className = 'fixture-menu'; document.body.append(this.el); }
            }
            export class Modal {
                constructor() { this.modalEl = document.createElement('div'); this.modalEl.className = 'fixture-modal'; this.contentEl = this.modalEl.createDiv(); }
                setTitle() {}
                open() { document.body.append(this.modalEl); this.onOpen(); }
                close() { this.onClose(); this.modalEl.remove(); }
            }
            export class Notice { constructor(message) { window.notice = message; } }
            export function setIcon(el, name) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6');
                svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
                const path = document.createElementNS(svg.namespaceURI, 'path');
                const icons = {
                    'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6',
                    'arrow-left': 'm12 19-7-7 7-7M5 12h14',
                    'refresh-cw': 'M3 12a9 9 0 0 1 15-6l3 3M21 3v6h-6M21 12a9 9 0 0 1-15 6l-3-3M3 21v-6h6',
                    'ellipsis': 'M5 12h.01M12 12h.01M19 12h.01',
                    'trash-2': 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15',
                };
                path.setAttribute('d', icons[name] ?? icons['file-text']);
                svg.append(path); el.append(svg);
            }
        ` }));
    } }],
    bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.scss': 'empty' },
});
const css = compileString(`@use 'src/styles/plugin/activity'; @use 'src/styles/plugin/pending-diff'; @use 'src/styles/plugin/pending-browser';`, { loadPaths: [process.cwd()] }).css;
await mkdir('.generated/activity-diff', { recursive: true });

for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
        for (const width of [900, 390]) {
            for (const theme of ['light', 'dark']) {
                const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.setContent(`<!doctype html><html data-theme="${theme}"><style>
                    :root {
                        --background-primary: #fff; --background-secondary: #fafafa;
                        --background-modifier-border: #e9e9eb; --background-modifier-hover: rgba(25, 25, 35, 0.05);
                        --text-normal: #25252a; --text-muted: #77777e; --text-faint: #929299;
                        --text-success: #328158; --text-error: #c24b52; --interactive-accent: #5e5e68;
                        --font-interface: -apple-system, BlinkMacSystemFont, sans-serif;
                        --font-monospace: ui-monospace, SFMono-Regular, monospace;
                        --font-ui-small: 13px; --font-ui-smaller: 12px; --font-medium: 500; --font-semibold: 600;
                    }
                    [data-theme="dark"] {
                        --background-primary: #1c1c1f; --background-secondary: #202024;
                        --background-modifier-border: #303036; --background-modifier-hover: rgba(220, 220, 240, 0.06);
                        --text-normal: #e3e3e8; --text-muted: #9898a1; --text-faint: #73737e;
                        --text-success: #79b893; --text-error: #d78389; --interactive-accent: #c1c1ce;
                    }
                    * { box-sizing: border-box; }
                    body { margin: 0; padding: 40px 12px; background: var(--background-secondary); font-family: var(--font-interface); }
                    button { font: inherit; }
                    .mod-cta { background: var(--text-normal); color: var(--background-primary); border: 0; border-radius: 6px; }
                    .fixture-menu, .fixture-modal { position: fixed; z-index: 5; inset: 80px 20px auto; padding: 20px; color: var(--text-normal); background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 12px; box-shadow: 0 8px 40px #0003; }
                    .fixture-modal { max-width: 480px; margin: auto; }
                    .fixture-modal .reminder-modal-header { display: flex; justify-content: space-between; }
                    .fixture-modal .reminder-modal-header svg { width: 16px; height: 16px; }
                    .fixture-modal .reminder-modal-title { margin: 0; font-size: 18px; }
                    .fixture-modal p { font-size: 13px; line-height: 1.5; }
                    input[type=checkbox] { width: 14px; height: 14px; accent-color: var(--text-muted); }
                    .mod-warning { border: 0; border-radius: 5px; background: var(--text-error); color: white; padding: 6px 12px; }
                    .crate-activity-modal { height: 660px; max-width: 940px; margin: auto; overflow: hidden; border: 1px solid var(--background-modifier-border); border-radius: 14px; background: var(--background-primary); }
                    .fixture-header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; color: var(--text-normal); font-size: 14px; font-weight: 500; }
                    .fixture-header .crate-activity-subtitle { margin-left: auto; }
                    .fixture-close { color: var(--text-faint); font-size: 22px; font-weight: 400; }
                    .fixture-tab { padding: 8px 12px; color: var(--text-muted); font-size: 12px; }
                    .fixture-tab:first-child { border-bottom: 1px solid var(--text-normal); color: var(--text-normal); font-weight: 500; }
                    @media(max-width: 440px) { body { padding: 12px 6px; } .fixture-header { padding: 12px 16px; } }
                </style><div class="crate-activity-modal">
                    <div class="fixture-header"><span class="fixture-close">×</span>Sync activity<span class="crate-activity-subtitle">Synced 1h ago</span></div>
                    <div class="crate-activity-tab-bar"><span class="fixture-tab">Pending (6)</span><span class="fixture-tab">Conflicts</span><span class="fixture-tab">History</span></div>
                    <div class="crate-activity-panel"></div>
                </div></html>`);
                await page.addStyleTag({ content: css });
                await page.addScriptTag({ content: outputFiles[0].text });
                const rows = page.locator('.crate-browser-file');
                const first = rows.first();
                const preview = page.locator('.crate-file-diff');
                const back = page.getByRole('button', { name: 'Back to files' });
                await expect(page.getByRole('button', { name: 'Refresh file comparison' })).toHaveCount(0);
                const isMobile = width === 390;
                const showFiles = async () => { if (isMobile) await back.click(); };
                await expect(rows.nth(1).getByText('Unchanged', { exact: true })).toBeVisible();
                await expect(rows.nth(4).getByText('Unchanged', { exact: true })).toBeVisible();
                await expect(first.locator('.crate-browser-file-status')).toHaveText('+2 −2');
                await expect(rows.last().getByText('Deleted', { exact: true })).toBeVisible();
                assert.equal(await page.evaluate(() => window.calls), 6, 'All file statuses are checked without selecting them');
                await expect(page.locator('.crate-browser-file[aria-pressed="true"]')).toHaveCount(0);
                const all = page.getByRole('checkbox', { name: 'Select all files for sync', exact: true });
                const checks = page.locator('.crate-browser-file-check input');
                const syncSelected = page.locator('.crate-browser-sync');
                await expect(syncSelected).toBeHidden();
                await expect(page.locator('.crate-browser-actions button')).toHaveCount(1);
                await expect(page.getByRole('button', { name: 'File actions', exact: true })).toHaveCount(0);
                await expect(all).toBeChecked();
                // A translucent hover must be painted once across the complete row.
                await first.hover();
                const rowBackground = await first.evaluate(el => getComputedStyle(el.parentElement).backgroundColor);
                assert.notEqual(rowBackground, 'rgba(0, 0, 0, 0)');
                assert.equal(await first.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
                await checks.first().hover();
                assert.equal(await first.evaluate(el => getComputedStyle(el.parentElement).backgroundColor), rowBackground);

                await checks.nth(1).uncheck();
                await expect(page.getByRole('button', { name: 'Sync selected' })).toBeEnabled();
                await expect(page.locator('.crate-browser-file[aria-pressed="true"]')).toHaveCount(0);
                await page.getByRole('button', { name: 'Sync selected' }).click();
                assert.deepEqual(await page.evaluate(() => window.syncKeys), [
                    '.obsidian/appearance.json', '.obsidian/types.json', '.obsidian/community-plugins.json', '.obsidian/plugins/omnisearch/data.json', 'delete:Notes/Archive.md',
                ]);
                await page.evaluate(() => window.mount());
                await expect(checks.nth(1)).not.toBeChecked();
                await all.check();
                await expect(syncSelected).toBeHidden();
                await all.uncheck();
                await expect(page.locator('.crate-browser-sync')).toBeHidden();
                const highlighted = page.locator('.crate-browser-file[aria-pressed="true"]');
                for (const shortcut of ['Control+a', 'Meta+a']) {
                    await first.focus();
                    await page.keyboard.press(shortcut);
                    await expect(all).not.toBeChecked();
                    await expect(page.locator('.crate-browser-file-check input:checked')).toHaveCount(0);
                    await expect(highlighted).toHaveCount(6);
                    await expect(page.locator('.crate-browser-sync')).toBeHidden();
                }
                await checks.nth(1).check();
                await expect(highlighted).toHaveCount(6);
                await rows.nth(1).click({ button: 'right' });
                await expect(page.getByRole('menuitem', { name: 'Discard 6 items…', exact: true })).toBeVisible();
                await expect(page.getByRole('menuitem', { name: 'Select all', exact: true })).toHaveCount(0);
                await expect(all).not.toBeChecked();
                await expect(highlighted).toHaveCount(6);
                await page.getByRole('menuitem', { name: 'Discard 6 items…', exact: true }).click();
                await expect(page.getByRole('button', { name: 'Discard changes (2)' })).toBeEnabled();
                await expect(page.getByText('4 unchanged files will be kept.', { exact: true })).toBeVisible();
                assert.equal((await page.evaluate(() => window.discardKeys)).length, 6);
                assert.equal(await page.evaluate(() => window.discarded), 0, 'No discard before confirmation');
                await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                assert.equal(await page.evaluate(() => window.discarded), 0, 'Cancel leaves files untouched');
                await all.check();
                await expect(syncSelected).toBeHidden();
                await checks.nth(1).uncheck();
                await page.evaluate(() => { window.syncFailure = true; });
                await syncSelected.click();
                await expect(page.getByText('Sync unavailable', { exact: true })).toBeVisible();
                await page.evaluate(() => { window.syncFailure = false; });
                await syncSelected.click();
                await all.check();
                await expect(syncSelected).toBeHidden();
                // Remounting intentionally rechecks statuses; reset the call baseline.
                await expect(rows.last().getByText('Deleted', { exact: true })).toBeVisible();
                const checkedCalls = await page.evaluate(() => window.calls);
                await first.focus();
                await page.keyboard.press('Space');
                await expect(checks.first()).not.toBeChecked();
                await expect(page.getByRole('button', { name: 'Sync selected' })).toBeEnabled();
                await expect(first).toBeFocused();
                await expect(highlighted).toHaveCount(6);
                await page.keyboard.down('Space');
                await page.keyboard.down('Space'); // Holding Space must not toggle repeatedly.
                await page.keyboard.up('Space');
                await expect(checks.first()).toBeChecked();
                await expect(first).toBeFocused();
                await page.keyboard.press('Enter');
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                await expect(first).toHaveAttribute('aria-pressed', 'true');
                await showFiles();
                await checks.first().uncheck();
                await first.click({ button: 'right' });
                await page.getByRole('menuitem', { name: 'Discard 1 item…', exact: true }).click();
                await expect(page.getByRole('button', { name: 'Discard changes (1)' })).toBeEnabled();
                assert.deepEqual(await page.evaluate(() => window.discardKeys), ['.obsidian/appearance.json']);
                await page.getByRole('button', { name: 'Discard changes (1)' }).click();
                await expect(page.locator('.fixture-modal')).toHaveCount(0);
                assert.equal(await page.evaluate(() => window.discarded), 1);
                await checks.first().check();
                await first.click({ button: 'right' });
                await page.getByRole('menuitem', { name: 'Open in Obsidian', exact: true }).click();
                assert.equal(await page.evaluate(() => window.openedPath), '.obsidian/appearance.json');
                await first.click({ button: 'right' });
                await page.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).click();
                assert.equal(await page.evaluate(() => window.revealedPath), '.obsidian/appearance.json');
                await first.click();

                if (isMobile) {
                    await back.focus();
                    await expect(page.getByRole('navigation', { name: 'Pending files' })).toBeHidden();
                    await expect(back).toBeFocused();
                } else {
                    await expect(first).toBeVisible();
                    const listBounds = await page.locator('.crate-browser-sidebar').boundingBox();
                    const detailBounds = await page.locator('.crate-browser-detail').boundingBox();
                    assert.ok(detailBounds.x >= listBounds.x + listBounds.width - 1, 'Diff is to the right of the file list');
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                await preview.getByRole('button', { name: /Show .* unchanged lines/ }).click();
                await expect(preview.locator('.crate-diff-text').filter({ hasText: 'interfaceFont' })).toBeVisible();
                await expect(page.getByRole('button', { name: /Show raw diff|Format JSON/ })).toHaveCount(0);
                assert.equal(await page.evaluate(() => window.calls), checkedCalls, 'Selection reuses the checked snapshot');
                await page.evaluate(() => { window.fail = true; });
                await page.evaluate(() => window.mount());
                await expect(preview.getByText('Could not reach the sync server.')).toBeVisible();
                await page.evaluate(() => { window.fail = false; });
                await preview.getByRole('button', { name: 'Try again' }).click();
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                await showFiles();
                await rows.nth(1).click();
                await expect(preview.getByText('Unchanged', { exact: true })).toBeVisible();
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveCount(0);
                await expect(rows).toHaveCount(6);
                await showFiles();
                await expect(rows.nth(1).getByText('Unchanged', { exact: true })).toBeVisible();
                if (isMobile) await expect(rows.nth(1)).toBeFocused();
                if (browserType === chromium && isMobile) {
                    await rows.nth(1).evaluate(el => el.blur());
                    await page.screenshot({ path: `.generated/activity-diff/${theme}-${width}-files.png` });
                }
                await first.click();
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                if (browserType === chromium) {
                    await page.evaluate(() => document.activeElement?.blur());
                    await page.screenshot({ path: `.generated/activity-diff/${theme}-${width}.png` });
                }
                if (!isMobile) {
                    await first.focus();
                    await page.keyboard.press('ArrowDown');
                    await expect(rows.nth(1)).toBeFocused();
                    await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true');
                    await page.keyboard.press('Space');
                    await expect(checks.nth(1)).not.toBeChecked();
                    await expect(rows.nth(1)).toBeFocused();
                    assert.equal(await rows.nth(1).evaluate(el => getComputedStyle(el).outlineStyle), 'none');
                    assert.equal(await rows.nth(1).evaluate(el => getComputedStyle(el.parentElement).outlineStyle), 'solid');
                    if (browserType === chromium) await page.screenshot({ path: `.generated/activity-diff/${theme}-${width}-keyboard.png` });
                    await page.keyboard.press('Space');
                    await expect(checks.nth(1)).toBeChecked();
                    await expect(preview.getByText('Unchanged', { exact: true })).toBeVisible();
                    await page.keyboard.press('Home');
                    await expect(first).toBeFocused();
                    await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                }
                if (!isMobile) {
                    // Row selection never changes sync inclusion, including unchecked discard targets.
                    await first.click();
                    await rows.nth(2).click({ modifiers: ['Shift'] });
                    await expect(highlighted).toHaveCount(3);
                    await rows.last().click({ modifiers: ['Meta'] });
                    await expect(highlighted).toHaveCount(4);
                    await rows.nth(1).click({ modifiers: ['Meta'] });
                    await expect(highlighted).toHaveCount(3);
                    await checks.first().uncheck();
                    await first.click({ button: 'right' });
                    await page.getByRole('menuitem', { name: 'Discard 3 items…', exact: true }).click();
                    assert.deepEqual(await page.evaluate(() => window.discardKeys), ['.obsidian/appearance.json', '.obsidian/types.json', 'delete:Notes/Archive.md']);
                    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                    await rows.nth(3).click({ button: 'right' });
                    await expect(highlighted).toHaveCount(1);
                    await page.getByRole('menuitem', { name: 'Discard 1 item…', exact: true }).click();
                    await expect(page.getByRole('button', { name: 'Discard changes (0)' })).toBeDisabled();
                    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                    await first.click();
                    await page.keyboard.press('Shift+ArrowDown');
                    await page.keyboard.press('Shift+ArrowDown');
                    await expect(highlighted).toHaveCount(3);
                    await page.keyboard.press('Shift+ArrowUp');
                    await expect(highlighted).toHaveCount(2);
                    await page.evaluate(() => window.mount());
                    await expect(highlighted).toHaveCount(2);
                    await expect(checks.first()).not.toBeChecked();
                    // macOS reserves native Control-click for context menus; simulate the Windows click event.
                    await rows.nth(2).dispatchEvent('click', { ctrlKey: true });
                    await expect(highlighted).toHaveCount(3);
                    await expect(page.getByRole('button', { name: 'Sync selected' })).toBeEnabled();
                    if (browserType === chromium) await page.screenshot({ path: `.generated/activity-diff/${theme}-${width}-multiselect.png` });
                    // Cmd+A in the diff keeps row selection intact.
                    await preview.click();
                    await page.keyboard.press('Meta+a');
                    await expect(highlighted).toHaveCount(3);
                    await all.check();
                    await first.click();
                }
                // A normal refresh retains the selected file and narrow-screen detail state.
                await page.evaluate(() => window.mount());
                await expect(first).toHaveAttribute('aria-pressed', 'true');
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                // A late response from the previous file cannot replace the current selection.
                await page.evaluate(() => { window.delayed = true; });
                await page.evaluate(() => window.mount());
                await expect(preview.getByText('Loading changes…')).toBeVisible();
                await showFiles();
                await rows.nth(1).click();
                await expect(preview.getByText('Unchanged', { exact: true })).toBeVisible();
                await page.evaluate(() => window.release());
                await expect(preview.getByText('Unchanged', { exact: true })).toBeVisible();
                await expect(page.locator('.crate-browser-file-title')).toHaveText('core-plugins.json');
                // Removing the selected path clears selection without selecting a different file.
                await page.evaluate(() => { window.paths.splice(1, 1); window.mount(); });
                await expect(page.locator('.crate-browser-file[aria-pressed="true"]')).toHaveCount(0);
                await expect(rows.first()).toBeVisible();
                await rows.first().click();
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                await page.evaluate(() => { window.delayed = true; });
                await page.evaluate(() => window.mount());
                await expect(preview.getByText('Loading changes…')).toBeVisible();
                await page.evaluate(() => { document.querySelector('.crate-activity-panel').replaceChildren(); window.release(); });
                await expect(page.locator('.crate-file-diff')).toHaveCount(0);
                await page.evaluate(() => {
                    window.paths = Array.from({ length: 20 }, (_, i) => 'Note ' + i + '.md');
                    window.allChanged = true;
                    window.mount();
                });
                await expect(rows.last().locator('.crate-browser-file-status')).toHaveText('+2 −2');
                await all.uncheck();
                await first.focus();
                await page.keyboard.press('Control+a');
                await expect(page.locator('.crate-browser-sync')).toBeHidden();
                await expect(highlighted).toHaveCount(20);
                await page.keyboard.press('Shift+F10');
                await page.getByRole('menuitem', { name: 'Discard 20 items…', exact: true }).click();
                await expect(page.getByRole('button', { name: 'Discard changes (20)' })).toBeEnabled();
                assert.equal((await page.evaluate(() => window.discardKeys)).length, 20);
                await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                // Large attachment queues do not make a request per image before reaching text.
                await page.evaluate(() => {
                    window.paths = Array.from({ length: 499 }, (_, i) => (i % 2 ? 'delete:' : '') + 'Image ' + i + '.PNG');
                    window.paths.push('Note.md');
                    window.calls = 0;
                    window.mount();
                });
                await expect(rows.last().locator('.crate-browser-file-status')).toHaveText('+2 −2');
                await expect(page.locator('.crate-browser-file-status', { hasText: 'No preview' })).toHaveCount(499);
                assert.equal(await page.evaluate(() => window.calls), 1, 'Only the text file is checked in the background');
                await rows.first().click();
                await expect(page.locator('.crate-browser-toolbar .crate-diff-stats')).toHaveText('+2−2');
                assert.equal(await page.evaluate(() => window.calls), 2, 'Selecting a binary file loads its details on demand');
                assert.deepEqual(errors, []);
                await page.close();
            }
        }
        console.log(`${browserType.name()}: pending diffs passed at desktop/mobile widths in light/dark themes`);
    } finally { await browser.close(); }
}
