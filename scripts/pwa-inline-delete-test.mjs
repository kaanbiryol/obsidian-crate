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
   const waitForStageOpen = () => page.waitForFunction(() => {
    const stage = document.querySelector('.pwa-reminder-sheet-stage');
    return stage && !document.querySelector('.reminder-action-chips')?.inert
     && Math.abs(new DOMMatrixReadOnly(getComputedStyle(stage).transform).m42) < 0.1;
   });
   await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
   const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
   await card.tap();
   const title = page.locator('[aria-label="Reminder title"]');
   await title.fill('My preserved draft');
   await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   const confirmation = page.getByRole('alertdialog');
   await expect(confirmation).toHaveCount(0);
   await expect(title).toBeVisible();
   await expect(confirmation).toBeVisible();
   await expect(title).not.toBeFocused();
   await expect(confirmation.getByRole('heading')).toHaveText('Delete reminder');
   await expect(confirmation).toContainText('My preserved draft');
   await expect(page.locator('.pwa-modal-sheet')).toHaveCount(1);
   await waitForStageOpen();
   if (type === webkit) await page.screenshot({ path: '/tmp/crate-inline-delete.png' });
   await confirmation.getByRole('button', { name: 'Cancel', exact: true }).tap();
   await expect(confirmation).toBeVisible();
   await expect(page.locator('.pwa-reminder-sheet-screen--editor')).toHaveCSS('opacity', '0');
   await expect(title).toBeFocused();
   await expect(confirmation).toHaveCount(0);
   await expect(title).toBeVisible();
   await waitForStageOpen();
   await expect(title).toBeFocused();
   await expect(title).toHaveText('My preserved draft');
   for (const dismiss of ['close', 'escape']) {
    await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
    await expect(confirmation).toBeVisible();
    await waitForStageOpen();
    if (dismiss === 'close') await confirmation.getByRole('button', { name: 'Cancel deletion', exact: true }).tap();
    else await confirmation.press('Escape');
    await expect(confirmation).toBeVisible();
    await expect(page.locator('.pwa-reminder-sheet-screen--editor')).toHaveCSS('opacity', '0');
    await expect(title, `${type.name()}: ${dismiss} restores title focus`).toBeFocused();
    await expect(confirmation).toHaveCount(0);
    await waitForStageOpen();
    await expect(title).toBeFocused();
    await expect(title).toHaveText('My preserved draft');
    const editorClose = page.getByRole('button', { name: 'Close reminder editor', exact: true });
    await expect(editorClose).not.toBeFocused();
    await expect(editorClose).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
   }
   await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   await expect(confirmation).toBeVisible();
   await waitForStageOpen();
   await confirmation.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
   await expect(confirmation).toHaveCount(0);
   await expect(card).toHaveCount(0);
   console.log(`${type.name()}: inline confirmation, draft preservation and deletion passed`);
  } finally { await browser.close(); }
 } finally { server.close(); }
}
