import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const nativeTimeStyles = fileURLToPath(new URL('./native-time.css', import.meta.url));

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
          const nativeTime = surface.locator('input[type="time"]');
          if (await nativeTime.count()) await expect(nativeTime).toHaveValue('09:30');
          // Native time glyphs follow the host OS's 12/24-hour preference,
          // even with a fixed browser locale. Isolate only that presentation.
          await expect(surface).toHaveScreenshot(`${host}-${theme}-${width}-${scene}.png`, {
            animations: 'disabled', maxDiffPixelRatio: 0.001,
            stylePath: nativeTimeStyles,
            mask: [nativeTime], maskColor: '#888888',
          });
          expect(await surface.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

        });
      }
    }
  }
}

// Keyboard behavior runs independently of screenshot comparisons.
for (const host of ['plugin', 'pwa']) {
  for (const scene of ['project', 'weekly', 'date']) {
    test(`${host} ${scene} keyboard behavior`, async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-09-05T10:00:00Z'));
      await page.goto(`/?host=${host}&theme=light&scene=${scene}`);
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
      if (scene === 'date') {
        const time = page.locator('input[type="time"]');
        await expect(time).toHaveValue('09:30');
        await time.focus(); await expect(time).toBeFocused();
        await time.fill('14:45');
        await expect(page.getByTestId('result')).toHaveText('14:45');
        // A native time field may expose hour, minute and AM/PM tab stops.
        for (let part = 0; part < 5 && await time.evaluate(el => el === document.activeElement); part++) await page.keyboard.press('Tab');
        await expect(time).not.toBeFocused();
      }
    });
  }
}
