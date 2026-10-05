import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { obsidianDomHelpers, obsidianDialogModule, hostStyles } from './obsidian-dialog-fixture.mjs';

// Mount the production modal, header and tab renderers against native host CSS.
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { ActivityModal } from './src/ui/activity-modal';
    import { ConflictReviewModal } from './src/ui/activity/conflict-review-modal';
    ${obsidianDomHelpers}
    HTMLElement.prototype.addClasses = function(names) { this.classList.add(...names); };
    HTMLElement.prototype.removeClasses = function(names) { this.classList.remove(...names); };
    HTMLElement.prototype.toggle = function(visible) { visible ? this.show() : this.hide(); };
    const listeners = new Set();
    let status = 'idle';
    const deps = {
      getState: () => ({ status, lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
      getPendingPaths: () => [], getActiveConflicts: () => [],
      sync: async () => window.setSyncing(true),
      addStateChangeListener: fn => listeners.add(fn), removeStateChangeListener: fn => listeners.delete(fn),
    };
    window.setSyncing = syncing => { status = syncing ? 'syncing' : 'idle'; for (const fn of listeners) fn(); };
    window.mount = scene => {
      window.currentModal?.close();
      if (scene === 'conflict') new ConflictReviewModal({}, { originalPath: 'Note.md', conflictPath: 'Note.conflict.md' }, async () => ({
        currentText: 'Current note', savedText: 'Saved note', currentSize: 12, savedSize: 10,
        openVersion: async () => {}, resolve: async () => {},
      }), () => {}).open();
      else if (scene === 'history-loading') new ActivityModal({}, {
        syncHistory: [{ timestamp: '2026-01-01T00:00:00Z', type: 'sync', success: true, uploaded: 1,
          downloaded: 0, deleted: 0, merged: 0, conflictCount: 0, errorCount: 0, uploadedPaths: ['note.md'] }],
        workerUrl: 'https://crate.example',
      }, { ...deps, listSharedCheckpoints: () => new Promise((resolve, reject) => {
        window.resolveSharedHistory = () => resolve([]);
        window.rejectSharedHistory = () => reject(new Error('Offline'));
      }) }, 'history').open();
      else new ActivityModal({}, { syncHistory: [], workerUrl: 'https://crate.example' }, deps).open();
    };
    window.mount('activity');
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.scss': 'empty' },
  plugins: [{ name: 'obsidian-host', setup(builder) {
    builder.onResolve({ filter: /(^obsidian$|\/file-actions$)/ }, args => ({ path: args.path, namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: args.path === 'obsidian' ? `${obsidianDialogModule}
      export const Platform = { isMobile: innerWidth < 700, isDesktopApp: innerWidth >= 700 };
      export class Scope {} export class Menu {} export class FileSystemAdapter {} export class TFile {}
    ` : 'export const getPendingFileActions = () => [];' }));
  } }],
});
const css = await readFile('dist/styles.css', 'utf8');
const primaryStyle = el => {
  const style = getComputedStyle(el);
  return [style.fontSize, style.fontWeight, style.borderRadius, style.borderColor, style.borderWidth,
    style.backgroundColor, style.padding, style.height];
};
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const [width, height] of [[1280, 900], [390, 844], [320, 400]]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<html class="theme-${theme}"><style>${hostStyles}
        .modal { transform: translateY(-25%); }
        ${css}</style><body></body></html>`);
      await page.addScriptTag({ content: outputFiles[0].text });
      const dialog = page.getByRole('dialog', { name: 'Sync activity', exact: true });
      const sync = page.getByRole('button', { name: 'Sync vault', exact: true });
      const close = page.getByRole('button', { name: 'Close sync activity', exact: true });
      const heading = page.getByRole('heading', { name: 'Sync activity', exact: true });
      await expect(sync).toBeEnabled();
      assert.equal(await page.locator('.modal.crate-reminder-editor-modal').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).isIdentity), true);
      const surface = await dialog.boundingBox();
      assert.ok(surface.x >= 0 && surface.y >= 0 && surface.x + surface.width <= width + 1 && surface.y + surface.height <= height + 1);
      if (width >= 700) assert.ok(surface.width <= 800 && surface.height <= 560);
      const [closeBox, headingBox, syncBox] = await Promise.all([close.boundingBox(), heading.boundingBox(), sync.boundingBox()]);
      assert.ok(closeBox.x + closeBox.width <= headingBox.x);
      assert.ok(headingBox.x + headingBox.width <= syncBox.x);
      assert.ok(Math.abs(closeBox.y + closeBox.height / 2 - syncBox.y - syncBox.height / 2) <= 1);
      const actionStyle = await sync.evaluate(primaryStyle);
      for (const tab of ['Pending', 'Conflicts', 'History']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        const panel = page.getByRole('tabpanel', { name: tab, exact: true });
        await expect(panel.locator('.crate-activity-empty-state')).toBeVisible();
        const geometry = await panel.evaluate(panel => {
          const area = (panel.querySelector('.crate-history-timeline-content') ?? panel).getBoundingClientRect();
          const icon = panel.querySelector('.crate-empty-icon').getBoundingClientRect();
          const text = panel.querySelector('.crate-empty-text').getBoundingClientRect();
          return { x: (icon.left + icon.right) / 2 - (area.left + area.right) / 2,
            y: (icon.top + text.bottom) / 2 - (area.top + area.bottom) / 2,
            overflow: panel.scrollHeight - panel.clientHeight };
        });
        const label = `${engine.name()} ${theme} ${width}x${height} ${tab}`;
        assert.ok(Math.abs(geometry.x) <= 1, `${label}: horizontal offset ${geometry.x}`);
        assert.ok(Math.abs(geometry.y) <= 1, `${label}: vertical offset ${geometry.y}`);
        assert.ok(geometry.overflow <= 1, `${label}: unnecessary scrolling`);
        assert.equal(await page.getByRole('tabpanel').count(), 1);
      }
      await sync.click();
      await expect(page.getByRole('button', { name: 'Syncing…', exact: true })).toBeDisabled();
      await page.evaluate(() => window.setSyncing(false));
      await expect(sync).toBeEnabled();
      await page.mouse.move(0, 0);
      await page.evaluate(() => window.mount('conflict'));
      const resolve = page.getByRole('button', { name: 'Resolve conflict', exact: true });
      await expect(resolve).toBeDisabled();
      await page.getByRole('radio', { name: 'Keep current', exact: true }).check();
      await expect(resolve).toBeEnabled();
      assert.deepEqual(await resolve.evaluate(primaryStyle), actionStyle);
      if (width === 1280 && theme === 'light') {
        for (const outcome of ['resolveSharedHistory', 'rejectSharedHistory']) {
          await page.evaluate(() => window.mount('history-loading'));
          const panel = page.getByRole('tabpanel', { name: 'History', exact: true });
          await expect(panel).toContainText('Loading history…');
          await expect(panel.locator('.crate-history-entry')).toHaveCount(0);
          await page.evaluate(outcome => window[outcome](), outcome);
          await expect(panel.locator('.crate-history-entry')).toHaveCount(1);
          await expect(panel).not.toContainText('Loading history…');
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
console.log('Activity headers, empty states and shared actions fit desktop, mobile and short viewports in Chromium and WebKit.');
