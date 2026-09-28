import { test, expect } from '@playwright/test';

export function registerReadingHighlightTests() {
    test('plugin link capture uses a header Save action and standard field', async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 900 });
      await page.goto('/?host=plugin&scene=reading&theme=dark');
      await page.getByRole('button', { name: 'Save a link', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Save a link' });
      const save = dialog.getByRole('button', { name: 'Save link', exact: true });
      await expect(save).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(dialog.locator('.reminder-modal-header').getByRole('button', { name: 'Save link', exact: true })).toBeVisible();
      const input = dialog.getByRole('textbox', { name: 'Link', exact: true });
      await expect(input).toBeFocused();
      await input.fill('not a link');
      await expect(save).toBeDisabled();
      await input.fill('https://example.com/article');
      await expect(save).toBeEnabled();
      await expect(input).toHaveCSS('box-shadow', 'none');
      await expect(input).toHaveCSS('outline-style', 'none');
      await input.press('Shift+Tab');
      await expect(save).toBeFocused();
      await expect(save).toHaveCSS('outline-style', 'solid');
      await save.click();
      await expect(dialog).toHaveCount(0);
    });
    for (const host of ['plugin', 'pwa']) {
      test(`${host} saves a selected passage and keeps highlight controls usable`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 900 });
        await page.goto(`/?host=${host}&scene=reading&theme=dark`);
        const search = page.getByRole('searchbox', { name: 'Search reading' });
        await search.focus();
        await expect(search).toHaveCSS('outline-style', 'none');
        await expect(search.locator('..')).toHaveCSS('outline-style', 'none');
        await page.getByRole('button', { name: /The pleasure of reading slowly/ }).click();
        const code = page.locator('.crate-reading-reader__body pre code');
        await expect(code).toHaveText("const reading = ['one good thing', 'another'];\n");
        await expect(code.locator('.hljs-keyword')).toHaveText('const');
        expect(await code.locator('.hljs-keyword').evaluate(element =>
          getComputedStyle(element).color !== getComputedStyle(element.closest('code')!).color,
        )).toBe(true);
        const paragraph = page.locator('.crate-reading-reader__body > p').first();
        await expect(paragraph).toBeVisible();
        const selectionBounds = await paragraph.evaluate(element => {
          const range = element.ownerDocument.createRange();
          range.setStart(element.firstChild!, 0);
          range.setEnd(element.firstChild!, 14);
          const rect = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, y: (rect.top + rect.bottom) / 2 };
        });
        await page.mouse.move(selectionBounds.left + 1, selectionBounds.y);
        await page.mouse.down();
        await page.mouse.move(selectionBounds.right, selectionBounds.y, { steps: 8 });
        await page.mouse.up();
        await expect(page.getByRole('group', { name: 'Highlight actions' })).toBeVisible();
        await expect(page.locator('.crate-reading-reader__highlight')).toHaveText('A good article');
        // Document listeners must resolve the handle inside the plugin shadow root.
        const end = page.getByRole('button', { name: 'Adjust highlight end' });
        await end.focus();
        await end.press('ArrowRight');
        await expect.poll(() => page.locator('.crate-reading-reader__highlight').textContent()).toBe('A good article ');
        await page.getByRole('button', { name: 'Delete highlight', exact: true }).click();
        await expect(page.locator('.crate-reading-reader__highlight')).toHaveCount(0);
        await page.getByRole('button', { name: 'Highlights (0)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Highlights', exact: true });
        await expect(dialog).toBeVisible();
        if (host === 'plugin') {
          const geometry = await dialog.evaluate(element => {
            const viewport = element.closest('.base-modal-viewport')!;
            return { width: element.getBoundingClientRect().width, available: viewport.getBoundingClientRect().width };
          });
          expect(Math.abs(geometry.width - geometry.available)).toBeLessThanOrEqual(2);
        }
        await dialog.getByRole('button', { name: 'Close highlights', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      });
    }
}
