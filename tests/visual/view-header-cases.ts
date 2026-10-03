import { expect, test, type Locator } from '@playwright/test';

async function headerGeometry(header: Locator) {
  return header.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>('.view-header-title')!;
    const meta = element.querySelector<HTMLElement>('.view-header-meta')!;
    const count = element.querySelector<HTMLElement>('.view-header-count')!;
    const style = getComputedStyle(element);
    return {
      top: bounds.top,
      height: bounds.height,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      titleTop: title.getBoundingClientRect().top - bounds.top,
      titleLeft: title.getBoundingClientRect().left - bounds.left,
      titleHeight: title.getBoundingClientRect().height,
      titleFont: getComputedStyle(title).font,
      metaTop: meta.getBoundingClientRect().top - bounds.top,
      metaHeight: meta.getBoundingClientRect().height,
      countTop: count.getBoundingClientRect().top - bounds.top,
      countFont: getComputedStyle(count).font,
    };
  });
}

export function registerViewHeaderTests() {
  for (const width of [393, 759, 760, 1280]) for (const theme of ['light', 'dark']) {
    test(`plugin primary headers align at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.setFixedTime(new Date('2026-10-03T12:00:00Z'));
      await page.goto(`/?host=plugin&scene=navigation&theme=${theme}&loading`);
      const active = page.locator('.plugin-workspace-panel[data-active="true"]');
      const header = active.locator('.view-header');
      await expect(active.getByRole('status', { name: 'Loading reminders' })).toBeVisible();
      await expect(header.locator('.view-header-meta')).toHaveClass(/is-reserved/);
      const opening = await headerGeometry(header);
      await page.evaluate(() => window.dispatchEvent(new Event('finish-reminder-loading')));
      await expect(header.locator('.view-header-meta')).not.toHaveClass(/is-reserved/);
      expect(await headerGeometry(header)).toEqual(opening);
      // Include a community theme's larger heading size, not only fixture defaults.
      for (const fontSize of [null, '32px']) {
        if (fontSize) await page.locator('.crate-reminders-ui').evaluate((root, size) => {
          (root as HTMLElement).style.setProperty('--reminder-font-title', size);
        }, fontSize);
        await active.getByRole('button', { name: 'Inbox', exact: true }).click();
        await expect(header.locator('h1')).toHaveText('Inbox');
        const inbox = await headerGeometry(header);
        const narrow = width <= 759;
        expect(inbox.padding).toEqual([narrow ? '4px' : '12px', '18px', narrow ? '8px' : '10px', '18px']);
        expect(inbox.metaHeight).toBe(narrow ? 20 : 24);
        for (const label of ['Reminders', 'Projects', 'Reading']) {
          await active.getByRole('button', { name: label, exact: true }).click();
          await expect(header.locator('h1')).toHaveText(label);
          await expect.poll(() => headerGeometry(header)).toEqual(inbox);
          if (label === 'Reminders') {
            const badge = header.locator('.view-header-overdue');
            await expect(badge).toBeVisible();
            const bounds = await badge.boundingBox();
            const meta = await header.locator('.view-header-meta').boundingBox();
            expect(bounds!.y).toBeCloseTo(meta!.y, 1);
            expect(bounds!.height).toBeCloseTo(meta!.height, 1);
          }
        }
      }
    });
  }
}
