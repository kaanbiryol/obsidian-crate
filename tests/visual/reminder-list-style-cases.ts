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
      await expect(first).toHaveCSS('border-radius', '8px');
      await expect(page.getByRole('heading', { name: 'Overdue', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Due today', exact: true })).toHaveCount(0);
      for (const pill of await metadata.all()) {
        await expect(pill).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(pill).toHaveCSS('border-top-width', '0px');
      }
      const geometry = await first.evaluate(el => ({
        target: el.querySelector('.premium-checkbox')!.getBoundingClientRect().width,
      }));
      expect(geometry.target).toBeGreaterThanOrEqual(44);
      const projects = page.getByTestId('projects-list');
      const projectSurface = projects.locator('.premium-project-content').first();
      for (const surface of await projects.locator('.premium-project-content, .premium-project-group').all()) {
        await expect(surface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(surface).toHaveCSS('border-radius', await surface.evaluate(el => el.classList.contains('premium-project-content')) ? '8px' : '0px');
        await expect(surface).toHaveCSS('border-top-width', '0px');
      }
      for (const tree of await projects.locator('.premium-project-tree').all()) {
        const branches = tree.locator(':scope > li, :scope > li > .premium-project-tree-row');
        const count = await branches.count();
        for (let index = 0; index < count; index++) {
          expect(await branches.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
        }
      }
      for (const row of await projects.locator('.premium-project-tree-row').all()) {
        expect(await row.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      }
      await expect(projects.locator('.premium-project-stat').first()).toHaveCSS('font-weight', '400');
      const zeroProject = projects.getByRole('button', { name: 'Open Work', exact: true });
      await expect(zeroProject.locator('.premium-project-percentage')).toHaveText('0%');
      await expect(zeroProject.getByRole('progressbar')).toHaveCount(0);
      const progressingProject = projects.getByRole('button', { name: 'Open Product launch', exact: true });
      await expect(progressingProject.getByRole('progressbar')).toBeVisible();
      const progressGeometry = await progressingProject.evaluate(el => {
        const bar = el.querySelector('.crate-progress-meter')!.getBoundingClientRect();
        const percent = el.querySelector('.premium-project-percentage')!.getBoundingClientRect();
        const chevron = el.querySelector('.premium-project-chevron-slot')!.getBoundingClientRect();
        return { barWidth: bar.width, gap: percent.left - bar.right,
          percentOffset: Math.abs(bar.top + bar.height / 2 - percent.top - percent.height / 2),
          chevronOffset: Math.abs(bar.top + bar.height / 2 - chevron.top - chevron.height / 2) };
      });
      expect(progressGeometry.barWidth).toBe(56);
      expect(progressGeometry.gap).toBeGreaterThanOrEqual(8);
      expect(progressGeometry.percentOffset).toBeLessThan(1);
      expect(progressGeometry.chevronOffset).toBeLessThan(1);
      expect(await zeroProject.locator('.premium-project-progress').evaluate(el =>
        el.getBoundingClientRect().width - el.querySelector('.premium-project-percentage')!.getBoundingClientRect().width)).toBeLessThan(1);

      const percentageRight = async (button: typeof zeroProject) => button.locator('.premium-project-percentage').evaluate(el => el.getBoundingClientRect().right);
      expect(Math.abs(await percentageRight(zeroProject) - await percentageRight(progressingProject))).toBeLessThan(1);
      await page.mouse.move(0, 0);
      const financeRow = projects.getByRole('button', { name: 'Open Personal/Finance', exact: true });
      await expect(financeRow.locator('.premium-project-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(financeRow.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const parentRow = projects.getByRole('button', { name: 'Open Personal', exact: true }).locator('..');
      await expect(parentRow).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const expandButton = projects.getByRole('button', { name: 'Collapse Personal subprojects', exact: true });
      await expandButton.hover();
      const disclosureGeometry = await parentRow.evaluate(el => {
        const button = el.querySelector('.premium-project-expand')!.getBoundingClientRect();
        const progress = el.querySelector('.premium-project-progress')!.getBoundingClientRect();
        return { gap: button.left - progress.right, width: button.width, height: button.height };
      });
      expect(disclosureGeometry.gap).toBeGreaterThanOrEqual(8);
      expect(disclosureGeometry.width).toBeGreaterThanOrEqual(44);
      expect(disclosureGeometry.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(await percentageRight(projects.getByRole('button', { name: 'Open Personal', exact: true })) - await percentageRight(zeroProject))).toBeLessThan(1);
      expect(await parentRow.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await projects.getByRole('button', { name: 'Collapse Personal subprojects', exact: true }).click();
      await expect(projects.getByRole('button', { name: 'Open Personal/Finance', exact: true })).toBeHidden();
      expect(await parentRow.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await projects.getByRole('button', { name: 'Expand Personal subprojects', exact: true }).click();
      await expect(projects.getByRole('button', { name: 'Open Personal/Finance', exact: true })).toBeVisible();
      for (const list of [page.locator('.reminders-view-scroll'), page.getByTestId('embedded-list'), page.getByTestId('reorderable-list'),
        ...await page.getByTestId('grouped-list').locator('section').all()]) {
        const rows = list.locator('.premium-reminder-content');
        for (let index = 0; index < await rows.count(); index++) {
          expect(await rows.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
        }
      }
      const readingRows = page.locator('.crate-reading__item');
      await expect(readingRows.first()).toHaveCSS('border-radius', '8px');
      await expect(readingRows.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const list of await page.locator('.crate-reading__list').all()) {
        const rows = list.locator('.crate-reading__item');
        const count = await rows.count();
        for (let index = 0; index < count; index++) {
          expect(await rows.nth(index).evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
        }
      }
      await page.getByRole('searchbox', { name: 'Search reading' }).fill('field guide');
      await expect(readingRows).toHaveCount(1);
      expect(await readingRows.first().evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await page.getByRole('searchbox', { name: 'Search reading' }).fill('');
      const highlights = page.locator('.crate-reading-highlights__card');
      // Every host/presentation shares the same row rhythm, including embedded
      // and reorderable reminders. Hierarchy and passage reading are exceptions.
      const checkSpacing = async () => {
        const standardRows = [first, projectSurface, readingRows.first().locator('.crate-reading__open'),
          page.getByTestId('embedded-list').locator('.premium-reminder-content').first(),
          page.getByTestId('reorderable-list').locator('.premium-reminder-content').first()];
        const padding = await first.evaluate(el => getComputedStyle(el).padding);
        for (const row of standardRows) {
          await expect(row).toHaveCSS('padding', padding);
          expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        const parentPadding = await projectSurface.evaluate(el => parseFloat(getComputedStyle(el).paddingTop));
        const child = financeRow.locator('.premium-project-content');
        expect(await child.evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBeLessThan(parentPadding);
        expect((await child.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await highlights.first().evaluate(el => parseFloat(getComputedStyle(el).paddingTop))).toBeGreaterThan(parentPadding);
        for (const row of await page.locator('.premium-reminder-content').all()) {
          const bounds = await row.evaluate(el => {
            const content = el.getBoundingClientRect();
            const checkbox = el.querySelector('.premium-checkbox')!.getBoundingClientRect();
            return { top: checkbox.top - content.top, bottom: content.bottom - checkbox.bottom, height: checkbox.height };
          });
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeGreaterThanOrEqual(0);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
      };
      await checkSpacing();
      await expect(highlights.first()).toHaveCSS('border-top-width', '0px');
      expect(await highlights.first().evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      expect(await highlights.last().evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await expect(page.getByTestId('embedded-list').locator('.reminders-list')).toHaveCSS('gap', '0px');
      await expect(page.locator('.reminder-render-item').first()).toHaveCSS('margin-bottom', '0px');
      await expect(page.locator('.reorderable-reminder-item').first()).toHaveCSS('margin-bottom', '0px');
      expect(await first.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('flat.png'), fullPage: true });
      await projects.screenshot({ path: testInfo.outputPath('projects-flat.png') });

      await picker.selectOption('cards');
      await page.mouse.move(0, 0);
      await expect(first).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(first).toHaveCSS('border-top-width', '1px');
      await expect(page.locator('.reminder-render-item').first()).toHaveCSS('margin-bottom', '8px');
      await expect(metadata.first()).toHaveCSS('border-top-width', '1px');
      await expect(projectSurface).toHaveCSS('border-top-width', '1px');
      await expect(projects.locator('.premium-project-group').first()).toHaveCSS('border-top-width', '1px');
      await expect(readingRows.first()).toHaveCSS('border-top-width', '1px');
      await expect(highlights.first()).toHaveCSS('border-top-width', '1px');
      await expect(readingRows.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await checkSpacing();
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
      await expect(page.locator('.reminders-view-scroll [data-reminder-id="1"]')).toHaveCount(0);
      const completed = page.getByTestId('embedded-list').locator('.premium-reminder-content').first();
      await expect(completed.getByRole('checkbox')).toBeChecked();
      await expect(completed.locator('.premium-reminder-title')).toHaveCSS('text-decoration-line', 'line-through');
      for (const el of await page.locator('.premium-reminder-content').all()) {
        expect(await el.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    });
  }
}
