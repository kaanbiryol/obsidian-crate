import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
const assets = await buildPwaPreviewAssets();
for (const type of [chromium, webkit]) {
 const { server } = await listenPwaPreviewServer({ port: 0, assets });
 try {
  const browser = await type.launch();
  try {
   const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
   await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
   const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
   await card.tap();
   const title = page.locator('[aria-label="Reminder title"]');
   await title.fill('My preserved draft');
   await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   const confirmation = page.getByRole('alertdialog');
   await expect(confirmation).toBeVisible();
   await expect(title).not.toBeFocused();
   await expect(confirmation.getByRole('heading')).toHaveText('Delete reminder');
   await expect(confirmation).toContainText('My preserved draft');
   await expect(page.locator('.pwa-modal-sheet')).toHaveCount(1);
   await page.waitForTimeout(400);
   if (type === webkit) await page.screenshot({ path: '/tmp/crate-inline-delete.png' });
   await confirmation.getByRole('button', { name: 'Cancel', exact: true }).tap();
   await expect(title).toBeVisible();
   await expect(title).toHaveText('My preserved draft');
   await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   await confirmation.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   await expect(confirmation).toHaveCount(0);
   await expect(card).toHaveCount(0);
   console.log(`${type.name()}: inline confirmation, draft preservation and deletion passed`);
  } finally { await browser.close(); }
 } finally { server.close(); }
}
