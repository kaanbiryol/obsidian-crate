import { test, expect } from '@playwright/test';

type ClipboardWindow = Window & { copiedValue?: string; finishCopy?: () => void; copyCalls?: number };

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

      const link = page.getByRole('textbox', { name: 'Link', exact: true });
      await page.getByText('Link', { exact: true }).click();
      await expect(link).toBeFocused();
      await expect(link).toHaveAccessibleDescription('A web address to save.');
      await expect(link).toHaveCSS('font-size', '16px');
      await link.fill('https://example.com');
      await page.keyboard.press('Tab');
      const invalid = page.getByRole('textbox', { name: 'Invalid link', exact: true });
      await expect(invalid).toBeFocused();
      await expect(invalid).toHaveCSS('outline-style', 'solid');
      await expect(invalid).toHaveAttribute('aria-invalid', 'true');
      await expect(invalid).toHaveAccessibleDescription('Use an HTTPS address. Enter a valid web address.');
      await expect(page.getByRole('textbox', { name: 'Disabled value' })).toBeDisabled();
      const readOnly = page.getByRole('textbox', { name: 'Read-only value' });
      await readOnly.evaluate((el: HTMLInputElement) => { el.focus(); el.select(); });
      expect(await readOnly.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('Select and copy this text');
      const search = page.getByRole('searchbox', { name: 'Search controls' });
      await search.focus();
      await page.keyboard.press('ArrowRight');
      await expect(search).toHaveCSS('outline-style', 'none');
      await expect(page.locator('.crate-field--search .crate-field__control')).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Clear control search' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(search).toHaveValue('');

      const loadedHeader = page.getByTestId('loaded-header').locator('.view-header');
      const openingHeader = page.getByTestId('opening-header').locator('.view-header');
      expect((await loadedHeader.boundingBox())!.height).toBe((await openingHeader.boundingBox())!.height);
      await expect(openingHeader.locator('.view-header-meta')).toHaveAttribute('aria-hidden', 'true');
      await expect(openingHeader.locator('.view-header-meta')).toBeHidden();
      if (host === 'pwa') {
        if (width < 760) {
          expect((await loadedHeader.boundingBox())!.height).toBeLessThanOrEqual(78);
          await expect(loadedHeader.locator('.view-header-title')).toHaveCSS('font-size', '26px');
          await expect(loadedHeader.locator('.view-header-meta')).toHaveCSS('height', '20px');
        }
        // Mounting two feature settings panels must not create duplicate section IDs.
        const sections = page.getByRole('region', { name: 'Example preferences' });
        await expect(sections).toHaveCount(2);
        expect(await sections.nth(0).getAttribute('aria-labelledby')).not.toBe(await sections.nth(1).getAttribute('aria-labelledby'));
        await page.getByRole('combobox', { name: 'Default view Select the opening screen.' }).selectOption('inbox');
        await expect(page.getByRole('combobox')).toHaveValue('inbox');
        const recovery = page.getByRole('region', { name: 'Example recovery' });
        await expect(recovery.getByRole('status')).toHaveText('Your changes remain on this device.');
        expect((await recovery.getByRole('button', { name: 'Review changes' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await recovery.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        const indicatorMatchesPalette = async (token: string) => page.locator('.toast').evaluate((el, token) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`; el.append(probe);
          const matches = getComputedStyle(el, '::before').backgroundColor === getComputedStyle(probe).color;
          probe.remove(); return matches;
        }, token);
        await page.getByRole('button', { name: 'Show success' }).click();
        await expect(page.locator('.toast')).toHaveAttribute('role', 'status');
        await expect(page.locator('.toast')).toHaveAttribute('aria-live', 'polite');
        expect(await indicatorMatchesPalette('--text-success')).toBe(true);
        await page.getByRole('button', { name: 'Show error' }).click();
        await expect(page.locator('.toast')).toHaveAttribute('role', 'alert');
        await expect(page.locator('.toast')).toHaveAttribute('aria-live', 'assertive');
        expect(await indicatorMatchesPalette('--text-error')).toBe(true);
        await expect(page.locator('.toast')).toHaveText('Could not save changes.');
        await page.getByRole('button', { name: 'Dismiss feedback' }).click();
        await expect(page.locator('.toast')).toHaveCount(0);
        // Legacy shell variables and shared controls resolve to the same palette in either theme.
        expect(await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return ([['--text', '--text-normal'], ['--bg', '--background-primary'], ['--accent', '--interactive-accent'], ['--danger', '--text-error']] as const).every(([alias, token]) => style.getPropertyValue(alias).trim() === style.getPropertyValue(token).trim());
        })).toBe(true);
      }
      await page.mouse.move(0, 0);
      await testInfo.attach('controls', { body: await page.getByTestId('visual-surface').screenshot(), contentType: 'image/png' });
    });
  }

  for (const host of ['plugin', 'pwa']) test(`Copy fallback and replaced values in ${host}`, async ({ page }) => {
    await page.goto(`/?host=${host}&theme=dark&scene=controls`);
    const region = page.getByRole('region', { name: 'Copyable values' });
    const copy = region.getByRole('button', { name: 'Copy export' });
    const field = region.getByRole('textbox', { name: 'Export text' });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Permission denied'); } },
    }));
    await copy.click();
    await expect(region.getByRole('alert')).toHaveText('Select and copy the export below.');
    await field.focus();
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('First export');
    expect((await field.boundingBox())!.width).toBeGreaterThan(100);

    await page.evaluate(() => {
      const target = window as ClipboardWindow;
      target.copyCalls = 0;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: (value: string) => { target.copyCalls = (target.copyCalls ?? 0) + 1; target.copiedValue = value; return new Promise<void>(resolve => { target.finishCopy = resolve; }); },
      } });
    });
    await copy.click();
    await region.getByRole('button', { name: 'Replace copy value' }).click();
    await page.evaluate(() => (window as ClipboardWindow).finishCopy?.());
    await expect(field).toHaveCount(0);
    await expect(region.getByText('Export copied.', { exact: true })).toHaveCount(0);
    await region.getByRole('checkbox', { name: 'Allow copying' }).uncheck();
    await copy.click();
    expect(await page.evaluate(() => (window as ClipboardWindow).copyCalls)).toBe(1);
    await region.getByRole('checkbox', { name: 'Allow copying' }).check();
    await copy.click();
    await page.evaluate(() => (window as ClipboardWindow).finishCopy?.());
    await expect(region.getByRole('status')).toHaveText('Export copied.');
    expect(await page.evaluate(() => (window as ClipboardWindow).copiedValue)).toBe('Second export');
  });

  for (const host of ['plugin', 'pwa']) test(`Reading fields preserve native validation, drafts and tags in ${host}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?host=${host}&theme=dark&scene=reading&empty=1`);
    const save = page.getByRole('button', { name: 'Save your first link' });
    await expect(save).toBeVisible();
    expect((await save.boundingBox())!.height).toBe(28);
    await save.click();
    await expect(page.getByRole('dialog', { name: 'Save a link' })).toBeVisible();
    const link = page.getByRole('textbox', { name: 'Link', exact: true });
    await link.fill('not-a-url');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save a link' })).toBeVisible();
    expect(await link.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
    await link.fill('https://example.com/later');
    await page.getByRole('textbox', { name: 'Title (optional)' }).fill('Read later');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(save).toBeVisible();
    await save.click();
    await expect(link).toHaveValue('https://example.com/later');
    await expect(page.getByRole('textbox', { name: 'Title (optional)' })).toHaveValue('Read later');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.goto(`/?host=${host}&theme=dark&scene=reading`);
    await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
    await page.getByRole('button', { name: 'Edit article tags' }).click();
    await page.getByRole('textbox', { name: 'Tags, separated by commas' }).fill('essays, shared, shared');
    await page.getByRole('button', { name: 'Save tags', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.crate-reading-reader__tags').getByText('#shared', { exact: true })).toHaveCount(1);
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
