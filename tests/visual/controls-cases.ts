import { test, expect } from '@playwright/test';

export function registerControlTests() {
  for (const host of ['plugin', 'pwa']) for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    test(`controls ${host} ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/?host=${host}&theme=${theme}&scene=controls`);
      const sync = page.getByRole('button', { name: 'Sync vault', exact: true });
      const save = page.getByRole('button', { name: 'Save your first link', exact: true });
      await expect(sync).toBeVisible();
      for (const control of [sync, save, page.getByRole('button', { name: 'Refresh library', exact: true })].slice(0, host === 'pwa' ? 3 : 2)) {
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect((await control.boundingBox())!.height).toBe(28);
      }
      // The same action must not acquire a different font or border in another feature/host adapter.
      const style = (el: HTMLElement) => {
        const css = getComputedStyle(el);
        return [css.fontSize, css.fontWeight, css.borderRadius, css.borderColor, css.backgroundColor, css.padding];
      };
      expect(await save.evaluate(style)).toEqual(await sync.evaluate(style));
      if (host === 'pwa') expect(await page.getByRole('button', { name: 'Refresh library' }).evaluate(style)).toEqual(await sync.evaluate(style));
      if (host === 'plugin') {
        // Compare with the actual imperative plugin action, not another shared Button.
        const pluginSync = page.getByRole('button', { name: 'Plugin Sync vault' });
        expect(await sync.evaluate(style)).toEqual(await pluginSync.evaluate(style));
        expect((await sync.boundingBox())!.height).toBe((await pluginSync.boundingBox())!.height);
      }
      await expect(sync).toHaveCSS('font-size', '12px');
      await expect(sync).toHaveCSS('border-radius', '4px');
      const longAction = page.getByRole('button', { name: 'Export unsynced reminders and saved changes from this device' });
      expect(await longAction.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect((await page.getByRole('button', { name: 'Always a touch target' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await sync.focus();
      await page.keyboard.press('Tab');
      await expect(save).toBeFocused();
      await expect(save).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status', { name: 'Activations' })).toHaveText('1');
      await page.keyboard.press('Space');
      await expect(page.getByRole('status', { name: 'Activations' })).toHaveText('2');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Save link', exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Unavailable', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCSS('background-color', await page.getByRole('button', { name: 'Save link', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor));
      await page.mouse.move(0, 0);
      await testInfo.attach('controls', { body: await page.getByTestId('visual-surface').screenshot(), contentType: 'image/png' });
    });
  }

  for (const host of ['plugin', 'pwa']) test(`empty Reading action opens capture in ${host}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?host=${host}&theme=dark&scene=reading&empty=1`);
    const save = page.getByRole('button', { name: 'Save your first link' });
    await expect(save).toBeVisible();
    expect((await save.boundingBox())!.height).toBe(28);
    await save.click();
    await expect(page.getByRole('dialog', { name: 'Save a link' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(save).toBeVisible();
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true, viewport: { width: 1024, height: 900 } });
    test('wide touch screens retain tap targets and release pressed feedback', async ({ page }) => {
      await page.goto('/?host=pwa&theme=dark&scene=controls');
      const sync = page.getByRole('button', { name: 'Sync vault', exact: true });
      await expect(sync).toBeVisible();
      expect((await sync.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const restingBackground = await sync.evaluate(el => getComputedStyle(el).backgroundColor);
      await sync.tap();
      await expect(page.getByRole('status', { name: 'Activations' })).toHaveText('1');
      await expect(sync).toHaveCSS('background-color', restingBackground);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(sync).toHaveCSS('transition-duration', '0s');
      await page.getByRole('button', { name: 'Unavailable', exact: true }).evaluate((el: HTMLButtonElement) => el.click());
      await expect(page.getByRole('status', { name: 'Activations' })).toHaveText('1');
    });
  });
}
