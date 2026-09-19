import { expect, test } from '@playwright/test';

for (const host of ['plugin', 'pwa']) {
  test(`${host} live metadata stays readable through interrupted updates`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/?host=${host}&scene=metadata`);
    const label = page.locator('[data-picker="project"] .is-animated');
    await expect(label).toHaveText('Work');
    expect(await label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    await page.getByRole('textbox', { name: 'Project label' }).fill('Personal errands');
    // Pause mid-transition to exercise another update before the first settles.
    expect(await label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(2);
    await label.evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => {
      animation.pause();
      animation.currentTime = 60;
      animation.play();
    }));
    await page.getByRole('textbox', { name: 'Project label' }).fill('Personal');
    await expect(label).toHaveText('Personal');
    expect(await label.evaluate(el => Number(getComputedStyle(el.firstElementChild!).opacity))).toBeGreaterThanOrEqual(0.8);
    await expect.poll(() => label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await label.evaluate(el => el.style.width)).toBe('');
    await page.setViewportSize({ width: 320, height: 844 });
    const height = await label.evaluate(el => el.getBoundingClientRect().height);
    for (const value of ['A very long project name that must stay on one line on a narrow screen', 'Work']) {
      await page.getByRole('textbox', { name: 'Project label' }).fill(value);
      const heights = await label.evaluate(el => {
        const animations = el.getAnimations({ subtree: true });
        animations.forEach(animation => animation.pause());
        const samples = [0, 50, 100, 150, 199].map(time => {
          animations.forEach(animation => { animation.currentTime = time; });
          return {
            label: el.getBoundingClientRect().height,
            text: el.firstElementChild!.getBoundingClientRect().height,
          };
        });
        animations.forEach(animation => animation.finish());
        return samples;
      });
      for (const sample of heights) {
        expect(sample.label).toBeCloseTo(height, 1);
        expect(sample.text).toBeCloseTo(height, 1);
      }
    }
  });

  test(`${host} reduced motion stops live label animations`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/?host=${host}&scene=metadata`);
    const label = page.locator('[data-picker="date"] .is-animated');
    await page.getByRole('textbox', { name: 'Date label' }).fill('Tomorrow at 10:30');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    await page.getByRole('textbox', { name: 'Date label' }).fill('Friday');
    await expect(label).toHaveText('Friday');
    expect(await label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.body.classList.add('reduce-motion'));
    await page.getByRole('textbox', { name: 'Date label' }).fill('Saturday');
    expect(await label.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  });
}
