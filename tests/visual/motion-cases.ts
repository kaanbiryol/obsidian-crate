import { expect, test } from '@playwright/test';

export function registerMotionTests() {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'no-preference' }); });
  for (const host of ['plugin', 'pwa']) {
    test(`${host} content is usable during a reversible empty-state dissolve`, async ({ page }) => {
      await page.goto(`/?host=${host}&scene=motion`);
      const fixture = page.locator('.motion-fixture');
      await expect(fixture.getByText('No reminders', { exact: true })).toBeVisible();
      const opening = await fixture.evaluate(async root => {
        const frame = () => new Promise(requestAnimationFrame);
        (root.querySelector('[data-motion-toggle]') as HTMLElement).click();
        await frame();
        const action = root.querySelector<HTMLElement>('[data-live-action]')!;
        const empty = root.querySelector('.reminders-empty-state')!;
        const list = root.querySelector<HTMLElement>('.reminders-view-scroll')!;
        action.click();
        return { mounted: !!action, oldInert: !!empty.closest('[inert]'), newInert: list.inert,
          oldPainted: Number(getComputedStyle(empty.parentElement!).opacity) > 0,
          listHeight: list.getBoundingClientRect().height };
      });
      expect(opening).toMatchObject({ mounted: true, oldInert: true, newInert: false, oldPainted: true });
      expect(opening.listHeight).toBeCloseTo(320, 0);
      await expect(fixture.getByRole('status', { name: 'List activations' })).toHaveText('1');
      for (let i = 0; i < 3; i++) {
        await fixture.locator('[data-motion-toggle]').evaluate(async button => {
          (button as HTMLElement).click();
          await new Promise(resolve => setTimeout(resolve, 35));
          (button as HTMLElement).click();
        });
        await expect(fixture.locator('.reminders-empty-state')).toHaveCount(0);
        await expect(fixture.getByRole('button', { name: 'Open reminder' })).toBeVisible();
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await fixture.getByRole('button', { name: 'Toggle list' }).click();
      await expect(fixture.locator('.reminders-view-scroll')).toHaveCount(0);
      await expect(fixture.getByText('No reminders', { exact: true })).toBeVisible();
    });

    test(`${host} controls settle without overshoot and centered dialogs stay still`, async ({ page }) => {
      await page.goto(`/?host=${host}&scene=motion`);
      const fixture = page.locator('.motion-fixture');
      await fixture.getByRole('button', { name: 'Toggle completion' }).click();
      const samples = await fixture.locator('.premium-checkbox-icon').evaluate(element => {
        const animations = element.getAnimations();
        animations.forEach(animation => animation.pause());
        const scales = [0, 30, 60, 90, 120].map(time => {
          animations.forEach(animation => { animation.currentTime = time; });
          return new DOMMatrixReadOnly(getComputedStyle(element).transform).a;
        });
        animations.forEach(animation => animation.finish());
        return scales;
      });
      expect(samples.every(scale => scale >= .85 && scale <= 1)).toBe(true);
      const progress = fixture.locator('.crate-progress-meter-fill');
      await expect(progress).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      await fixture.getByRole('button', { name: 'Toggle completion' }).click();
      await expect(progress).toHaveCSS('transform', 'matrix(0.25, 0, 0, 1, 0, 0)');
      expect(await progress.evaluate(el => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width)).toBeCloseTo(.25, 2);
      if (host === 'plugin') {
        const transforms = await fixture.evaluate(async root => {
          (Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Toggle dialog') as HTMLElement).click();
          const transforms = [], start = performance.now();
          while (performance.now() - start < 260) {
            await new Promise(requestAnimationFrame);
            const popup = root.querySelector('.base-modal-surface.is-centered');
            if (popup) transforms.push(getComputedStyle(popup).transform);
          }
          return transforms;
        });
        expect(transforms.length).toBeGreaterThan(1);
        expect(transforms.every(transform => transform === 'none')).toBe(true);
        await fixture.getByRole('button', { name: 'Close dialog' }).click();
        await expect(fixture.getByRole('dialog')).toHaveCount(0);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await fixture.getByRole('button', { name: 'Toggle completion' }).click();
      await expect(fixture.locator('.premium-checkbox-icon')).toHaveCSS('animation-name', 'none');
      await expect(progress).toHaveCSS('transition-duration', '0s');
    });
  }
}
