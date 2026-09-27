import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compileString } from 'sass';
import { chromium, webkit, expect } from '@playwright/test';

const css = compileString(`
  @use "src/ui/shared/styles/controls";
  @use "src/reminders/ui/shared/styles/pickers";
  .crate-reminders-ui { @include controls.styles; @include pickers.styles; }
`, { loadPaths: [process.cwd()] }).css;
const { outputFiles } = await build({
  stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Button } from './src/ui/shared/Button';
    import { ToggleButton } from './src/ui/shared/ToggleButton';
    import { ShadowDOMNativeMotionButton } from './src/reminders/components/ShadowDOMNativeMotionButton';
    import { PickerFieldRow } from './src/reminders/ui/reminder-modal/PickerFieldRow';
    function Fixture() {
      const [selected, setSelected] = useState(false);
      const [clicks, setClicks] = useState(0);
      return <div className="crate-reminders-ui reminder-picker">
        <Button variant="outline" onClick={() => setClicks(n => n + 1)}>Action</Button>
        <ShadowDOMNativeMotionButton className="crate-action-button" onClick={() => setClicks(n => n + 1)}>Motion action</ShadowDOMNativeMotionButton>
        <ToggleButton variant="outline" pressed={selected} onPressedChange={setSelected}>Choice</ToggleButton>
        <Button variant="outline" disabled>Disabled</Button>
        <PickerFieldRow label="Native field" asLabel><input aria-label="Native field" /></PickerFieldRow>
        <output aria-label="Activations">{clicks}</output>
      </div>;
    }
    window.mount = shadow => {
      const host = document.getElementById('host');
      const target = shadow ? host.attachShadow({mode:'open'}) : host;
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(css + '\n.crate-reminders-ui { --crate-action-border: #888; --crate-action-text: #222; --crate-control-active-bg: rgb(100, 120, 140); --crate-control-hover-bg: rgb(220, 230, 240); --crate-motion-duration-fast: 0ms; --crate-motion-easing: ease; } button { min-width: 100px; min-height: 44px; }')};
      const container = document.createElement('div'); target.append(style, container);
      createRoot(container).render(<Fixture />);
    };
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
});
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    for (const shadow of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<div id="host"></div>');
      await page.addScriptTag({ content: outputFiles[0].text });
      await page.evaluate(shadow => window.mount(shadow), shadow);
      for (const name of ['Action', 'Motion action']) {
        const control = page.getByRole('button', { name, exact: true });
        await expect(control).toBeVisible();
        const resting = await control.evaluate(element => getComputedStyle(element).backgroundColor);
        await control.hover();
        await expect(control).toHaveCSS('background-color', resting);
        await page.mouse.down();
        await expect(control).toHaveCSS('background-color', 'rgb(100, 120, 140)');
        await control.dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true });
        await expect(control).toHaveCSS('background-color', resting);
        await page.mouse.up();
        // Moving into a scroll gesture clears feedback before release.
        await control.hover(); await page.mouse.down();
        const box = await control.boundingBox();
        await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
        await expect(control).toHaveCSS('background-color', resting);
        await page.mouse.up();
        // A release elsewhere still clears a source that has become inert.
        await control.hover(); await page.mouse.down();
        await control.evaluate(element => { element.inert = true; });
        await page.mouse.move(380, 800); await page.mouse.up();
        await control.evaluate(element => { element.inert = false; });
        await expect(control).toHaveCSS('background-color', resting);
        await control.focus(); await page.keyboard.down(' ');
        await expect(control).toHaveCSS('background-color', 'rgb(100, 120, 140)');
        await page.keyboard.up(' ');
        await expect(control).toHaveCSS('background-color', resting);
        await control.hover(); await page.mouse.down();
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expect(control).toHaveCSS('background-color', resting);
        await page.mouse.up();
      }
      const toggle = page.getByRole('button', { name: 'Choice', exact: true });
      await toggle.tap();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toHaveAttribute('data-pressed', ''); // Base UI's persistent choice state.
      await expect(toggle).not.toHaveAttribute('data-press-active', '');
      await toggle.tap(); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const field = page.getByRole('textbox', { name: 'Native field' });
      await field.tap(); await field.fill('Still editable'); await expect(field).toBeFocused();
      await expect(page.locator('.picker-control-row')).not.toHaveAttribute('data-press-active', '');
      const disabled = page.getByRole('button', { name: 'Disabled', exact: true });
      await disabled.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
      await expect(disabled).not.toHaveAttribute('data-press-active', '');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`${engine.name()}: shared press release, cancel, scroll, inert, keyboard, blur, selection, and native fields pass in document and Shadow DOM`);
  } finally { await browser.close(); }
}
