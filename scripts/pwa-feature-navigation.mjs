/** Exercise the visible navigation in both connected and setup screens. */
export const featureNavigationTarget = page => page.locator('.crate-feature-panel[data-active="true"] [data-dock-active="true"]:visible, .crate-feature-panel[data-active="true"] .pwa-feature-switch-button:visible, [data-feature-recovery-switch]:visible');
export async function switchFeature(page, destination) {
  const recovery = page.getByRole('button', { name: `Open ${destination}`, exact: true });
  if (await recovery.isVisible()) { await recovery.click(); return; }
  const header = page.getByRole('button', { name: `Switch to ${destination}`, exact: true });
  if (await header.isVisible()) { await header.click(); return; }
  const dock = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
  await dock.locator(destination === 'Reading' ? '[data-dock-switcher]' : '[data-tab="today"]').click();
}

/** Frame-sampling tests need the action in the same browser evaluation. */
export async function installFeatureNavigation(page) {
  await page.addInitScript(() => {
    window.__switchFeature = async destination => {
      const panel = document.querySelector('.crate-feature-panel[data-active="true"]');
      const header = panel.querySelector('.pwa-feature-switch-button');
      if (header?.getClientRects().length) { header.click(); return; }
      const next = destination ?? (panel.dataset.crateSection === 'reading' ? 'Reminders' : 'Reading');
      const button = panel.querySelector(next === 'Reading' ? '[data-dock-switcher]' : '.pwa-dock [data-tab="today"]');
      // Match keyboard activation: the dock clears cancelled pointer gestures
      // on Enter. A bare programmatic click can be suppressed after window blur.
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      button.click();
    };
  });
}
