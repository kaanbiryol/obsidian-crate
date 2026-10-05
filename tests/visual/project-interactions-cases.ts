import { test, expect, type Locator, type Page } from '@playwright/test';

async function scrollPosition(page: Page) {
  return { ancestor: await page.getByTestId('picker-ancestor').evaluate(el => el.scrollTop), window: await page.evaluate(() => window.scrollY) };
}

async function expectOptionVisible(option: Locator, scroller: Locator) {
  const row = (await option.boundingBox())!, list = (await scroller.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(list.y);
  expect(row.y + row.height).toBeLessThanOrEqual(list.y + list.height);
}

export function registerProjectInteractionTests() {
  for (const host of ['plugin', 'pwa']) {
    test(`${host}: picker centers selection, contains scrolling and selects the clicked row`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 640 });
      await page.goto(`/?host=${host}&scene=project-interactions`);
      const scroller = page.locator('.project-picker-scroll');
      await expect(scroller).toBeVisible();
      await page.getByTestId('picker-ancestor').evaluate(el => { el.scrollTop = 96; });
      const selected = page.getByRole('option', { name: 'Project 18', exact: true });
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      await expectOptionVisible(selected, scroller);
      const row = (await selected.boundingBox())!, list = (await scroller.boundingBox())!;
      expect(Math.abs(row.y + row.height / 2 - list.y - list.height / 2)).toBeLessThan(3);
      const before = await scrollPosition(page);
      const initial = await scroller.evaluate(el => el.scrollTop);
      await scroller.hover();
      await page.mouse.wheel(0, 180);
      await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(initial);
      // At the inner boundary a following wheel must not chain to the editor.
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.mouse.wheel(0, 300);
      await scroller.dispatchEvent('touchmove', { bubbles: true, cancelable: true });
      await expect(page.getByRole('status', { name: 'Ancestor gestures' })).toHaveText('0,0');
      await expect.poll(() => scrollPosition(page)).toEqual(before);
      const last = page.getByRole('option', { name: 'Project 36', exact: true });
      await expectOptionVisible(last, scroller);
      await last.click();
      await expect(scroller).toHaveCount(0);
      await expect(page.getByRole('status', { name: 'Selected project' })).toHaveText('Project 36');
    });

    for (const theme of ['light', 'dark']) for (const placement of ['top', 'bottom']) test(`${host} ${theme}: autocomplete ${placement} stays inside its boundary and scrolls only suggestions`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 640 });
      await page.goto(`/?host=${host}&theme=${theme}&scene=project-interactions&mode=autocomplete&placement=${placement}`);
      const input = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      await expect(input).toBeVisible();
      await page.getByTestId('picker-ancestor').evaluate(el => { el.scrollTop = 96; });
      await input.click();
      await input.pressSequentially('#Project');
      const suggestions = page.getByRole('listbox', { name: 'Project suggestions' });
      await expect(suggestions).toBeVisible();
      await expect(suggestions).toHaveAttribute('data-placement', placement);
      const bounds = (await suggestions.boundingBox())!;
      const surface = (await page.getByTestId('picker-surface').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(surface.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(surface.x + surface.width);
      expect(bounds.y).toBeGreaterThanOrEqual(host === 'plugin' ? surface.y : 0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(host === 'plugin' ? surface.y + surface.height : 640);
      const before = await scrollPosition(page);
      for (let i = 0; i < 9; i++) await input.press('ArrowDown');
      const last = suggestions.getByRole('option').last();
      await expect(last).toHaveAttribute('aria-selected', 'true');
      await expect(last).toHaveCSS('box-shadow', 'none');
      expect(await last.evaluate(el => getComputedStyle(el).backgroundColor))
        .not.toBe(await suggestions.getByRole('option').first().evaluate(el => getComputedStyle(el).backgroundColor));
      await expectOptionVisible(last, suggestions);
      expect(await suggestions.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      expect(await scrollPosition(page)).toEqual(before);
      await suggestions.hover();
      await page.mouse.wheel(0, 300);
      await suggestions.dispatchEvent('touchmove', { bubbles: true, cancelable: true });
      await expect(page.getByRole('status', { name: 'Ancestor gestures' })).toHaveText('0,0');
      expect(await scrollPosition(page)).toEqual(before);
      await input.press('Enter');
      await expect(suggestions).toHaveCount(0);
      await expect(input).toContainText('Project 10');
    });
  }

  test('plugin: the title takes focus on the opening frames of an animated editor', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/?host=plugin&scene=project-interactions&mode=overlay&closed=1&motion=1');
    const opener = page.getByRole('button', { name: 'Open reminder editor', exact: true });
    await opener.focus();
    const focused = await opener.evaluate(async button => {
      const root = button.getRootNode() as ShadowRoot;
      (button as HTMLElement).click();
      // React mounts the portal before the editor's next-paint focus request.
      for (let frame = 0; frame < 6; frame++) {
        await new Promise(requestAnimationFrame);
        const title = root.querySelector('[role="textbox"][aria-label="Reminder title"]');
        if (title) {
          await new Promise(requestAnimationFrame);
          return root.activeElement === title;
        }
      }
      return false;
    });
    expect(focused).toBe(true);
    await page.getByRole('button', { name: 'Close reminder editor' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  for (const width of [320, 960]) test(`plugin ${width}: a foreground project picker protects the retained editor and restores it after selection`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?host=plugin&scene=project-interactions&mode=overlay');
    const input = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await expect(input).toBeFocused();
    await input.click();
    await input.pressSequentially('Keep this reminder');
    await expect(input).toHaveText('Keep this reminder');
    await page.getByRole('button', { name: /Project 18/ }).click();
    const selected = page.getByRole('option', { name: 'Project 18', exact: true });
    await expect(selected).toBeVisible();
    const picker = (await page.getByRole('dialog', { name: 'Select project', exact: true }).boundingBox())!;
    expect(picker.width).toBeLessThanOrEqual(380);
    expect(picker.x).toBeGreaterThanOrEqual(20);
    expect(picker.x + picker.width).toBeLessThanOrEqual(width - 20);
    await selected.focus();
    await expect(selected).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const next = page.getByRole('option', { name: 'Project 19', exact: true });
    await expect(next).toBeFocused();
    expect(await input.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return el.contains((el.getRootNode() as Document | ShadowRoot).elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(false);
    await expect(input).toHaveText('Keep this reminder');
    await next.click();
    await expect(page.locator('.project-picker-scroll')).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toContainText('Keep this reminder');
    await expect(page.getByRole('button', { name: /Project 19/ })).toBeVisible();
  });
}
