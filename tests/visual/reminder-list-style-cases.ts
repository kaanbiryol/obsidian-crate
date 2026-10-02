import { test, expect } from '@playwright/test';

export function reminderListStyleCases() {
  for (const host of ['plugin', 'pwa']) for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    test(`${host} ${theme} ${width} reminder styles`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.clock.setFixedTime(new Date('2026-09-21T10:00:00Z'));
      await page.goto(`/?host=${host}&theme=${theme}&scene=list-style`);
      const picker = page.getByRole('combobox', { name: 'List style', exact: true });
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
      const projects = page.getByTestId('projects-list');
      const projectSurface = projects.locator('.premium-project-content').first();
      for (const surface of await projects.locator('.premium-project-content, .premium-project-group').all()) {
        await expect(surface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(surface).toHaveCSS('border-radius', '0px');
        await expect(surface).toHaveCSS('border-top-width', '0px');
      }
      for (const tree of await projects.locator('.premium-project-tree').all()) {
        const branches = tree.locator(':scope > li');
        const count = await branches.count();
        for (let index = 0; index < count; index++) {
          expect(await branches.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe(index === count - 1 ? 'none' : '""');
        }
      }
      const projectInset = await projectSurface.evaluate(el => parseFloat(getComputedStyle(el.closest('li')!, '::after').left) -
        (el.querySelector('.premium-project-name')!.getBoundingClientRect().left - el.getBoundingClientRect().left));
      expect(Math.abs(projectInset)).toBeLessThan(1);
      const parentRow = projects.getByRole('button', { name: 'Open Personal', exact: true }).locator('..');
      expect(await parentRow.evaluate(el => getComputedStyle(el, '::after').content)).toBe('""');
      await projects.getByRole('button', { name: 'Collapse Personal subprojects', exact: true }).click();
      await expect(projects.getByRole('button', { name: 'Open Personal/Finance', exact: true })).toBeHidden();
      expect(await parentRow.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await projects.getByRole('button', { name: 'Expand Personal subprojects', exact: true }).click();
      await expect(projects.getByRole('button', { name: 'Open Personal/Finance', exact: true })).toBeVisible();
      for (const list of [page.locator('.reminders-view-scroll'), page.getByTestId('embedded-list'), page.getByTestId('reorderable-list'),
        ...await page.getByTestId('grouped-list').locator('section').all()]) {
        const rows = list.locator('.premium-reminder-content');
        for (let index = 0; index < await rows.count(); index++) {
          expect(await rows.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe(index === await rows.count() - 1 ? 'none' : '""');
        }
      }
      const readingRows = page.locator('.crate-reading__item');
      await expect(readingRows.first()).toHaveCSS('border-radius', '0px');
      await expect(readingRows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const list of await page.locator('.crate-reading__list').all()) {
        const rows = list.locator('.crate-reading__item');
        const count = await rows.count();
        for (let index = 0; index < count; index++) {
          expect(await rows.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe(index === count - 1 ? 'none' : '""');
        }
        if (count > 1) {
          const inset = await rows.first().evaluate(el => parseFloat(getComputedStyle(el, '::after').left) -
            (el.querySelector('strong')!.getBoundingClientRect().left - el.getBoundingClientRect().left));
          expect(Math.abs(inset)).toBeLessThan(1);
        }
      }
      await page.getByRole('searchbox', { name: 'Search reading' }).fill('field guide');
      await expect(readingRows).toHaveCount(1);
      expect(await readingRows.first().evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await page.getByRole('searchbox', { name: 'Search reading' }).fill('');
      const highlights = page.locator('.crate-reading-highlights__card');
      await expect(highlights.first()).toHaveCSS('border-top-width', '0px');
      expect(await highlights.first().evaluate(el => getComputedStyle(el, '::after').content)).toBe('""');
      expect(await highlights.last().evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await expect(page.getByTestId('embedded-list').locator('.reminders-list')).toHaveCSS('gap', '0px');
      await expect(page.locator('.reminder-render-item').first()).toHaveCSS('margin-bottom', '0px');
      expect(await first.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('flat.png'), fullPage: true });

      await picker.selectOption('cards');
      await page.mouse.move(0, 0);
      await expect(first).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(first).toHaveCSS('border-top-width', '1px');
      await expect(metadata.first()).toHaveCSS('border-top-width', '1px');
      await expect(projectSurface).toHaveCSS('border-top-width', '1px');
      await expect(projects.locator('.premium-project-group').first()).toHaveCSS('border-top-width', '1px');
      await expect(readingRows.first()).toHaveCSS('border-top-width', '1px');
      await expect(highlights.first()).toHaveCSS('border-top-width', '1px');
      await expect(readingRows.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await page.reload();
      await expect(picker).toHaveValue('cards');
      await expect(first).toHaveCSS('border-top-width', '1px');
      await expect(readingRows.first()).toHaveCSS('border-top-width', '1px');
      await page.screenshot({ path: testInfo.outputPath('cards.png'), fullPage: true });

      await picker.selectOption('flat');
      await expect(readingRows.first()).toHaveCSS('border-top-width', '0px');
      const projectButton = projects.getByRole('button', { name: 'Open Work', exact: true });
      await page.keyboard.press('Tab');
      await projectButton.focus();
      await expect(projectButton).toBeFocused();
      await expect(host === 'plugin' ? projectButton.locator('.premium-project-content') : projectButton).toHaveCSS('outline-style', 'solid');
      await projectButton.press('Enter');
      await expect(page.getByRole('status', { name: 'Opened project' })).toHaveText('Work');
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
