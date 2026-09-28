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
   const editorClose = page.getByRole('button', { name: 'Close reminder editor', exact: true });
   const editorCloseBackground = await editorClose.evaluate(element => getComputedStyle(element).backgroundColor);
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
   const deleteAction = confirmation.getByRole('button', { name: 'Delete reminder', exact: true });
   await expect(deleteAction).toHaveText('Delete');
   await expect(confirmation.locator('.pwa-delete-confirmation-body button')).toHaveCount(0);
   await expect(confirmation.getByRole('button')).toHaveCount(2);
   await page.addStyleTag({ content: '.test-danger-color-probe { color: var(--crate-danger); }' });
   for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 768]) {
     await page.setViewportSize({ width, height: 844 });
     // Destructive actions share the rounded sheet-header surface.
     await expect(deleteAction).toHaveCSS('background-color', await confirmation.getByRole('button', { name: 'Cancel deletion', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor));
     await expect(deleteAction).toHaveCSS('border-radius', '999px');
     await expect.poll(() => confirmation.locator('.pwa-delete-confirmation').evaluate(element => {
      const heading = element.querySelector('h2');
      const action = element.querySelector('[data-action="confirm-delete"]');
      const close = element.querySelector('.reminder-modal-header-close');
      const range = document.createRange();
      range.selectNodeContents(heading);
      const title = heading.getBoundingClientRect();
      const text = range.getBoundingClientRect();
      const lines = new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
      const button = action.getBoundingClientRect();
      const closeBounds = close.getBoundingClientRect();
      const colorProbe = document.createElement('span');
      colorProbe.className = 'test-danger-color-probe';
      element.append(colorProbe);
      const dangerColor = getComputedStyle(colorProbe).color;
      colorProbe.remove();
      return {
       lines,
       fits: text.width <= title.width + 1,
       centered: Math.abs(title.x + title.width / 2 - innerWidth / 2) < 1,
       separated: text.right <= button.left && text.left >= closeBounds.right,
       touchTargets: [button, closeBounds].every(rect => rect.width >= 44 && rect.height >= 44),
       dangerColor: getComputedStyle(action).color === dangerColor,
      };
     })).toEqual({ lines: 1, fits: true, centered: true, separated: true, touchTargets: true, dangerColor: true });
    }
   }
   await page.setViewportSize({ width: 390, height: 844 });
   if (type === webkit) await page.screenshot({ path: '/tmp/crate-inline-delete.png' });
   const dismissConfirmation = async action => {
    // Sample inside the browser so automation latency cannot skip the closing frames.
    await page.evaluate(() => {
     window.deleteClosingFrames = [];
     const sample = () => {
      if (!document.querySelector('[role="alertdialog"]')) return;
      window.deleteClosingFrames.push(getComputedStyle(document.querySelector('.pwa-reminder-sheet-screen--editor')).opacity);
      requestAnimationFrame(sample);
     };
     sample();
    });
    await action();
    await expect(confirmation).toHaveCount(0);
    const frames = await page.evaluate(() => window.deleteClosingFrames);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(opacity => opacity === '0')).toBe(true);
    await expect(title).toBeFocused();
   };
   await dismissConfirmation(() => confirmation.getByRole('button', { name: 'Cancel deletion', exact: true }).tap());
   await expect(title).toBeVisible();
   await waitForStageOpen();
   await expect(title).toBeFocused();
   await expect(title).toHaveText('My preserved draft');
   for (const dismiss of ['close', 'escape']) {
    await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
    await expect(confirmation).toBeVisible();
    await waitForStageOpen();
    await dismissConfirmation(() => dismiss === 'close'
     ? confirmation.getByRole('button', { name: 'Cancel deletion', exact: true }).tap()
     : confirmation.press('Escape'));
    await waitForStageOpen();
    await expect(title).toBeFocused();
    await expect(title).toHaveText('My preserved draft');
    await expect(editorClose).not.toBeFocused();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(editorClose).toHaveCSS('background-color', editorCloseBackground);
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
