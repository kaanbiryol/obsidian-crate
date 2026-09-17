import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
for (const browserType of [chromium, webkit]) {
  const { server } = await listenPwaPreviewServer({ port: 0, assets });
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).tap();
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await expect(page.locator('.reminder-action-chips')).not.toHaveAttribute('inert');
    await title.fill('Read [docs](https://example.com) ');
    await expect(title.locator('a')).toHaveText('docs');
    // Start autocomplete with keyboard input after the initial link is rendered.
    await title.press('ControlOrMeta+ArrowRight');
    await page.keyboard.type('#Wo');
    const suggestion = page.getByRole('option', { name: 'Work', exact: true });
    await expect(suggestion).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(suggestion).toBeHidden();
    await expect(title.locator('.rich-text-chip-project')).toHaveText('#Work');
    // Wait for the actual caret, including the original editor's deferred restore.
    await expect.poll(() => title.evaluate(element => {
      const selection = document.getSelection();
      if (!selection?.focusNode || !element.contains(selection.focusNode)) return -1;
      const prefix = document.createRange();
      prefix.setStart(element, 0); prefix.setEnd(selection.focusNode, selection.focusOffset);
      return prefix.toString().length;
    })).toBe('Read docs #Work '.length);
    await page.keyboard.type('then');
    await expect(title).toHaveText('Read docs #Work then');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(title).not.toHaveText('Read docs #Work then');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(title).toHaveText('Read docs #Work then');

    // Plain-text paste must commit only the last project/priority and preserve links.
    await title.press('ControlOrMeta+a');
    await title.evaluate(element => {
      const data = new DataTransfer();
      data.setData('text/plain', 'Read [docs](https://example.com) #Personal #Work ! !');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(title).toHaveText('Read docs #Work !');
    await expect(title.locator('a')).toHaveAttribute('href', 'https://example.com');
    const requestPromise = page.waitForRequest(request => request.url().endsWith('/reminders/update') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Save reminder', exact: true }).tap();
    const payload = (await requestPromise).postDataJSON();
    assert.equal(payload.content, 'Read [docs](https://example.com)');
    assert.equal(payload.project, 'Work');
    assert.equal(payload.priority, 1);
    await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeHidden();
    // A reload must hydrate exact Markdown from the durable draft, not DOM text.
    await page.locator('[data-action="open-create-modal"]').tap();
    await title.fill('');
    await expect(page.getByRole('button', { name: 'Add reminder', exact: true })).toBeDisabled();
    const draftTitle = 'Draft 👩🏽‍💻 [reference](https://example.com/draft)';
    const draftDescription = 'First line\n日本語 & <script>literal text</script>';
    await title.fill(draftTitle);
    const description = page.getByRole('textbox', { name: 'Reminder description', exact: true });
    await description.fill(draftDescription);
    await expect.poll(() => page.evaluate(() => {
      const saved = sessionStorage.getItem('crate-reminder-draft:Reminders:new');
      return saved ? JSON.parse(saved).draft : null;
    })).toMatchObject({ content: draftTitle, description: draftDescription });
    await page.reload();
    await page.locator('[data-action="open-create-modal"]').tap();
    await expect(title).toHaveText('Draft 👩🏽‍💻 reference');
    await expect(title.locator('a')).toHaveAttribute('href', 'https://example.com/draft');
    await expect(description).toHaveValue(draftDescription);
    // Mounting a recovered draft must not import the previous reminder's history.
    await title.focus();
    await title.press('ControlOrMeta+z');
    await expect(title).toHaveText('Draft 👩🏽‍💻 reference');
    const createPromise = page.waitForRequest(request => request.url().endsWith('/reminders/create') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Add reminder', exact: true }).tap();
    const created = (await createPromise).postDataJSON();
    assert.equal(created.content, draftTitle);
    assert.equal(created.description, draftDescription);
    await expect(title).toBeHidden();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:Reminders:new'))).toBeNull();
    assert.deepEqual(errors, []);
    console.log(`${browserType.name()}: Editor autocomplete after links, caret, undo/redo, paste normalization, saved Markdown, draft reload, validation and history isolation passed`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
