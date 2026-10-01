import { test, expect } from '@playwright/test';

export function reminderListStyleCases() {
  for (const host of ['plugin', 'pwa']) for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    test(`${host} ${theme} ${width} reminder styles`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.clock.setFixedTime(new Date('2026-09-05T10:00:00Z'));
      await page.goto(`/?host=${host}&theme=${theme}&scene=list-style`);
      const picker = page.getByRole('combobox', { name: 'Reminder list style' });
      const first = page.locator('.reminders-view .premium-reminder-content').first();
      const metadata = first.locator('.premium-pill');
      await expect(picker).toHaveValue('flat');
      await expect(first).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(first).toHaveCSS('border-radius', '0px');
      for (const pill of await metadata.all()) {
        await expect(pill).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(pill).toHaveCSS('border-top-width', '0px');
      }
      const geometry = await first.evaluate(el => ({
        divider: parseFloat(getComputedStyle(el, '::after').left),
        title: el.querySelector('.premium-reminder-title')!.getBoundingClientRect().left - el.getBoundingClientRect().left,
        target: el.querySelector('.premium-checkbox')!.getBoundingClientRect().width,
      }));
      expect(Math.abs(geometry.divider - geometry.title)).toBeLessThan(1);
      expect(geometry.target).toBeGreaterThanOrEqual(44);
      await expect(page.getByTestId('embedded-list').locator('.reminders-list')).toHaveCSS('gap', '0px');
      await expect(page.locator('.reminder-render-item').first()).toHaveCSS('margin-bottom', '0px');
      expect(await first.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('flat.png'), fullPage: true });

      await picker.selectOption('cards');
      await page.mouse.move(0, 0);
      await expect(first).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(first).toHaveCSS('border-top-width', '1px');
      await expect(metadata.first()).toHaveCSS('border-top-width', '1px');
      await page.reload();
      await expect(picker).toHaveValue('cards');
      await expect(first).toHaveCSS('border-top-width', '1px');
      await page.screenshot({ path: testInfo.outputPath('cards.png'), fullPage: true });

      await picker.selectOption('flat');
      const row = page.locator('.reminders-view .sidebar-reminder-card-wrapper').first();
      await page.keyboard.press('Tab');
      await row.focus();
      await expect(row).toBeFocused();
      await expect.poll(() => (host === 'plugin' ? first : row).evaluate(el => {
        const style = getComputedStyle(el);
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      })).toBe(true);
      await row.press('Enter');
      await expect(page.getByRole('status', { name: 'Edited reminder' })).toHaveText('1');
      await first.getByRole('checkbox').click();
      await expect(first.getByRole('checkbox')).toBeChecked();
      await expect(first.locator('.premium-reminder-title')).toHaveCSS('text-decoration-line', 'line-through');
      for (const el of await page.locator('.premium-reminder-content').all()) {
        expect(await el.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    });
  }
}
