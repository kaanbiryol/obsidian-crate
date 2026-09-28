import { test, expect } from '@playwright/test';

export function registerPluginNavigationTests() {
    for (const width of [320, 1280]) {
      test(`plugin dock, date views, feature retention and project Back at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/?host=plugin&scene=navigation&theme=light');
        const active = page.locator('.plugin-workspace-panel[data-active="true"]');
        await active.getByRole('button', { name: 'Crate settings', exact: true }).click();
        await expect(page.getByTestId('result')).toHaveText('settings');
        await active.getByRole('button', { name: 'Reminders', exact: true }).click();
        await expect(active.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await active.getByRole('button', { name: 'Upcoming', exact: true }).click();
        await expect(active.getByRole('button', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(active.getByRole('button', { name: 'Reminders', exact: true })).toHaveAttribute('aria-current', 'page');
        await active.getByRole('button', { name: 'Projects', exact: true }).click();
        const project = active.locator('[data-action="open-project"]').last();
        await project.scrollIntoViewIfNeeded();
        const scroller = active.locator('.pwa-navigation-viewport .reminders-view-scroll');
        const scroll = await scroller.evaluate(el => el.scrollTop);
        const title = await project.getAttribute('data-project');
        await project.click();
        await expect(active.locator('.pwa-navigation-viewport')).toHaveAttribute('inert', '');
        await active.getByRole('button', { name: 'Add reminder', exact: true }).click();
        await expect(page.getByTestId('result')).toHaveText(title!);
        await active.getByRole('button', { name: 'Back to projects', exact: true }).click();
        await expect(active.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'false');
        expect(await scroller.evaluate(el => el.scrollTop)).toBe(scroll);
        await expect(project).toBeFocused();
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        const search = active.getByRole('searchbox', { name: 'Search reading' });
        await search.fill('pleasure');
        await active.getByRole('button', { name: 'Inbox', exact: true }).click();
        await active.getByRole('button', { name: 'Reading', exact: true }).click();
        await expect(search).toHaveValue('pleasure');
        await active.locator('.crate-reading__open').first().click();
        await expect(active.locator('.crate-reading__reader-pane')).toBeVisible();
        await active.getByRole('button', { name: 'Back to reading', exact: true }).click();
        await expect(search).toHaveValue('pleasure');

        const dock = active.locator('.pwa-dock');
        const bounds = await dock.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(801);
      });
    }
    test('dock picker supports keyboard selection, dismissal and disabled features', async ({ page }) => {
      await page.goto('/?host=plugin&scene=navigation&theme=dark');
      const active = page.locator('.plugin-workspace-panel[data-active="true"]');
      await active.locator('[data-dock-group]').press('ArrowDown');
      await expect(page.getByRole('dialog', { name: 'More views' })).toBeVisible();
      await page.getByRole('button', { name: 'Favorites', exact: true }).click();
      await expect(active.locator('.view-header-title')).toHaveText('Favorites');
      await active.locator('[data-dock-group]').press('ArrowDown');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'More views' })).toBeHidden();
      await expect(active.locator('[data-dock-group]')).toBeFocused();
      await page.evaluate(() => window.dispatchEvent(new Event('disable-reading')));
      await expect(active.locator('.plugin-reminders-navigation')).toBeVisible();
      await expect(active.getByRole('button', { name: 'Favorites', exact: true })).toHaveCount(0);
    });
    test('compact project sheet retains header, Back and local create action', async ({ page }) => {
      await page.goto('/?host=plugin&scene=navigation&compact&theme=dark');
      await expect(page.locator('.crate-modal-header')).toBeVisible();
      await page.getByRole('button', { name: 'Crate settings', exact: true }).click();
      await expect(page.getByTestId('result')).toHaveText('settings');
      await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
      await expect(page.getByTestId('result')).toHaveText('Project 01');
      await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
      await expect(page.locator('[data-action="open-project"]').first()).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    });
    test('held dock selection and rapid navigation settle with reduced motion changes', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto('/?host=plugin&scene=navigation&theme=dark');
      const active = page.locator('.plugin-workspace-panel[data-active="true"]');
      const group = active.locator('[data-dock-group]');
      const bounds = await group.boundingBox();
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
      await page.mouse.down();
      const favorite = page.getByRole('dialog', { name: 'More views' }).getByRole('button', { name: 'Favorites', exact: true });
      await expect(favorite).toBeVisible();
      const target = await favorite.boundingBox();
      await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(active.locator('.view-header-title')).toHaveText('Favorites');
      for (let index = 0; index < 3; index++) {
        await active.getByRole('button', { name: 'Reminders', exact: true }).click();
        await active.getByRole('button', { name: 'Upcoming', exact: true }).click();
        await active.getByRole('button', { name: 'Today', exact: true }).click();
        await active.getByRole('button', { name: 'Favorites', exact: true }).click();
      }
      await page.evaluate(() => document.body.classList.add('reduce-motion'));
      await active.getByRole('button', { name: 'Projects', exact: true }).click();
      await active.locator('[data-action="open-project"]').first().click();
      await expect(active.locator('.pwa-navigation-screen')).toHaveCSS('transform', 'none');
      await active.getByRole('button', { name: 'Back to projects', exact: true }).click();
      await expect(active.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'false');
      await expect(active.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
    });

}
