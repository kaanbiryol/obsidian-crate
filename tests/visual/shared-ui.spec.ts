import { test, expect } from '@playwright/test';

for (const host of ['plugin', 'pwa']) {
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1280]) {
      for (const scene of ['cards', 'editor', 'date', 'project', 'weekly', 'monthly']) {
        test(`${host} ${theme} ${width} ${scene}`, async ({ page }) => {
          await page.setViewportSize({ width, height: 844 });
          await page.clock.setFixedTime(new Date('2026-09-05T10:00:00Z'));
          await page.goto(`/?host=${host}&theme=${theme}&scene=${scene}`);
          const surface = page.getByTestId('visual-surface');
          await expect(surface).toBeVisible();
          await expect(page.getByTestId('result')).toHaveText('Ready');
          if (scene === 'editor') {
            await page.getByRole('textbox', { name: 'Reminder title', exact: true }).focus();
          }
          await expect(surface).toHaveScreenshot(`${host}-${theme}-${width}-${scene}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.001 });
          expect(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          if (scene === 'project') {
            await page.getByRole('option', { name: 'Work', exact: true }).focus();
            await page.keyboard.press('ArrowDown');
            await expect(page.getByRole('option', { name: 'Personal', exact: true })).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('option', { name: 'Personal', exact: true })).toHaveAttribute('aria-selected', 'true');
          }
          if (scene === 'weekly') {
            await page.getByRole('tab', { name: 'Weekly', exact: true }).focus();
            await page.keyboard.press('ArrowRight');
            await expect(page.getByRole('tab', { name: 'Monthly', exact: true })).toHaveAttribute('aria-selected', 'true');
            await expect(page.getByRole('button', { name: 'Increase day of month' })).toBeVisible();
          }
        });
      }
    }
  }
}
