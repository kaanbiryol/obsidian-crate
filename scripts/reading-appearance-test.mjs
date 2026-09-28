import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const session = { token: 'reading-appearance-test', id: 'reading-appearance-test', folderPath: 'Reading', generation: 'appearance-test', expiresAt: Date.now() + 86400000 };
const items = [1, 2].map(index => ({
  crate_reading_version: 1, crate_reading_id: `67de6c50-c70c-4c85-93f2-${String(index).padStart(12, '0')}`,
  title: `Appearance article ${index}`, source_url: 'https://example.com/article', saved_at: '2026-09-21T10:00:00.000Z',
  reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', capture_method: 'web-clipper', path: `Reading/${index}.md`,
}));

async function openArticle(page, index) {
  await page.locator('.crate-reading__open').filter({ hasText: items[index].title }).click();
  await expect(page.locator('.crate-reading-reader__body')).toBeVisible();
}

async function checkAppearance(page, serif, size) {
  const reader = page.locator('.crate-reading-reader');
  await expect(reader).toHaveAttribute('data-serif', String(serif));
  await expect(reader).toHaveCSS('--reading-font-size', `${size}px`);
}

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
      context.setDefaultTimeout(10000);
      await context.addInitScript(session => localStorage.setItem('crate-reading-session-v1', JSON.stringify(session)), session);
      await context.route('**/reading/session', route => route.fulfill({ json: session }));
      await context.route('**/reading/list*', route => route.fulfill({ json: { items, issues: [], cursor: null } }));
      await context.route('**/reading/item?*', route => route.fulfill({ json: {
        item: items.find(item => item.crate_reading_id === new URL(route.request().url()).searchParams.get('id')),
        markdown: 'An article for checking saved reading appearance.',
      } }));
      let page = await context.newPage();
      await page.goto(`${origin}/notifications?section=reading`);
      await openArticle(page, 0);
      await checkAppearance(page, false, 19);
      await page.getByRole('button', { name: 'Reading appearance', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reading appearance' });
      await dialog.getByRole('button', { name: 'Literary Serif' }).click();
      await dialog.getByRole('button', { name: 'Increase text size' }).click();
      await dialog.getByRole('button', { name: 'Increase text size' }).click();
      await dialog.getByRole('button', { name: /close/i }).click();
      await expect(dialog).toHaveCount(0);
      await checkAppearance(page, true, 21);
      await page.getByRole('button', { name: 'Back to reading', exact: true }).click();
      await expect(page.locator('.crate-reading-reader')).toHaveCount(0);
      await openArticle(page, 1);
      await checkAppearance(page, true, 21);
      await page.reload();
      await expect(page.locator('.crate-reading-reader__body')).toBeVisible();
      await checkAppearance(page, true, 21);
      // A fresh document in the same browser retains local preferences without React state.
      await page.close();
      page = await context.newPage();
      await page.goto(`${origin}/notifications?section=reading`);
      await openArticle(page, 0);
      await checkAppearance(page, true, 21);
      await page.getByRole('button', { name: 'Reading appearance', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Literary Serif' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByLabel('Text size', { exact: true })).toHaveText('21');
      console.log(`${engine.name()}: reading appearance persists across articles, reload and close/reopen`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
